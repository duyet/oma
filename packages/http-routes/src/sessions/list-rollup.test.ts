// Route-level coverage for the per-session rollup the Console dashboard's
// "Recent sessions" table renders: wall-clock duration, message /
// tool-call counts, and cumulative token usage.
//
// The point of these tests is the SOURCING rule as much as the values:
// every one of these fields is a column on the `sessions` row, refreshed
// by RuntimeAdapterImpl on each turn transition. The list handler must
// therefore surface them from the single page query it already runs — it
// must never fan out per row into the DO event log or usage_events. A
// regression that reintroduced per-row work would still produce correct
// numbers, so the guard here is that the values arrive on the plain list
// response with no router/live-status involvement at all (the fixture's
// router throws if touched).

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  createInMemorySessionService,
  ManualClock,
  type InMemorySessionRepo,
} from "@duyet/oma-sessions-store/test-fakes";
import type { SessionService } from "@duyet/oma-sessions-store";
import type { SessionStatus } from "@duyet/oma-shared";
import { buildSessionRoutes } from "./index";
import type { SessionRouter } from "@duyet/oma-session-runtime";
import type { RouteServices } from "../types";

const TENANT = "tenant-1";
const MINUTE = 60_000;
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

async function seed(
  repo: InMemorySessionRepo,
  s: {
    id: string;
    createdAt: number;
    title?: string;
    status?: SessionStatus;
    updatedAt?: number;
    messages?: number;
    toolCalls?: number;
    input?: number;
    output?: number;
    stopReason?: string;
  },
) {
  await repo.insertWithResources(
    {
      id: s.id,
      tenantId: TENANT,
      agentId: "agent_1",
      environmentId: "env_1",
      title: s.title ?? "",
      status: s.status ?? "idle",
      vaultIds: null,
      agentSnapshot: null,
      environmentSnapshot: null,
      metadata: null,
      createdAt: s.createdAt,
    },
    [],
  );
  if (s.updatedAt !== undefined) {
    await repo.update(TENANT, s.id, {
      updatedAt: s.updatedAt,
      ...(s.status !== undefined ? { status: s.status } : {}),
      ...(s.messages !== undefined ? { messageCount: s.messages } : {}),
      ...(s.toolCalls !== undefined ? { toolCallCount: s.toolCalls } : {}),
      ...(s.input !== undefined ? { inputTokens: s.input } : {}),
      ...(s.output !== undefined ? { outputTokens: s.output } : {}),
      ...(s.stopReason !== undefined ? { stopReason: s.stopReason } : {}),
    });
  }
}

function makeApp(service: SessionService) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route(
    "/v1/sessions",
    buildSessionRoutes({
      services: { sessions: service } as unknown as RouteServices,
      // Deliberately explosive: the list path must not consult the live
      // router at all. Per-row getFullStatus() is exactly the N+1 this
      // table is designed to avoid.
      router: {
        getFullStatus: async () => {
          throw new Error("list route must not call getFullStatus per row");
        },
      } as unknown as SessionRouter,
    }),
  );
  return app;
}

async function listRows(service: SessionService): Promise<Array<Record<string, any>>> {
  const res = await makeApp(service).request("/v1/sessions");
  expect(res.status).toBe(200);
  return ((await res.json()) as any).data;
}

describe("GET /v1/sessions — per-session rollup columns", () => {
  it("surfaces message_count / tool_call_count / stop_reason from the session row", async () => {
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    await seed(repo, {
      id: "s1",
      createdAt: BASE,
      updatedAt: BASE + MINUTE,
      messages: 7,
      toolCalls: 12,
      stopReason: "end_turn",
    });
    const [row] = await listRows(service);
    expect(row.message_count).toBe(7);
    expect(row.tool_call_count).toBe(12);
    expect(row.stop_reason).toBe("end_turn");
  });

  it("defaults the counts to 0 for a session that has not completed a turn", async () => {
    // Not "absent" — the dashboard distinguishes a real 0 from a missing
    // field, and an untouched session genuinely has zero recorded work.
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    await seed(repo, { id: "fresh", createdAt: BASE });
    const [row] = await listRows(service);
    expect(row.message_count).toBe(0);
    expect(row.tool_call_count).toBe(0);
  });

  it("returns the whole page's rollup in one request — no per-row fan-out", async () => {
    // The fixture's router throws on getFullStatus, so a passing multi-row
    // assertion here IS the no-N+1 proof: the handler served 3 enriched
    // rows without touching live status once.
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    for (let i = 0; i < 3; i++) {
      await seed(repo, {
        id: `s${i}`,
        createdAt: BASE + i * MINUTE,
        updatedAt: BASE + i * MINUTE + 30_000,
        messages: i + 1,
        input: 100 * (i + 1),
        output: 10 * (i + 1),
      });
    }
    const rows = await listRows(service);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.message_count).sort()).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.input_tokens).sort((a, b) => a - b)).toEqual([100, 200, 300]);
  });
});

// The end reference for a session's wall-clock span, in priority order:
// terminated_at, else `now` while a turn is in flight, else updated_at.
// (The terminated_at branch is unchanged and unreachable from here —
// terminated_at is written only by RuntimeAdapterImpl's raw SQL, never
// through the store service the in-memory fake implements. It is covered
// in packages/session-runtime/test/adapter.test.ts.)
describe("GET /v1/sessions — stats.duration_seconds end reference", () => {
  it("an idle session's clock stops at its last turn transition, not at now", async () => {
    // The regression this guards: using `now` for every non-terminated
    // session made a session that ran for 2 minutes back in January report
    // months of duration. BASE is far in the past relative to the real
    // wall clock the handler reads, so a `now`-based implementation would
    // return millions of seconds here, not 120.
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    await seed(repo, {
      id: "idle_old",
      createdAt: BASE,
      status: "idle",
      updatedAt: BASE + 2 * MINUTE,
    });
    const [row] = await listRows(service);
    expect(row.stats.duration_seconds).toBe(120);
  });

  it("a running session keeps accruing against the current time", async () => {
    // Inverse of the case above: a mid-turn session has no final duration
    // yet, so `now` is the only correct reference. Anchored to the real
    // clock because that is what the handler reads.
    const now = Date.now();
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(now) });
    await seed(repo, {
      id: "running",
      createdAt: now - 5 * MINUTE,
      status: "running",
      updatedAt: now - 5 * MINUTE,
    });
    const [row] = await listRows(service);
    // ~300s, with slack for test execution time.
    expect(row.stats.duration_seconds).toBeGreaterThanOrEqual(299);
    expect(row.stats.duration_seconds).toBeLessThan(320);
  });

  it("falls back to now for an idle session that has never been updated", async () => {
    // No updated_at means no recorded stop point; `now` is the only
    // reference left, and it must not collapse to 0.
    const now = Date.now();
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(now) });
    await seed(repo, { id: "never_touched", createdAt: now - 90_000, status: "idle" });
    const [row] = await listRows(service);
    expect(row.stats.duration_seconds).toBeGreaterThanOrEqual(89);
  });

  it("never reports a negative duration", async () => {
    // Clock skew between the row writer and the reader must degrade to 0,
    // not to a nonsense negative the UI would render as "-3s".
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    await seed(repo, {
      id: "skewed",
      createdAt: BASE,
      status: "idle",
      updatedAt: BASE - 10 * MINUTE,
    });
    const [row] = await listRows(service);
    expect(row.stats.duration_seconds).toBe(0);
  });
});

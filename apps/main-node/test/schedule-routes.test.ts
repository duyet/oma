// Covers the two schedule routes added for the Console Kanban board:
//   - PATCH /v1/agents/:agentId/schedules/:scheduleId  (partial update —
//     enabled/cron_expression/input/environment_id/timezone/max_sessions)
//   - GET   /v1/schedules                              (tenant-wide list)
// Both talk to the control-plane DB through the SqlClient port, so a
// recording fake is enough — no D1/sqlite needed.

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { SqlClient, SqlStatement } from "@duyet/oma-sql-client";
import { buildScheduleRoutes, buildTenantScheduleRoutes } from "@duyet/oma-http-routes";

interface Call {
  sql: string;
  binds: unknown[];
}

/** Fake SqlClient that records every prepare/bind and replays canned results
 *  in call order. `results[i]` feeds the i-th executed statement. */
function fakeDb(results: Array<{ rows?: unknown[]; changes?: number }>) {
  const calls: Call[] = [];
  let i = 0;
  const client: SqlClient = {
    prepare(sql: string): SqlStatement {
      const call: Call = { sql, binds: [] };
      const stmt: SqlStatement = {
        bind(...params: unknown[]) {
          call.binds = params;
          return stmt;
        },
        async run() {
          calls.push(call);
          const r = results[i++] ?? {};
          return { meta: { changes: r.changes ?? 0 } };
        },
        async first<T>() {
          calls.push(call);
          const r = results[i++] ?? {};
          return ((r.rows?.[0] ?? null) as T | null);
        },
        async all<T>() {
          calls.push(call);
          const r = results[i++] ?? {};
          return { results: (r.rows ?? []) as T[] };
        },
      };
      return stmt;
    },
    async batch() {
      return [];
    },
    async exec() {},
  };
  return { client, calls };
}

function appWith(routes: Hono<never>, path: string, tenantId = "tnt_1") {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenant_id" as never, tenantId as never);
    await next();
  });
  app.route(path, routes as never);
  return app;
}

const scheduleRow = (over: Record<string, unknown> = {}) => ({
  id: "sch_1",
  agent_id: "agent_1",
  tenant_id: "tnt_1",
  cron_expression: "0 9 * * 1",
  timezone: "UTC",
  next_run_at: "2026-08-03T09:00:00.000Z",
  enabled: 1,
  created_at: "2026-08-01T00:00:00.000Z",
  ...over,
});

describe("PATCH /agents/:agentId/schedules/:scheduleId", () => {
  it("disables a schedule and returns the updated row", async () => {
    // call order: SELECT existing → UPDATE → SELECT final
    const { client, calls } = fakeDb([
      { rows: [scheduleRow()] },
      { changes: 1 },
      { rows: [scheduleRow({ enabled: 0 })] },
    ]);
    const app = appWith(buildScheduleRoutes({ db: client }) as never, "/v1/agents");

    const res = await app.request("/v1/agents/agent_1/schedules/sch_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "sch_1", enabled: 0 });
    // enabled is persisted as 0/1 and scoped by tenant, never by id alone.
    expect(calls[1].sql).toContain("UPDATE agent_schedules SET enabled");
    expect(calls[1].sql).toContain("tenant_id = ?");
    expect(calls[1].binds[0]).toBe(0);
    expect(calls[1].binds).toContain("tnt_1");
  });

  it("re-enables a schedule (enabled: true → 1)", async () => {
    const { client, calls } = fakeDb([
      { rows: [scheduleRow()] },
      { changes: 1 },
      { rows: [scheduleRow()] },
    ]);
    const app = appWith(buildScheduleRoutes({ db: client }) as never, "/v1/agents");

    const res = await app.request("/v1/agents/agent_1/schedules/sch_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });

    expect(res.status).toBe(200);
    expect(calls[1].binds[0]).toBe(1);
  });

  it("404s when the schedule belongs to another tenant (no row found)", async () => {
    const { client } = fakeDb([{ rows: [] }]);
    const app = appWith(buildScheduleRoutes({ db: client }) as never, "/v1/agents");

    const res = await app.request("/v1/agents/agent_1/schedules/sch_other", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(res.status).toBe(404);
  });

  it("400s on an empty body — at least one field is required", async () => {
    const { client, calls } = fakeDb([]);
    const app = appWith(buildScheduleRoutes({ db: client }) as never, "/v1/agents");

    const res = await app.request("/v1/agents/agent_1/schedules/sch_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("recomputes next_run_at when cron_expression is patched", async () => {
    const { client, calls } = fakeDb([
      { rows: [scheduleRow({ cron_expression: "0 9 * * 1", timezone: "UTC" })] },
      { changes: 1 },
      { rows: [scheduleRow({ cron_expression: "0 10 * * 2" })] },
    ]);
    const app = appWith(buildScheduleRoutes({ db: client }) as never, "/v1/agents");

    const res = await app.request("/v1/agents/agent_1/schedules/sch_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cron_expression: "0 10 * * 2" }),
    });

    expect(res.status).toBe(200);
    expect(calls[1].sql).toContain("cron_expression = ?");
    expect(calls[1].sql).toContain("next_run_at = ?");
    const nextRunAtBind = calls[1].binds[calls[1].binds.indexOf("0 10 * * 2") + 1];
    expect(typeof nextRunAtBind).toBe("string");
  });

  it("patching input only leaves next_run_at untouched", async () => {
    const { client, calls } = fakeDb([
      { rows: [scheduleRow()] },
      { changes: 1 },
      { rows: [scheduleRow({ input: "new prompt" })] },
    ]);
    const app = appWith(buildScheduleRoutes({ db: client }) as never, "/v1/agents");

    const res = await app.request("/v1/agents/agent_1/schedules/sch_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: "new prompt" }),
    });

    expect(res.status).toBe(200);
    expect(calls[1].sql).toContain("input = ?");
    expect(calls[1].sql).not.toContain("next_run_at");
    expect(calls[1].sql).not.toContain("cron_expression");
  });

  it("recomputes next_run_at when only timezone is patched", async () => {
    const { client, calls } = fakeDb([
      { rows: [scheduleRow({ cron_expression: "0 9 * * 1", timezone: "UTC" })] },
      { changes: 1 },
      { rows: [scheduleRow({ timezone: "America/New_York" })] },
    ]);
    const app = appWith(buildScheduleRoutes({ db: client }) as never, "/v1/agents");

    const res = await app.request("/v1/agents/agent_1/schedules/sch_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timezone: "America/New_York" }),
    });

    expect(res.status).toBe(200);
    expect(calls[1].sql).toContain("timezone = ?");
    expect(calls[1].sql).toContain("next_run_at = ?");
  });

  it("a syntactically-valid but unparseable cron patch resolves next_run_at to null", async () => {
    // 5 fields (passes the schema regex) but an out-of-range weekday, so
    // croner throws internally and computeNextRunWith falls back to null —
    // same "never fires" contract as create.
    const { client, calls } = fakeDb([
      { rows: [scheduleRow()] },
      { changes: 1 },
      { rows: [scheduleRow({ cron_expression: "* * * * 8", next_run_at: null })] },
    ]);
    const app = appWith(buildScheduleRoutes({ db: client }) as never, "/v1/agents");

    const res = await app.request("/v1/agents/agent_1/schedules/sch_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cron_expression: "* * * * 8" }),
    });

    expect(res.status).toBe(200);
    expect(calls[1].sql).toContain("next_run_at = ?");
    const idx = calls[1].binds.indexOf("* * * * 8");
    expect(calls[1].binds[idx + 1]).toBeNull();
  });
});

describe("GET /schedules (tenant-wide)", () => {
  it("lists the tenant's schedules ordered (created_at, id) DESC", async () => {
    const { client, calls } = fakeDb([{ rows: [scheduleRow(), scheduleRow({ id: "sch_2" })] }]);
    const app = appWith(buildTenantScheduleRoutes({ db: client }) as never, "/v1/schedules");

    const res = await app.request("/v1/schedules");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; next_cursor?: string };
    expect(body.data).toHaveLength(2);
    // Only one page's worth of rows came back → no cursor to follow.
    expect(body.next_cursor).toBeUndefined();
    expect(calls[0].sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(calls[0].binds[0]).toBe("tnt_1");
  });

  it("emits next_cursor when more rows exist than the page limit", async () => {
    // limit=1 → the route fetches limit+1 to detect the overflow.
    const { client, calls } = fakeDb([
      { rows: [scheduleRow(), scheduleRow({ id: "sch_2" })] },
    ]);
    const app = appWith(buildTenantScheduleRoutes({ db: client }) as never, "/v1/schedules");

    const res = await app.request("/v1/schedules?limit=1");
    const body = (await res.json()) as { data: unknown[]; next_cursor?: string };
    expect(body.data).toHaveLength(1);
    expect(body.next_cursor).toBeTruthy();
    expect(calls[0].binds[calls[0].binds.length - 1]).toBe(2);
  });

  it("scopes to one agent when agent_id is passed", async () => {
    const { client, calls } = fakeDb([{ rows: [] }]);
    const app = appWith(buildTenantScheduleRoutes({ db: client }) as never, "/v1/schedules");

    await app.request("/v1/schedules?agent_id=agent_9");
    expect(calls[0].sql).toContain("agent_id = ?");
    expect(calls[0].binds).toContain("agent_9");
  });

  it("silently restarts from page 1 on a corrupt cursor rather than erroring", async () => {
    const { client, calls } = fakeDb([{ rows: [] }]);
    const app = appWith(buildTenantScheduleRoutes({ db: client }) as never, "/v1/schedules");

    const res = await app.request("/v1/schedules?cursor=not-a-cursor");
    expect(res.status).toBe(200);
    expect(calls[0].sql).not.toContain("created_at < ?");
  });
});

const runRow = (over: Record<string, unknown> = {}) => ({
  id: "srun_1",
  schedule_id: "sch_1",
  tenant_id: "tnt_1",
  agent_id: "agent_1",
  session_id: "sess_1",
  status: "ok",
  error: null,
  summary: null,
  started_at: "2026-08-01T00:00:00.000Z",
  created_at: "2026-08-01T00:00:00.000Z",
  ...over,
});

describe("GET /agents/:agentId/schedules/:scheduleId/runs", () => {
  it("returns run history newest-first, scoped by tenant and schedule", async () => {
    const { client, calls } = fakeDb([
      { rows: [runRow({ id: "srun_2" }), runRow({ id: "srun_1" })] },
    ]);
    const app = appWith(buildScheduleRoutes({ db: client }) as never, "/v1/agents");

    const res = await app.request("/v1/agents/agent_1/schedules/sch_1/runs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[]; next_cursor?: string };
    expect(body.data).toHaveLength(2);
    expect(body.next_cursor).toBeUndefined();
    expect(calls[0].sql).toContain("FROM agent_schedule_runs");
    expect(calls[0].sql).toContain("ORDER BY created_at DESC, id DESC");
    expect(calls[0].binds).toEqual(["sch_1", "tnt_1", 26]);
  });

  it("paginates with a cursor when more rows exist than the page limit", async () => {
    const { client, calls } = fakeDb([{ rows: [runRow({ id: "srun_2" }), runRow({ id: "srun_1" })] }]);
    const app = appWith(buildScheduleRoutes({ db: client }) as never, "/v1/agents");

    const res = await app.request("/v1/agents/agent_1/schedules/sch_1/runs?limit=1");
    const body = (await res.json()) as { data: unknown[]; next_cursor?: string };
    expect(body.data).toHaveLength(1);
    expect(body.next_cursor).toBeTruthy();
    expect(calls[0].binds[calls[0].binds.length - 1]).toBe(2);
  });

  it("returns an empty page for another tenant's schedule (never leaks rows)", async () => {
    const { client, calls } = fakeDb([{ rows: [] }]);
    const app = appWith(buildScheduleRoutes({ db: client }) as never, "/v1/agents", "tnt_other");

    const res = await app.request("/v1/agents/agent_1/schedules/sch_1/runs");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: unknown[] };
    expect(body.data).toHaveLength(0);
    expect(calls[0].binds).toContain("tnt_other");
  });
});

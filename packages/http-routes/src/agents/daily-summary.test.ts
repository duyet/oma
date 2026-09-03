import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { SqlClient, SqlStatement } from "@duyet/oma-sql-client";
import {
  buildDailySummary,
  buildDailySummaryRoutes,
  parseDailySummaryDays,
  windowStartIso,
  type AgentDailySummary,
  type ScheduleRunRaw,
  type UsageEventRaw,
} from "./daily-summary";

interface Call {
  sql: string;
  binds: unknown[];
}

interface RunRow extends ScheduleRunRaw {
  tenant_id: string;
  agent_id: string;
}

interface UsageRow extends UsageEventRaw {
  tenant_id: string;
  agent_id: string;
}

function emptyStmt(call: Call, execute: () => Promise<unknown>): SqlStatement {
  const stmt: SqlStatement = {
    bind(...params: unknown[]) {
      call.binds = params;
      return stmt;
    },
    async run() {
      await execute();
      return { meta: { changes: 0 } };
    },
    async first<T>() {
      await execute();
      return null as T | null;
    },
    async all<T>() {
      const rows = (await execute()) as T[];
      return { results: rows };
    },
  };
  return stmt;
}

function runsDb(rows: RunRow[]) {
  const calls: Call[] = [];
  const client: SqlClient = {
    prepare(sql: string): SqlStatement {
      const call: Call = { sql, binds: [] };
      return emptyStmt(call, async () => {
        calls.push(call);
        const [tenantId, agentId, since] = call.binds as [string, string, string];
        return rows.filter(
          (r) => r.tenant_id === tenantId && r.agent_id === agentId && r.created_at >= since,
        );
      });
    },
    async batch() {
      return [];
    },
    async exec() {},
  };
  return { client, calls };
}

function usageDb(rows: UsageRow[]) {
  const calls: Call[] = [];
  const client: SqlClient = {
    prepare(sql: string): SqlStatement {
      const call: Call = { sql, binds: [] };
      return emptyStmt(call, async () => {
        calls.push(call);
        const [tenantId, agentId, since] = call.binds as [string, string, number];
        return rows.filter(
          (r) => r.tenant_id === tenantId && r.agent_id === agentId && r.created_at >= since,
        );
      });
    },
    async batch() {
      return [];
    },
    async exec() {},
  };
  return { client, calls };
}

function makeApp(opts: {
  agent?: { id: string } | null;
  runs?: RunRow[];
  usage?: UsageRow[];
  tenantId?: string;
} = {}) {
  const tenantId = opts.tenantId ?? "tnt_1";
  const agent = opts.agent === undefined ? { id: "agent_1" } : opts.agent;
  const runs = runsDb(opts.runs ?? []);
  const usage = usageDb(opts.usage ?? []);
  const services = {
    agents: {
      get: async ({ tenantId: t, agentId }: { tenantId: string; agentId: string }) => {
        if (!agent) return null;
        if (t !== tenantId) return null;
        if (agent.id !== agentId) return null;
        return { id: agent.id };
      },
    },
    sql: usage.client,
  };
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", tenantId);
    await next();
  });
  app.route(
    "/v1/agents",
    buildDailySummaryRoutes({
      services: services as never,
      controlPlaneDb: runs.client,
    }),
  );
  return { app, runs, usage };
}

function runRow(over: Partial<RunRow> & Pick<RunRow, "id" | "created_at" | "status">): RunRow {
  return {
    schedule_id: "sch_1",
    session_id: null,
    error: null,
    started_at: over.created_at,
    tenant_id: "tnt_1",
    agent_id: "agent_1",
    ...over,
  };
}

function usageRow(over: Partial<UsageRow> & Pick<UsageRow, "kind" | "value" | "created_at">): UsageRow {
  return {
    session_id: "sess_1",
    tenant_id: "tnt_1",
    agent_id: "agent_1",
    ...over,
  };
}

async function getSummary(
  app: Hono<{ Variables: { tenant_id: string } }>,
  path: string,
): Promise<{ status: number; body: AgentDailySummary }> {
  const res = await app.request(path);
  return { status: res.status, body: (await res.json()) as AgentDailySummary };
}

describe("parseDailySummaryDays", () => {
  it("defaults to 7 when absent", () => {
    expect(parseDailySummaryDays(undefined)).toEqual({ ok: true, days: 7 });
  });

  it("accepts 1, 7, and 30", () => {
    expect(parseDailySummaryDays("1")).toEqual({ ok: true, days: 1 });
    expect(parseDailySummaryDays("7")).toEqual({ ok: true, days: 7 });
    expect(parseDailySummaryDays("30")).toEqual({ ok: true, days: 30 });
  });

  it("rejects anything else", () => {
    for (const raw of ["0", "2", "90", "foo", "", "7d"]) {
      const parsed = parseDailySummaryDays(raw);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error.code).toBe("invalid_days");
      expect(parsed.error.type).toBe("invalid_request_error");
    }
  });
});

describe("GET /v1/agents/:id/daily-summary", () => {
  it("defaults days=7", async () => {
    const { app, runs, usage } = makeApp();
    const { status, body } = await getSummary(app, "/v1/agents/agent_1/daily-summary");
    expect(status).toBe(200);
    expect(body.period.days).toBe(7);
    expect(body.daily).toHaveLength(7);
    expect(body.daily[0]?.date < body.daily[6]?.date).toBe(true);
    expect(body.daily[6]?.date).toBe(new Date().toISOString().slice(0, 10));
    expect(runs.calls[0]?.binds[0]).toBe("tnt_1");
    expect(runs.calls[0]?.binds[1]).toBe("agent_1");
    expect(usage.calls[0]?.binds[0]).toBe("tnt_1");
    expect(usage.calls[0]?.binds[1]).toBe("agent_1");
    expect(usage.calls[0]?.binds[2]).toBe(Date.parse(windowStartIso(7, Date.now())));
  });

  it("accepts days=1 and days=30", async () => {
    const { app: app1 } = makeApp();
    const one = await getSummary(app1, "/v1/agents/agent_1/daily-summary?days=1");
    expect(one.status).toBe(200);
    expect(one.body.period.days).toBe(1);
    expect(one.body.daily).toHaveLength(1);
    expect(one.body.daily[0]?.date).toBe(new Date().toISOString().slice(0, 10));

    const { app: app30 } = makeApp();
    const thirty = await getSummary(app30, "/v1/agents/agent_1/daily-summary?days=30");
    expect(thirty.status).toBe(200);
    expect(thirty.body.period.days).toBe(30);
    expect(thirty.body.daily).toHaveLength(30);
    expect(thirty.body.daily[0]?.date).toBe(windowStartIso(30, Date.now()).slice(0, 10));
  });

  it("returns 400 for invalid days", async () => {
    const { app, runs, usage } = makeApp();
    const res = await app.request("/v1/agents/agent_1/daily-summary?days=2");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: {
        type: "invalid_request_error",
        code: "invalid_days",
        message: "Invalid days '2'; expected 1, 7, or 30.",
      },
    });
    expect(runs.calls).toHaveLength(0);
    expect(usage.calls).toHaveLength(0);
  });

  it("returns 404 for an unknown agent", async () => {
    const { app, runs, usage } = makeApp({ agent: null });
    const res = await app.request("/v1/agents/agent_missing/daily-summary");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Agent not found" });
    expect(runs.calls).toHaveLength(0);
    expect(usage.calls).toHaveLength(0);
  });

  it("aggregates ok / error / skipped_concurrency", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const { app } = makeApp({
      runs: [
        runRow({ id: "srun_ok", status: "ok", created_at: `${today}T12:00:00.000Z`, session_id: "sess_ok" }),
        runRow({ id: "srun_err", status: "error", created_at: `${today}T11:00:00.000Z`, error: "boom" }),
        runRow({
          id: "srun_skip",
          status: "skipped_concurrency",
          created_at: `${today}T10:00:00.000Z`,
        }),
        runRow({ id: "srun_ok2", status: "ok", created_at: `${today}T09:00:00.000Z` }),
      ],
    });
    const { body } = await getSummary(app, "/v1/agents/agent_1/daily-summary?days=1");
    expect(body.runs).toEqual({
      total: 4,
      successful: 2,
      failed: 1,
      skipped_concurrency: 1,
    });
    const day = body.daily[0];
    expect(day?.runs).toBe(4);
    expect(day?.successful).toBe(2);
    expect(day?.failed).toBe(1);
    expect(day?.skipped_concurrency).toBe(1);
  });

  it("does not leak other tenant or other agent rows", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const ts = `${today}T12:00:00.000Z`;
    const ms = Date.parse(ts);
    const { app } = makeApp({
      runs: [
        runRow({ id: "srun_mine", status: "ok", created_at: ts, session_id: "sess_1" }),
        runRow({
          id: "srun_other_agent",
          status: "ok",
          created_at: ts,
          agent_id: "agent_other",
        }),
        runRow({
          id: "srun_other_tenant",
          status: "error",
          created_at: ts,
          tenant_id: "tnt_other",
        }),
      ],
      usage: [
        usageRow({ kind: "model_input_tokens", value: 100, created_at: ms }),
        usageRow({
          kind: "model_input_tokens",
          value: 9999,
          created_at: ms,
          agent_id: "agent_other",
        }),
        usageRow({
          kind: "model_input_tokens",
          value: 8888,
          created_at: ms,
          tenant_id: "tnt_other",
        }),
      ],
    });
    const { body } = await getSummary(app, "/v1/agents/agent_1/daily-summary?days=1");
    expect(body.runs.total).toBe(1);
    expect(body.recent_runs.map((r) => r.id)).toEqual(["srun_mine"]);
    expect(body.tokens.input).toBe(100);
  });

  it("fills daily[] with exactly `days` UTC dates, oldest first", async () => {
    const { app } = makeApp();
    const { body } = await getSummary(app, "/v1/agents/agent_1/daily-summary?days=7");
    expect(body.daily).toHaveLength(7);
    for (let i = 1; i < body.daily.length; i++) {
      const prev = Date.parse(`${body.daily[i - 1]!.date}T00:00:00.000Z`);
      const cur = Date.parse(`${body.daily[i]!.date}T00:00:00.000Z`);
      expect(cur - prev).toBe(24 * 3600 * 1000);
    }
    expect(body.daily[0]?.date).toBe(body.period.since.slice(0, 10));
    expect(body.daily.every((d) => d.runs === 0)).toBe(true);
  });

  it("computes model cost without sandbox or cache", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const todayMs = Date.parse(`${today}T12:00:00.000Z`);
    const { app } = makeApp({
      runs: [
        runRow({
          id: "srun_ok",
          status: "ok",
          created_at: `${today}T12:00:00.000Z`,
          session_id: "sess_1",
        }),
      ],
      usage: [
        usageRow({ kind: "model_input_tokens", value: 2_000_000, created_at: todayMs }),
        usageRow({ kind: "model_output_tokens", value: 1_000_000, created_at: todayMs }),
        usageRow({ kind: "model_cache_read_tokens", value: 5_000_000, created_at: todayMs }),
        usageRow({ kind: "model_cache_creation_tokens", value: 4_000_000, created_at: todayMs }),
        usageRow({ kind: "model_reasoning_tokens", value: 3_000_000, created_at: todayMs }),
        usageRow({ kind: "sandbox_active_seconds", value: 3600, created_at: todayMs }),
      ],
    });
    const { body } = await getSummary(app, "/v1/agents/agent_1/daily-summary?days=1");
    expect(body.estimated_cost_usd).toBe(2 * 3 + 1 * 15);
    expect(body.daily[0]?.estimated_cost_usd).toBe(21);
    expect(body.cache_hit_ratio).toBeCloseTo(5_000_000 / (5_000_000 + 2_000_000));
    expect(body.avg_session_duration_seconds).toBe(3600);
    expect(body.assumptions).toEqual({
      model_usd_per_mtok_in: 3,
      model_usd_per_mtok_out: 15,
    });
  });

  it("ignores usage_events from sessions that are not scheduled firings", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const ts = `${today}T12:00:00.000Z`;
    const ms = Date.parse(ts);
    const { app } = makeApp({
      runs: [runRow({ id: "srun_ok", status: "ok", created_at: ts, session_id: "sess_sched" })],
      usage: [
        usageRow({
          kind: "model_input_tokens",
          value: 100,
          created_at: ms,
          session_id: "sess_sched",
        }),
        usageRow({
          kind: "model_input_tokens",
          value: 9999,
          created_at: ms,
          session_id: "sess_interactive",
        }),
      ],
    });
    const { body } = await getSummary(app, "/v1/agents/agent_1/daily-summary?days=1");
    expect(body.tokens.input).toBe(100);
    expect(body.sessions).toBe(1);
  });

  it("returns top_outputs as []", async () => {
    const { app } = makeApp();
    const { body } = await getSummary(app, "/v1/agents/agent_1/daily-summary");
    expect(body.top_outputs).toEqual([]);
  });

  it("caps recent_runs at 20, newest first", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const runs: RunRow[] = [];
    for (let i = 0; i < 25; i++) {
      const created = `${today}T12:00:${String(i).padStart(2, "0")}.000Z`;
      runs.push(
        runRow({
          id: `srun_${String(i).padStart(2, "0")}`,
          status: "ok",
          created_at: created,
        }),
      );
    }
    const { app } = makeApp({ runs });
    const { body } = await getSummary(app, "/v1/agents/agent_1/daily-summary?days=1");
    expect(body.runs.total).toBe(25);
    expect(body.recent_runs).toHaveLength(20);
    expect(body.recent_runs[0]?.id).toBe("srun_24");
    expect(body.recent_runs[19]?.id).toBe("srun_05");
  });
});

describe("buildDailySummary", () => {
  it("returns 0 cache_hit_ratio and avg duration when denominators are 0", () => {
    const nowMs = Date.parse("2026-09-03T17:00:00.000Z");
    const summary = buildDailySummary({
      agentId: "agent_1",
      days: 1,
      nowMs,
      runs: [],
      usage: [],
    });
    expect(summary.cache_hit_ratio).toBe(0);
    expect(summary.avg_session_duration_seconds).toBe(0);
    expect(summary.sessions).toBe(0);
    expect(summary.estimated_cost_usd).toBe(0);
  });
});

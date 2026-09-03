import { Hono } from "hono";
import type { Context } from "hono";
import type { SqlClient } from "@duyet/oma-sql-client";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";
import type { ScheduleDbArg } from "../schedules";

interface Vars {
  Variables: { tenant_id: string };
}

export type DailySummaryDays = 1 | 7 | 30;

export type ScheduleRunStatus = "ok" | "error" | "skipped_concurrency";

export interface TokenTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  reasoning: number;
}

export interface DailySummaryDay {
  date: string;
  runs: number;
  successful: number;
  failed: number;
  skipped_concurrency: number;
  tokens: TokenTotals;
  estimated_cost_usd: number;
}

export interface DailySummaryRecentRun {
  id: string;
  schedule_id: string;
  session_id: string | null;
  status: string;
  error: string | null;
  started_at: string | null;
  created_at: string;
}

export interface AgentDailySummary {
  agent_id: string;
  period: { since: string; days: DailySummaryDays };
  runs: {
    total: number;
    successful: number;
    failed: number;
    skipped_concurrency: number;
  };
  tokens: TokenTotals;
  estimated_cost_usd: number;
  cache_hit_ratio: number;
  sessions: number;
  avg_session_duration_seconds: number;
  top_outputs: [];
  daily: DailySummaryDay[];
  recent_runs: DailySummaryRecentRun[];
  assumptions: {
    model_usd_per_mtok_in: number;
    model_usd_per_mtok_out: number;
  };
}

export interface DailySummaryRoutesDeps {
  services: RouteServicesArg;
  controlPlaneDb: ScheduleDbArg;
}

export interface DailySummaryDaysError {
  error: {
    type: "invalid_request_error";
    code: "invalid_days";
    message: string;
  };
}

export type ParseDailySummaryDaysResult =
  | { ok: true; days: DailySummaryDays }
  | { ok: false; error: DailySummaryDaysError["error"] };

export interface ScheduleRunRaw {
  id: string;
  schedule_id: string;
  session_id: string | null;
  status: string;
  error: string | null;
  started_at: string | null;
  created_at: string;
}

export interface UsageEventRaw {
  kind: string;
  value: number;
  session_id: string | null;
  created_at: number;
}

// Same rates as apps/main/src/routes/agent-stats.ts (Sonnet-class, documented not configurable).
const MODEL_USD_PER_MTOK_IN = 3;
const MODEL_USD_PER_MTOK_OUT = 15;

const RECENT_RUNS_LIMIT = 20;

function resolveDb(arg: ScheduleDbArg, c: Context): SqlClient {
  return typeof arg === "function" ? arg(c) : arg;
}

export function parseDailySummaryDays(raw: string | undefined): ParseDailySummaryDaysResult {
  if (raw === undefined) return { ok: true, days: 7 };
  if (raw === "1" || raw === "7" || raw === "30") {
    return { ok: true, days: Number(raw) as DailySummaryDays };
  }
  return {
    ok: false,
    error: {
      type: "invalid_request_error",
      code: "invalid_days",
      message: `Invalid days '${raw}'; expected 1, 7, or 30.`,
    },
  };
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function windowStartIso(days: DailySummaryDays, nowMs: number): string {
  const today = utcDay(nowMs);
  const start = new Date(`${today}T00:00:00.000Z`);
  start.setUTCDate(start.getUTCDate() - (days - 1));
  return start.toISOString();
}

function fillUtcDates(days: DailySummaryDays, nowMs: number): string[] {
  const today = utcDay(nowMs);
  const dates: string[] = [];
  const cursor = new Date(`${today}T00:00:00.000Z`);
  cursor.setUTCDate(cursor.getUTCDate() - (days - 1));
  for (let i = 0; i < days; i++) {
    dates.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return dates;
}

function emptyTokens(): TokenTotals {
  return { input: 0, output: 0, cache_read: 0, cache_creation: 0, reasoning: 0 };
}

function cloneTokens(t: TokenTotals): TokenTotals {
  return {
    input: t.input,
    output: t.output,
    cache_read: t.cache_read,
    cache_creation: t.cache_creation,
    reasoning: t.reasoning,
  };
}

function addTokenValue(tokens: TokenTotals, kind: string, value: number): void {
  switch (kind) {
    case "model_input_tokens":
      tokens.input += value;
      return;
    case "model_output_tokens":
      tokens.output += value;
      return;
    case "model_cache_read_tokens":
      tokens.cache_read += value;
      return;
    case "model_cache_creation_tokens":
      tokens.cache_creation += value;
      return;
    case "model_reasoning_tokens":
      tokens.reasoning += value;
      return;
    default:
      return;
  }
}

function modelCostUsd(tokens: TokenTotals): number {
  return (tokens.input / 1_000_000) * MODEL_USD_PER_MTOK_IN
    + (tokens.output / 1_000_000) * MODEL_USD_PER_MTOK_OUT;
}

function cacheHitRatio(tokens: TokenTotals): number {
  const denom = tokens.cache_read + tokens.input;
  return denom > 0 ? tokens.cache_read / denom : 0;
}

function asScheduleRunStatus(status: string): ScheduleRunStatus | null {
  switch (status) {
    case "ok":
    case "error":
    case "skipped_concurrency":
      return status;
    default:
      return null;
  }
}

function applyRunStatus(
  status: ScheduleRunStatus,
  day: DailySummaryDay,
  totals: AgentDailySummary["runs"],
): void {
  switch (status) {
    case "ok":
      day.successful += 1;
      totals.successful += 1;
      return;
    case "error":
      day.failed += 1;
      totals.failed += 1;
      return;
    case "skipped_concurrency":
      day.skipped_concurrency += 1;
      totals.skipped_concurrency += 1;
      return;
    default: {
      const _never: never = status;
      return _never;
    }
  }
}

function emptyDay(date: string): DailySummaryDay {
  return {
    date,
    runs: 0,
    successful: 0,
    failed: 0,
    skipped_concurrency: 0,
    tokens: emptyTokens(),
    estimated_cost_usd: 0,
  };
}

function runDate(createdAt: string): string | null {
  const ms = Date.parse(createdAt);
  if (!Number.isFinite(ms)) return null;
  return utcDay(ms);
}

export function buildDailySummary(input: {
  agentId: string;
  days: DailySummaryDays;
  nowMs: number;
  runs: readonly ScheduleRunRaw[];
  usage: readonly UsageEventRaw[];
}): AgentDailySummary {
  const since = windowStartIso(input.days, input.nowMs);
  const sinceMs = Date.parse(since);
  const dates = fillUtcDates(input.days, input.nowMs);
  const dateSet = new Set(dates);
  const byDate = new Map<string, DailySummaryDay>();
  for (const date of dates) byDate.set(date, emptyDay(date));

  const totals: AgentDailySummary["runs"] = {
    total: 0,
    successful: 0,
    failed: 0,
    skipped_concurrency: 0,
  };
  const tokens = emptyTokens();
  const sessionIds = new Set<string>();
  let sandboxSeconds = 0;

  const inWindowRuns: ScheduleRunRaw[] = [];
  const scheduledSessionIds = new Set<string>();
  for (const run of input.runs) {
    const date = runDate(run.created_at);
    if (!date || !dateSet.has(date)) continue;
    inWindowRuns.push(run);
    if (run.session_id) scheduledSessionIds.add(run.session_id);
    const day = byDate.get(date);
    if (!day) continue;
    day.runs += 1;
    totals.total += 1;
    const status = asScheduleRunStatus(run.status);
    if (status) applyRunStatus(status, day, totals);
  }

  for (const row of input.usage) {
    if (row.created_at < sinceMs) continue;
    // Interactive sessions belong on Observability; this tab is firings only.
    if (!row.session_id || !scheduledSessionIds.has(row.session_id)) continue;
    const date = utcDay(row.created_at);
    if (!dateSet.has(date)) continue;
    const day = byDate.get(date);
    if (!day) continue;
    sessionIds.add(row.session_id);
    if (row.kind === "sandbox_active_seconds") {
      sandboxSeconds += row.value;
      continue;
    }
    addTokenValue(tokens, row.kind, row.value);
    addTokenValue(day.tokens, row.kind, row.value);
  }

  for (const day of byDate.values()) {
    day.estimated_cost_usd = modelCostUsd(day.tokens);
  }

  const recent = [...inWindowRuns].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    if (a.id !== b.id) return a.id < b.id ? 1 : -1;
    return 0;
  });

  const sessions = sessionIds.size;
  return {
    agent_id: input.agentId,
    period: { since, days: input.days },
    runs: totals,
    tokens: cloneTokens(tokens),
    estimated_cost_usd: modelCostUsd(tokens),
    cache_hit_ratio: cacheHitRatio(tokens),
    sessions,
    avg_session_duration_seconds: sessions > 0 ? sandboxSeconds / sessions : 0,
    top_outputs: [],
    daily: dates.map((date) => byDate.get(date) ?? emptyDay(date)),
    recent_runs: recent.slice(0, RECENT_RUNS_LIMIT).map((r) => ({
      id: r.id,
      schedule_id: r.schedule_id,
      session_id: r.session_id,
      status: r.status,
      error: r.error,
      started_at: r.started_at,
      created_at: r.created_at,
    })),
    assumptions: {
      model_usd_per_mtok_in: MODEL_USD_PER_MTOK_IN,
      model_usd_per_mtok_out: MODEL_USD_PER_MTOK_OUT,
    },
  };
}

export function buildDailySummaryRoutes(deps: DailySummaryRoutesDeps) {
  const app = new Hono<Vars>();

  app.get("/:id/daily-summary", async (c) => {
    const parsed = parseDailySummaryDays(c.req.query("days"));
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }

    const services = resolveServices(deps.services, c);
    const tenantId = c.get("tenant_id");
    const agentId = c.req.param("id");

    const agent = await services.agents.get({ tenantId, agentId });
    if (!agent) return c.json({ error: "Agent not found" }, 404);

    const nowMs = Date.now();
    const sinceIso = windowStartIso(parsed.days, nowMs);
    const sinceMs = Date.parse(sinceIso);
    const controlDb = resolveDb(deps.controlPlaneDb, c);
    const sql = services.sql;

    const [runRes, usageRes] = await Promise.all([
      controlDb
        .prepare(
          `SELECT id, schedule_id, session_id, status, error, started_at, created_at
             FROM agent_schedule_runs
            WHERE tenant_id = ? AND agent_id = ? AND created_at >= ?
            ORDER BY created_at DESC, id DESC`,
        )
        .bind(tenantId, agentId, sinceIso)
        .all<ScheduleRunRaw>(),
      sql
        .prepare(
          `SELECT kind, value, session_id, created_at
             FROM usage_events
            WHERE tenant_id = ? AND agent_id = ? AND created_at >= ?
              AND kind IN ('model_input_tokens', 'model_output_tokens',
                           'model_cache_read_tokens', 'model_cache_creation_tokens',
                           'model_reasoning_tokens', 'sandbox_active_seconds')`,
        )
        .bind(tenantId, agentId, sinceMs)
        .all<UsageEventRaw>(),
    ]);

    return c.json(
      buildDailySummary({
        agentId,
        days: parsed.days,
        nowMs,
        runs: runRes.results ?? [],
        usage: usageRes.results ?? [],
      }),
    );
  });

  return app;
}

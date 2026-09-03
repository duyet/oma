import type { AgentSchedule, ScheduleRun } from "./schedule-types";

/** Glance state for an agent's most recent work. Distinct from archived/active. */
export type AgentHealthKind = "running" | "idle_ok" | "last_errored" | "never_run";

export interface SessionLike {
  id: string;
  status?: string;
  created_at: string;
  updated_at?: string | null;
  stop_reason?: string | null;
  stats?: { duration_seconds?: number };
  agent?: { id?: string };
  agent_id?: string;
}

export interface AgentStatsLike {
  sessions: number;
  est_model_cost_usd: number;
}

export interface AgentAnalyticsLike {
  completed_sessions: number;
  error_count: number;
}

export interface AgentHealthInput {
  now: number;
  schedules: AgentSchedule[];
  scheduleRuns: ScheduleRun[];
  recentSessions: SessionLike[];
  runningSessions: SessionLike[];
  stats: AgentStatsLike | null;
  analytics: AgentAnalyticsLike | null;
}

export interface AgentHealth {
  kind: AgentHealthKind;
  lastRunAt: string | null;
  lastRunStatus: string | null;
  nextRunAt: string | null;
  nextRunPaused: boolean;
  hasSchedule: boolean;
  uptimeMs: number | null;
  successRate: { ok: number; total: number } | null;
  avgDurationSeconds: number | null;
  costPerRunUsd: number | null;
  currentSessionId: string | null;
}

export function sessionAgentId(session: SessionLike): string | undefined {
  return session.agent_id ?? session.agent?.id;
}

/** Dashboard Active-sessions card: one running session → that agent's Monitor tab. */
export function dashboardActiveSessionsHref(running: SessionLike[]): string {
  if (running.length !== 1) return "/sessions?status=running";
  const id = sessionAgentId(running[0]);
  if (!id) return "/sessions?status=running";
  return `/agents/${id}/monitor`;
}

function maxIso(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const v of values) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms) || ms < bestMs) continue;
    best = v;
    bestMs = ms;
  }
  return best;
}

function minIso(values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestMs = Number.POSITIVE_INFINITY;
  for (const v of values) {
    if (!v) continue;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms) || ms > bestMs) continue;
    best = v;
    bestMs = ms;
  }
  return best;
}

function isErrorStatus(status: string | null | undefined): boolean {
  return status === "error" || status === "skipped_concurrency";
}

function pickPrimarySchedule(schedules: AgentSchedule[]): AgentSchedule | null {
  if (schedules.length === 0) return null;
  const withRun = schedules.filter((s) => s.last_run_at);
  if (withRun.length === 0) return schedules[0] ?? null;
  let best = withRun[0]!;
  let bestMs = Date.parse(best.last_run_at!);
  for (const s of withRun.slice(1)) {
    const ms = Date.parse(s.last_run_at!);
    if (ms > bestMs) {
      best = s;
      bestMs = ms;
    }
  }
  return best;
}

export function pickPrimaryScheduleId(schedules: AgentSchedule[]): string | null {
  return pickPrimarySchedule(schedules)?.id ?? null;
}

function successRateFromRuns(runs: ScheduleRun[]): { ok: number; total: number } | null {
  if (runs.length === 0) return null;
  const window = runs.slice(0, 30);
  const ok = window.filter((r) => r.status === "ok").length;
  return { ok, total: window.length };
}

function successRateFromAnalytics(
  analytics: AgentAnalyticsLike | null,
): { ok: number; total: number } | null {
  if (!analytics || analytics.completed_sessions <= 0) return null;
  const ok = Math.max(0, analytics.completed_sessions - analytics.error_count);
  return { ok, total: analytics.completed_sessions };
}

function uptimeFromRuns(runs: ScheduleRun[], now: number): number | null {
  if (runs.length === 0) return null;
  const window = runs.slice(0, 30);
  const error = window.find((r) => isErrorStatus(r.status));
  if (error) {
    const ms = Date.parse(error.created_at);
    return Number.isFinite(ms) ? Math.max(0, now - ms) : null;
  }
  const oldest = window[window.length - 1];
  if (!oldest) return null;
  const ms = Date.parse(oldest.created_at);
  return Number.isFinite(ms) ? Math.max(0, now - ms) : null;
}

function avgDuration(sessions: SessionLike[]): number | null {
  const values: number[] = [];
  for (const s of sessions) {
    if (s.status === "running") continue;
    const d = s.stats?.duration_seconds;
    if (d == null || !Number.isFinite(d) || d < 0) continue;
    values.push(d);
  }
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function deriveAgentHealth(input: AgentHealthInput): AgentHealth {
  const {
    now,
    schedules,
    scheduleRuns,
    recentSessions,
    runningSessions,
    stats,
    analytics,
  } = input;

  const running = runningSessions[0] ?? null;
  const latestSession = recentSessions[0] ?? null;
  const primary = pickPrimarySchedule(schedules);
  const enabled = schedules.filter((s) => s.enabled);
  const nextRunAt = minIso(enabled.map((s) => s.next_run_at));
  const lastRunAt = maxIso([
    ...schedules.map((s) => s.last_run_at),
    latestSession?.created_at,
  ]);

  let kind: AgentHealthKind;
  if (running) {
    kind = "running";
  } else if (isErrorStatus(primary?.last_run_status)) {
    kind = "last_errored";
  } else if (lastRunAt) {
    kind = "idle_ok";
  } else {
    kind = "never_run";
  }

  const successRate =
    successRateFromRuns(scheduleRuns) ?? successRateFromAnalytics(analytics);

  const costPerRunUsd =
    stats && stats.sessions > 0 ? stats.est_model_cost_usd / stats.sessions : null;

  return {
    kind,
    lastRunAt,
    lastRunStatus: primary?.last_run_status ?? latestSession?.status ?? null,
    nextRunAt,
    nextRunPaused: schedules.length > 0 && (enabled.length === 0 || !nextRunAt),
    hasSchedule: schedules.length > 0,
    uptimeMs: uptimeFromRuns(scheduleRuns, now),
    successRate,
    avgDurationSeconds: avgDuration(recentSessions),
    costPerRunUsd,
    currentSessionId: running?.id ?? null,
  };
}

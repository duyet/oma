import { describe, expect, it } from "vitest";

import {
  dashboardActiveSessionsHref,
  deriveAgentHealth,
  pickPrimaryScheduleId,
  sessionAgentId,
  type SessionLike,
} from "./agent-health";
import type { AgentSchedule, ScheduleRun } from "./schedule-types";

const NOW = Date.parse("2026-09-03T18:00:00.000Z");

function schedule(partial: Partial<AgentSchedule> = {}): AgentSchedule {
  return {
    id: "sch_1",
    agent_id: "agent_1",
    cron_expression: "0 9 * * *",
    input: "digest",
    environment_id: "env_1",
    timezone: "UTC",
    next_run_at: "2026-09-04T09:00:00.000Z",
    last_run_at: "2026-09-03T09:00:00.000Z",
    last_run_status: "ok",
    max_sessions: 1,
    enabled: true,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-09-03T09:00:00.000Z",
    ...partial,
  };
}

function run(partial: Partial<ScheduleRun> & { id: string; created_at: string }): ScheduleRun {
  return {
    session_id: "sess_x",
    status: "ok",
    started_at: partial.created_at,
    ...partial,
  };
}

function session(partial: Partial<SessionLike> & { id: string }): SessionLike {
  return {
    created_at: "2026-09-03T09:00:00.000Z",
    status: "idle",
    ...partial,
  };
}

describe("sessionAgentId", () => {
  it("prefers agent_id then agent.id", () => {
    expect(sessionAgentId({ id: "s", created_at: "t", agent_id: "a1" })).toBe("a1");
    expect(sessionAgentId({ id: "s", created_at: "t", agent: { id: "a2" } })).toBe("a2");
  });
});

describe("dashboardActiveSessionsHref", () => {
  it("links to Monitor when exactly one running session has an agent id", () => {
    expect(
      dashboardActiveSessionsHref([session({ id: "sess_1", agent_id: "agent_9", status: "running" })]),
    ).toBe("/agents/agent_9/monitor");
  });
  it("falls back to the running sessions list otherwise", () => {
    expect(dashboardActiveSessionsHref([])).toBe("/sessions?status=running");
    expect(
      dashboardActiveSessionsHref([
        session({ id: "a", agent_id: "agent_1", status: "running" }),
        session({ id: "b", agent_id: "agent_2", status: "running" }),
      ]),
    ).toBe("/sessions?status=running");
    expect(dashboardActiveSessionsHref([session({ id: "s", status: "running" })])).toBe(
      "/sessions?status=running",
    );
  });
});

describe("pickPrimaryScheduleId", () => {
  it("picks the schedule with the most recent last_run_at", () => {
    expect(
      pickPrimaryScheduleId([
        schedule({ id: "old", last_run_at: "2026-09-01T00:00:00.000Z" }),
        schedule({ id: "new", last_run_at: "2026-09-03T00:00:00.000Z" }),
      ]),
    ).toBe("new");
  });
});

describe("deriveAgentHealth", () => {
  const base = {
    now: NOW,
    schedules: [] as AgentSchedule[],
    scheduleRuns: [] as ScheduleRun[],
    recentSessions: [] as SessionLike[],
    runningSessions: [] as SessionLike[],
    stats: null,
    analytics: null,
  };

  it("is never_run with no sessions or schedules", () => {
    const h = deriveAgentHealth(base);
    expect(h.kind).toBe("never_run");
    expect(h.currentSessionId).toBeNull();
    expect(h.successRate).toBeNull();
  });

  it("is running when a session is in flight", () => {
    const h = deriveAgentHealth({
      ...base,
      runningSessions: [session({ id: "sess_live", status: "running" })],
      schedules: [schedule({ last_run_status: "error" })],
    });
    expect(h.kind).toBe("running");
    expect(h.currentSessionId).toBe("sess_live");
  });

  it("is last_errored when the latest schedule run failed", () => {
    const h = deriveAgentHealth({
      ...base,
      schedules: [schedule({ last_run_status: "error" })],
    });
    expect(h.kind).toBe("last_errored");
  });

  it("is idle_ok after a successful schedule run", () => {
    const h = deriveAgentHealth({
      ...base,
      schedules: [schedule({ last_run_status: "ok" })],
    });
    expect(h.kind).toBe("idle_ok");
    expect(h.lastRunAt).toBe("2026-09-03T09:00:00.000Z");
    expect(h.nextRunAt).toBe("2026-09-04T09:00:00.000Z");
    expect(h.nextRunPaused).toBe(false);
  });

  it("marks next run paused when every schedule is disabled", () => {
    const h = deriveAgentHealth({
      ...base,
      schedules: [schedule({ enabled: false, next_run_at: "2026-09-04T09:00:00.000Z" })],
    });
    expect(h.nextRunPaused).toBe(true);
    expect(h.nextRunAt).toBeNull();
  });

  it("computes success rate and uptime from the last 30 schedule runs", () => {
    const runs: ScheduleRun[] = [
      run({ id: "r3", status: "ok", created_at: "2026-09-03T09:00:00.000Z" }),
      run({ id: "r2", status: "ok", created_at: "2026-09-02T09:00:00.000Z" }),
      run({ id: "r1", status: "error", created_at: "2026-09-01T09:00:00.000Z" }),
    ];
    const h = deriveAgentHealth({ ...base, scheduleRuns: runs });
    expect(h.successRate).toEqual({ ok: 2, total: 3 });
    expect(h.uptimeMs).toBe(NOW - Date.parse("2026-09-01T09:00:00.000Z"));
  });

  it("falls back to analytics when there are no schedule runs", () => {
    const h = deriveAgentHealth({
      ...base,
      analytics: { completed_sessions: 10, error_count: 1 },
    });
    expect(h.successRate).toEqual({ ok: 9, total: 10 });
  });

  it("averages completed session durations and cost per run", () => {
    const h = deriveAgentHealth({
      ...base,
      recentSessions: [
        session({ id: "a", status: "idle", stats: { duration_seconds: 40 } }),
        session({ id: "b", status: "idle", stats: { duration_seconds: 60 } }),
        session({ id: "c", status: "running", stats: { duration_seconds: 999 } }),
      ],
      stats: { sessions: 4, est_model_cost_usd: 0.08 },
    });
    expect(h.avgDurationSeconds).toBe(50);
    expect(h.costPerRunUsd).toBe(0.02);
  });
});

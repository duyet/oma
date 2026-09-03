import { useApiQuery } from "../../lib/useApiQuery";
import {
  formatRelative,
  formatRelativeSigned,
  formatSessionDuration,
  formatUsd,
} from "../../lib/format";
import { cn } from "@/lib/utils";
import type { AgentSchedule, ScheduleRun } from "./schedule-types";
import type { SessionRecord } from "../../types/session";
import {
  deriveAgentHealth,
  pickPrimaryScheduleId,
  type AgentAnalyticsLike,
  type AgentHealthKind,
  type AgentStatsLike,
} from "./agent-health";

const KIND_LABEL: Record<AgentHealthKind, string> = {
  running: "running",
  idle_ok: "idle",
  last_errored: "error",
  never_run: "never run",
};

const KIND_CLASS: Record<AgentHealthKind, string> = {
  running: "bg-info-subtle text-info",
  idle_ok: "bg-success-subtle text-success",
  last_errored: "bg-danger-subtle text-danger",
  never_run: "bg-muted text-muted-foreground",
};

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className="text-fg-subtle">{label}</span>
      <span className="text-fg">{value}</span>
    </span>
  );
}

export function AgentHealthStrip({
  agentId,
  now = Date.now(),
}: {
  agentId: string;
  now?: number;
}) {
  const schedulesQuery = useApiQuery<{ data: AgentSchedule[] }>(
    `/v1/agents/${agentId}/schedules`,
    undefined,
    { refetchInterval: 15_000 },
  );
  const runningQuery = useApiQuery<{ data: SessionRecord[] }>(
    "/v1/sessions",
    { agent_id: agentId, status: "running", limit: "5" },
    { refetchInterval: 15_000 },
  );
  const recentQuery = useApiQuery<{ data: SessionRecord[] }>(
    "/v1/sessions",
    { agent_id: agentId, limit: "20" },
    { refetchInterval: 15_000 },
  );
  const statsQuery = useApiQuery<AgentStatsLike>(`/v1/agents/${agentId}/stats`);
  const analyticsQuery = useApiQuery<AgentAnalyticsLike>(
    `/v1/agents/${agentId}/analytics`,
    { range: "30d" },
  );

  const schedules = schedulesQuery.data?.data ?? [];
  const primaryId = pickPrimaryScheduleId(schedules);
  const runsQuery = useApiQuery<{ data: ScheduleRun[] }>(
    primaryId ? `/v1/agents/${agentId}/schedules/${primaryId}/runs` : null,
    { limit: "30" },
  );

  const corePending =
    schedulesQuery.isLoading || runningQuery.isLoading || recentQuery.isLoading;

  const health = deriveAgentHealth({
    now,
    schedules,
    scheduleRuns: runsQuery.data?.data ?? [],
    recentSessions: recentQuery.data?.data ?? [],
    runningSessions: runningQuery.data?.data ?? [],
    stats: statsQuery.data ?? null,
    analytics: analyticsQuery.data ?? null,
  });

  if (corePending) {
    return (
      <div
        data-testid="agent-health-strip"
        className="mt-2 text-xs text-fg-subtle"
      >
        Loading health…
      </div>
    );
  }

  const lastRun = health.lastRunAt
    ? formatRelativeSigned(now - Date.parse(health.lastRunAt))
    : "—";
  const nextRun = health.nextRunPaused
    ? "paused"
    : health.nextRunAt
      ? formatRelativeSigned(now - Date.parse(health.nextRunAt))
      : health.hasSchedule
        ? "—"
        : "no schedule";
  const uptime =
    health.uptimeMs != null ? formatRelative(health.uptimeMs).replace(/ ago$/, "") : "—";
  const success =
    health.successRate && health.successRate.total > 0
      ? `${Math.round((health.successRate.ok / health.successRate.total) * 100)}%`
      : "—";
  const avg =
    health.avgDurationSeconds != null
      ? formatSessionDuration(health.avgDurationSeconds)
      : "—";
  const cost =
    health.costPerRunUsd != null ? `${formatUsd(health.costPerRunUsd)}/run` : "—";

  return (
    <div
      data-testid="agent-health-strip"
      className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted"
    >
      <span
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
          KIND_CLASS[health.kind],
        )}
      >
        {health.kind === "running" ? (
          <span className="h-1.5 w-1.5 rounded-full bg-info animate-pulse" aria-hidden />
        ) : (
          <span
            className={cn(
              "h-1.5 w-1.5 rounded-full",
              health.kind === "idle_ok"
                ? "bg-success"
                : health.kind === "last_errored"
                  ? "bg-danger"
                  : "bg-muted-foreground/50",
            )}
            aria-hidden
          />
        )}
        {KIND_LABEL[health.kind]}
      </span>
      <Metric label="Last run" value={lastRun} />
      <span className="text-fg-subtle" aria-hidden>
        ·
      </span>
      <Metric label="Next run" value={nextRun} />
      <span className="text-fg-subtle" aria-hidden>
        ·
      </span>
      <Metric label="Uptime" value={uptime} />
      <span className="text-fg-subtle" aria-hidden>
        ·
      </span>
      <Metric label="Success" value={success} />
      <span className="text-fg-subtle" aria-hidden>
        ·
      </span>
      <Metric label="Avg duration" value={avg} />
      <span className="text-fg-subtle" aria-hidden>
        ·
      </span>
      <Metric label="Cost" value={cost} />
    </div>
  );
}

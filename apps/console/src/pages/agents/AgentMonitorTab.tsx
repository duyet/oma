import { useEffect, useState } from "react";
import { Link } from "react-router";

import { useApiQuery } from "../../lib/useApiQuery";
import { useSessionEvents } from "../../lib/useSessionEvents";
import { formatRelative, formatRelativeSigned, formatSessionDuration } from "../../lib/format";
import { ModelName } from "../../lib/model-provider";
import { EmptyState } from "../../components/EmptyState";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAgentHub } from "../AgentDetail";
import type { SessionRecord } from "../../types/session";
import { deriveHeartbeatView } from "./agent-heartbeat";

function modelHandle(model: string | { id: string } | undefined): string | undefined {
  if (!model) return undefined;
  return typeof model === "string" ? model : model.id;
}

function StepBar({ step, total }: { step: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (step / total) * 100)) : 0;
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between text-xs text-fg-muted mb-1">
        <span>
          Step {step}/{total}
        </span>
        <span>{Math.round(pct)}%</span>
      </div>
      <div className="h-1.5 rounded-full bg-muted overflow-hidden">
        <div className="h-full bg-info rounded-full" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function AgentMonitorTab() {
  const { agent } = useAgentHub();
  const [now, setNow] = useState(() => Date.now());

  const runningQuery = useApiQuery<{ data: SessionRecord[] }>(
    "/v1/sessions",
    { agent_id: agent.id, status: "running", limit: "5" },
    { refetchInterval: 10_000 },
  );
  const recentQuery = useApiQuery<{ data: SessionRecord[] }>(
    "/v1/sessions",
    { agent_id: agent.id, limit: "5" },
    { refetchInterval: 15_000 },
  );

  const running = runningQuery.data?.data[0] ?? null;
  const latest = running ?? recentQuery.data?.data[0] ?? null;
  const live = !!running;
  const { events, isLoading } = useSessionEvents(latest?.id ?? null, live);
  const heartbeat = deriveHeartbeatView(events, now);

  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live]);

  const duration =
    latest?.stats?.duration_seconds != null
      ? formatSessionDuration(latest.stats.duration_seconds)
      : latest
        ? formatSessionDuration((now - Date.parse(latest.created_at)) / 1000)
        : "—";

  if (!latest) {
    return (
      <div data-testid="agent-monitor" className="pb-4">
        <EmptyState
          kind="session"
          title="No runs yet"
          body="Start a session or wait for a schedule to fire. Heartbeats from agent.status will show up here."
        />
      </div>
    );
  }

  return (
    <div data-testid="agent-monitor" className="pb-4">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-xs uppercase tracking-wider text-fg-subtle font-medium mb-3">
            Current run
          </h2>
          <div className="flex items-center gap-2 text-sm">
            <span
              className={cn(
                "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium",
                live
                  ? "bg-info-subtle text-info"
                  : heartbeat.latest && events.some((e) => e.type === "session.error")
                    ? "bg-danger-subtle text-danger"
                    : "bg-success-subtle text-success",
              )}
            >
              {live && <span className="h-1.5 w-1.5 rounded-full bg-info animate-pulse" aria-hidden />}
              {live ? "Running" : latest.status === "terminated" ? "Terminated" : "Idle"}
            </span>
            <span className="text-xs text-fg-muted">
              {formatRelativeSigned(now - Date.parse(latest.created_at))}
            </span>
          </div>
          <dl className="mt-3 space-y-1.5 text-sm">
            <div className="flex gap-2">
              <dt className="text-fg-subtle w-24 shrink-0">Session</dt>
              <dd className="font-mono text-xs text-fg truncate">{latest.id}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-fg-subtle w-24 shrink-0">Duration</dt>
              <dd className="text-fg">{duration}</dd>
            </div>
            <div className="flex gap-2 items-center">
              <dt className="text-fg-subtle w-24 shrink-0">Model</dt>
              <dd>
                <ModelName model={modelHandle(agent.model)} className="text-sm" />
              </dd>
            </div>
          </dl>
          {heartbeat.latest && (
            <p className="mt-3 text-sm text-fg">{heartbeat.latest.summary || "In progress"}</p>
          )}
          {heartbeat.progress && (
            <StepBar step={heartbeat.progress.step} total={heartbeat.progress.total} />
          )}
          {heartbeat.blockedOn && (
            <p
              data-testid="monitor-blocked"
              className="mt-2 text-sm text-warning"
            >
              Waiting for: {heartbeat.blockedOn}
            </p>
          )}
          {heartbeat.lagging && (
            <p data-testid="monitor-lag" className="mt-2 text-sm text-warning">
              Heartbeat lag: {formatRelative(heartbeat.lagMs ?? 0).replace(/ ago$/, "")}
            </p>
          )}
          {isLoading && !heartbeat.latest && (
            <p className="mt-3 text-xs text-fg-subtle">Loading heartbeats…</p>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="outline" size="sm" asChild>
              <Link to={`/sessions/${latest.id}`}>View session</Link>
            </Button>
          </div>
        </section>

        <section className="rounded-xl border border-border bg-card p-4">
          <h2 className="text-xs uppercase tracking-wider text-fg-subtle font-medium mb-3">
            Heartbeat log
          </h2>
          {heartbeat.entries.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No agent.status heartbeats on this run yet.
            </p>
          ) : (
            <ol className="space-y-2 max-h-80 overflow-y-auto">
              {heartbeat.entries.map((entry, i) => (
                <li
                  key={`${entry.ts ?? "x"}-${i}`}
                  className="flex gap-2 text-sm"
                >
                  <span className="text-xs text-fg-subtle tabular-nums w-14 shrink-0">
                    {entry.ts
                      ? new Date(entry.ts).toISOString().slice(11, 16)
                      : "—"}
                  </span>
                  <span className="min-w-0">
                    <span className="text-fg">
                      {entry.step != null
                        ? `Step ${entry.step}${entry.total_steps != null ? `/${entry.total_steps}` : ""}`
                        : entry.state}
                      {entry.summary ? `: ${entry.summary}` : ""}
                    </span>
                    {entry.lagged && (
                      <span className="ml-1 text-xs text-warning">lag</span>
                    )}
                  </span>
                </li>
              ))}
            </ol>
          )}

          <h2 className="text-xs uppercase tracking-wider text-fg-subtle font-medium mt-6 mb-2">
            Upgrade log
          </h2>
          <p className="text-sm text-fg-muted">
            Self-upgrade checks will appear here. The agent cannot change its
            own config yet; roll back from version history if an operator edit
            needs reversing.
          </p>
        </section>
      </div>
    </div>
  );
}

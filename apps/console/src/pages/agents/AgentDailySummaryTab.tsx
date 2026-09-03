import { useState } from "react";
import { Link } from "react-router";

import { useApiQuery } from "../../lib/useApiQuery";
import { EmptyState } from "../../components/EmptyState";
import { StatusPill } from "../../components/StatusPill";
import { scheduleStatusTone } from "./schedule-status";
import { cn } from "@/lib/utils";
import { formatCompact, formatRelative, formatUsd } from "../../lib/format";
import {
  DAILY_CHART_VIEW_W,
  dailyActivityBarWidth,
  dailyActivitySlot,
  dailyActivityTickIndices,
} from "../../lib/daily-activity-chart";
import { useAgentHub } from "../AgentDetail";
import type { AgentDailySummary, DailySummaryDays, TokenTotals } from "./daily-summary-types";

type PeriodChip = "1d" | "7d" | "30d";
const CHIPS: PeriodChip[] = ["1d", "7d", "30d"];

function chipToDays(chip: PeriodChip): DailySummaryDays {
  switch (chip) {
    case "1d":
      return 1;
    case "7d":
      return 7;
    case "30d":
      return 30;
    default: {
      const _never: never = chip;
      return _never;
    }
  }
}

function hasTokens(t: TokenTotals): boolean {
  return t.input > 0 || t.output > 0 || t.cache_read > 0 || t.cache_creation > 0 || t.reasoning > 0;
}

export function AgentDailySummaryTab() {
  const { agent } = useAgentHub();
  const [chip, setChip] = useState<PeriodChip>("7d");
  const days = chipToDays(chip);

  const { data, isLoading } = useApiQuery<AgentDailySummary>(
    `/v1/agents/${agent.id}/daily-summary`,
    { days: String(days) },
  );

  const isEmpty = !!data && data.runs.total === 0 && !hasTokens(data.tokens);

  return (
    <div className="pb-4 space-y-6">
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg-subtle">Period</span>
        <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-[3px]">
          {CHIPS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setChip(c)}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium transition-all",
                chip === c
                  ? "bg-background text-foreground shadow-sm"
                  : "text-foreground/60 hover:text-foreground",
              )}
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {isLoading && !data ? (
        <p className="text-sm text-fg-subtle">Loading daily summary…</p>
      ) : isEmpty || !data ? (
        <EmptyState
          title="No scheduled runs in this period"
          body="Once this agent's cron schedules fire, their run counts, tokens, and cost will appear here."
          kind="session"
          size="lg"
        />
      ) : (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 max-w-5xl">
            <StatCard
              label="Runs"
              value={formatCompact(data.runs.total)}
              hint={`${data.runs.successful} ok · ${data.runs.failed} failed · ${data.runs.skipped_concurrency} skipped`}
            />
            <StatCard
              label="Tokens"
              value={formatCompact(data.tokens.input + data.tokens.output)}
              hint={`${formatCompact(data.tokens.input)} in · ${formatCompact(data.tokens.output)} out · ${formatCompact(data.tokens.cache_read)} cache · ${formatCompact(data.tokens.reasoning)} reasoning`}
            />
            <StatCard label="Est. cost" value={formatUsd(data.estimated_cost_usd)} />
            <StatCard
              label="Cache hit"
              value={`${(data.cache_hit_ratio * 100).toFixed(0)}%`}
            />
          </div>

          <div className="border border-border rounded-lg bg-bg-surface/30 p-4 max-w-5xl">
            <h3 className="font-display text-base font-semibold mb-3">Scheduled runs</h3>
            <RunsChart data={data.daily} />
          </div>

          <RecentRunsTable runs={data.recent_runs} />
        </>
      )}
    </div>
  );
}

function StatCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="border border-border rounded-lg bg-bg-surface/30 px-4 py-3">
      <div className="text-xs text-fg-muted uppercase tracking-wider">{label}</div>
      <div className="text-lg font-semibold text-fg mt-0.5 tabular-nums">{value}</div>
      {hint && <div className="text-[11px] text-fg-subtle mt-0.5">{hint}</div>}
    </div>
  );
}

function RunsChart({ data }: { data: AgentDailySummary["daily"] }) {
  const n = data.length;
  if (n === 0) return <p className="text-sm text-fg-subtle">No data.</p>;

  const max = Math.max(1, ...data.map((d) => d.runs));
  const viewW = DAILY_CHART_VIEW_W;
  const slot = dailyActivitySlot(n, viewW);
  const barW = dailyActivityBarWidth(slot);
  const tickSet = new Set(dailyActivityTickIndices(n, slot));
  const rotate = slot < 28;
  const chartTop = 8;
  const chartH = 100;
  const baseline = chartTop + chartH;
  const labelH = rotate ? 36 : 22;
  const viewH = baseline + labelH;

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${viewW} ${viewH}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Scheduled runs"
      >
        <line
          x1={0}
          y1={baseline}
          x2={viewW}
          y2={baseline}
          stroke="var(--color-border)"
          strokeWidth={1}
        />
        {data.map((d, i) => {
          const h = max > 0 ? (d.runs / max) * chartH : 0;
          const x = i * slot + (slot - barW) / 2;
          const y = baseline - h;
          const cx = i * slot + slot / 2;
          const labelY = baseline + 14;
          return (
            <g key={d.date}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(h, d.runs > 0 ? 1 : 0)}
                rx={Math.min(1.5, barW / 2)}
                fill="var(--color-brand)"
                opacity={0.85}
              >
                <title>{`${fmtDate(d.date)}: ${d.runs} run${d.runs === 1 ? "" : "s"}`}</title>
              </rect>
              {tickSet.has(i) && (
                <text
                  x={cx}
                  y={labelY}
                  textAnchor={rotate ? "end" : "middle"}
                  fontSize={7}
                  fill="var(--color-fg-subtle)"
                  transform={rotate ? `rotate(-40 ${cx} ${labelY})` : undefined}
                >
                  {fmtDate(d.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function RecentRunsTable({ runs }: { runs: AgentDailySummary["recent_runs"] }) {
  return (
    <div className="border border-border rounded-lg bg-bg-surface/30 max-w-5xl overflow-hidden">
      <h3 className="font-display text-base font-semibold px-4 pt-4 pb-2">Recent runs</h3>
      {runs.length === 0 ? (
        <p className="text-sm text-fg-subtle px-4 pb-4">No firings in this period.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-wider text-fg-muted border-t border-border">
              <th className="px-4 py-2 font-medium">Time</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 font-medium">Session</th>
              <th className="px-4 py-2 font-medium">Error</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const ts = r.started_at ?? r.created_at;
              return (
                <tr key={r.id} className="border-t border-border">
                  <td className="px-4 py-2 text-xs text-fg-muted whitespace-nowrap">
                    {formatRelative(Date.now() - new Date(ts).getTime())}
                  </td>
                  <td className="px-4 py-2">
                    <StatusPill status={scheduleStatusTone(r.status)} label={r.status} />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">
                    {r.session_id ? (
                      <Link to={`/sessions/${r.session_id}`} className="hover:underline">
                        {r.session_id}
                      </Link>
                    ) : (
                      <span className="text-fg-subtle">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2 text-xs text-danger max-w-xs truncate">
                    {r.error ?? ""}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

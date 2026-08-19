import { useMemo, useState } from "react";

import { useApiQuery } from "../../lib/useApiQuery";
import { EmptyState } from "../../components/EmptyState";
import { cn } from "@/lib/utils";
import { formatCompact, formatSandboxTime, formatUsd } from "../../lib/format";
import {
  DAILY_CHART_VIEW_W,
  dailyActivityBarWidth,
  dailyActivitySlot,
  dailyActivityTickIndices,
} from "../../lib/daily-activity-chart";
import { useAgentHub } from "../AgentDetail";

// ── Analytics wire shape — mirrors SessionAnalytics
//    (@duyet/oma-sessions-store). ────────────────────────────────────────
interface Percentiles {
  p50: number;
  p90: number;
  p95: number;
}
interface Analytics {
  range: string;
  total_sessions: number;
  completed_sessions: number;
  error_count: number;
  error_rate: number;
  tokens: {
    input: number;
    output: number;
    total: number;
    per_session: { input: Percentiles; output: Percentiles; total: Percentiles };
  };
  total_turns: number;
  turns_per_session: Percentiles;
  total_tool_calls: number;
  sessions_over_time: Array<{ date: string; count: number }>;
  stop_reasons?: Array<{ stop_reason: string; count: number }>;
}

/** All-time per-agent totals — GET /v1/agents/:id/stats. */
interface AgentStats {
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  sandbox_seconds: number;
  est_model_cost_usd: number;
  est_sandbox_cost_usd: number;
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  reasoning_tokens?: number;
  cache_hit_ratio?: number;
}

type Range = "7d" | "30d" | "90d";
const RANGES: Range[] = ["7d", "30d", "90d"];
type Pctl = keyof Percentiles;
const PCTLS: Pctl[] = ["p50", "p90", "p95"];

// Donut palette — brand-neutral categorical hues via CSS tokens.
const DONUT_COLORS = [
  "var(--color-brand)",
  "var(--color-info)",
  "var(--color-success)",
  "var(--color-warning)",
  "var(--color-accent-violet)",
  "var(--color-danger)",
];

/**
 * Tab 4 — per-agent observability. Consumes GET /v1/agents/:id/analytics
 * (range-scoped) for the activity chart, error rate, token/turn
 * percentiles, and stop-reason breakdown, plus GET /v1/agents/:id/stats
 * for an all-time totals row (cost + sandbox time). All charts are
 * hand-rolled inline SVG — no chart library.
 */
export function AgentObservabilityTab() {
  const { agent } = useAgentHub();
  const [range, setRange] = useState<Range>("30d");

  const { data: analytics, isLoading } = useApiQuery<Analytics>(
    `/v1/agents/${agent.id}/analytics`,
    { range },
  );
  const { data: stats } = useApiQuery<AgentStats>(`/v1/agents/${agent.id}/stats`);

  const isEmpty = !!analytics && analytics.total_sessions === 0;

  return (
    <div className="pb-4 space-y-6">
      {/* All-time totals (distinct from the range-scoped analytics below). */}
      {stats && (
        <div>
          <h3 className="text-xs uppercase tracking-wider text-fg-subtle font-medium mb-2">
            All time
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 max-w-5xl">
            <StatCard label="Sessions" value={formatCompact(stats.sessions)} />
            <StatCard label="Tokens in" value={formatCompact(stats.input_tokens)} />
            <StatCard label="Tokens out" value={formatCompact(stats.output_tokens)} />
            <StatCard label="Est. model cost" value={formatUsd(stats.est_model_cost_usd)} />
            <StatCard label="Sandbox time" value={formatSandboxTime(stats.sandbox_seconds)} />
            <StatCard label="Est. sandbox cost" value={formatUsd(stats.est_sandbox_cost_usd)} />
            <StatCard label="Cache read" value={formatCompact(stats.cache_read_tokens ?? 0)} />
            <StatCard label="Cache write" value={formatCompact(stats.cache_creation_tokens ?? 0)} />
            <StatCard label="Reasoning" value={formatCompact(stats.reasoning_tokens ?? 0)} />
            <StatCard
              label="Cache hit ratio"
              value={`${((stats.cache_hit_ratio ?? 0) * 100).toFixed(0)}%`}
            />
          </div>
        </div>
      )}

      {/* Range chip row. */}
      <div className="flex items-center gap-2">
        <span className="text-xs text-fg-subtle">Range</span>
        <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-[3px]">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={cn(
                "px-2.5 py-1 rounded-md text-xs font-medium transition-all",
                range === r
                  ? "bg-background text-foreground shadow-sm"
                  : "text-foreground/60 hover:text-foreground",
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      {isLoading && !analytics ? (
        <p className="text-sm text-fg-subtle">Loading analytics…</p>
      ) : isEmpty || !analytics ? (
        <EmptyState
          title="No activity in this range"
          body="Once this agent runs sessions in the selected window, its analytics will appear here."
          kind="session"
          size="lg"
        />
      ) : (
        <>
          {/* Stat cards row. */}
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3 max-w-5xl">
            <StatCard label="Sessions" value={formatCompact(analytics.total_sessions)} />
            <StatCard
              label="Error rate"
              value={`${(analytics.error_rate * 100).toFixed(1)}%`}
              hint={`${analytics.error_count} of ${analytics.completed_sessions} completed`}
            />
            <StatCard label="Total input tokens" value={formatCompact(analytics.tokens.input)} />
            <StatCard label="Total output tokens" value={formatCompact(analytics.tokens.output)} />
          </div>

          {/* Session activity. */}
          <Card title="Session activity">
            <ActivityChart data={analytics.sessions_over_time} />
          </Card>

          {/* Percentile cards. */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 max-w-5xl">
            <PercentileCard title="Turns per session" pctls={analytics.turns_per_session} />
            <PercentileCard title="Input tokens" pctls={analytics.tokens.per_session.input} />
            <PercentileCard title="Output tokens" pctls={analytics.tokens.per_session.output} />
          </div>

          {/* Stop reasons. */}
          <Card title="Stop reasons">
            <StopReasons reasons={analytics.stop_reasons ?? []} />
          </Card>
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

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border border-border rounded-lg bg-bg-surface/30 p-4 max-w-5xl">
      <h3 className="font-display text-base font-semibold mb-3">{title}</h3>
      {children}
    </div>
  );
}

/** Column chart of daily session counts — inline SVG, hover tooltips via
 *  `<title>`, date labels every ~n/6 buckets, all-zero data safe. */
function ActivityChart({ data }: { data: Array<{ date: string; count: number }> }) {
  const n = data.length;
  if (n === 0) return <p className="text-sm text-fg-subtle">No data.</p>;

  const max = Math.max(1, ...data.map((d) => d.count));
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
        aria-label="Daily session activity"
      >
        {/* baseline */}
        <line
          x1={0}
          y1={baseline}
          x2={viewW}
          y2={baseline}
          stroke="var(--color-border)"
          strokeWidth={1}
        />
        {data.map((d, i) => {
          const h = max > 0 ? (d.count / max) * chartH : 0;
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
                height={Math.max(h, d.count > 0 ? 1 : 0)}
                rx={Math.min(1.5, barW / 2)}
                fill="var(--color-brand)"
                opacity={0.85}
              >
                <title>{`${fmtDate(d.date)}: ${d.count} session${d.count === 1 ? "" : "s"}`}</title>
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

/** One percentile card with p50/p90/p95 toggle chips. */
function PercentileCard({ title, pctls }: { title: string; pctls: Percentiles }) {
  const [sel, setSel] = useState<Pctl>("p50");
  return (
    <div className="border border-border rounded-lg bg-bg-surface/30 px-4 py-3">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-xs text-fg-muted uppercase tracking-wider">{title}</div>
        <div className="inline-flex items-center gap-0.5 rounded-md bg-muted p-[2px]">
          {PCTLS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setSel(p)}
              className={cn(
                "px-1.5 py-0.5 rounded text-[10px] font-medium transition-all",
                sel === p
                  ? "bg-background text-foreground shadow-sm"
                  : "text-foreground/50 hover:text-foreground",
              )}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <div className="text-lg font-semibold text-fg tabular-nums">{formatCompact(pctls[sel])}</div>
    </div>
  );
}

/** Donut (SVG stroke-dasharray segments) + legend with counts + percentages. */
function StopReasons({ reasons }: { reasons: Array<{ stop_reason: string; count: number }> }) {
  const total = useMemo(() => reasons.reduce((a, r) => a + r.count, 0), [reasons]);
  if (reasons.length === 0 || total === 0) {
    return <p className="text-sm text-fg-subtle">No stop reasons recorded in this range.</p>;
  }

  const r = 40;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const segments = reasons.map((reason, i) => {
    const frac = reason.count / total;
    const seg = {
      color: DONUT_COLORS[i % DONUT_COLORS.length],
      dash: frac * c,
      offset,
      pct: frac * 100,
      ...reason,
    };
    offset += frac * c;
    return seg;
  });

  return (
    <div className="flex items-center gap-6 flex-wrap">
      <svg viewBox="0 0 100 100" width={120} height={120} role="img" aria-label="Stop reasons">
        <g transform="rotate(-90 50 50)">
          <circle cx={50} cy={50} r={r} fill="none" stroke="var(--color-border)" strokeWidth={12} />
          {segments.map((s) => (
            <circle
              key={s.stop_reason}
              cx={50}
              cy={50}
              r={r}
              fill="none"
              stroke={s.color}
              strokeWidth={12}
              strokeDasharray={`${s.dash} ${c - s.dash}`}
              strokeDashoffset={-s.offset}
            />
          ))}
        </g>
      </svg>
      <ul className="space-y-1.5 text-sm min-w-0">
        {segments.map((s) => (
          <li key={s.stop_reason} className="flex items-center gap-2">
            <span
              className="inline-block size-2.5 rounded-sm shrink-0"
              style={{ background: s.color }}
            />
            <span className="text-fg font-mono text-xs truncate">{s.stop_reason}</span>
            <span className="text-fg-muted tabular-nums ml-auto pl-3">
              {s.count} · {s.pct.toFixed(0)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

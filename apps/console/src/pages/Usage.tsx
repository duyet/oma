import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";

import { SortableTable } from "../components/SortableTable";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { formatQueryError, useApiQuery } from "../lib/useApiQuery";
import { EmptyState } from "../components/EmptyState";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { formatCompact, formatSandboxTime, formatUsd } from "../lib/format";
import {
  DAILY_CHART_VIEW_W,
  dailyActivityBarWidth,
  dailyActivitySlot,
  dailyActivityTickIndices,
} from "../lib/daily-activity-chart";

export {
  DAILY_CHART_VIEW_W,
  dailyActivityBarWidth,
  dailyActivityLabelStep,
  dailyActivitySlot,
  dailyActivityTickIndices,
} from "../lib/daily-activity-chart";

// ── Wire shapes — mirror apps/main/src/routes/usage.ts (UsageSummary) and
//    packages/cf-billing/src/cf-analytics.ts (CostReport). Neither endpoint
//    has a typed SDK client, so these are hand-mirrored the same way
//    AgentObservabilityTab mirrors SessionAnalytics. ─────────────────────
interface UsageByKind {
  kind: string;
  // Named `total`, not `total_seconds` (#231) — this holds a raw token
  // count for the model_input_tokens/model_output_tokens kinds, so
  // `total_seconds` was a lie for those two.
  total: number;
}
interface UsageByInstanceType {
  instance_type: string | null;
  total_seconds: number;
}
interface DailyBucket {
  date: string;
  active_seconds: number;
  runs: number;
}
interface UsageByAgent {
  agent_id: string | null;
  agent_name: string | null;
  total_active_seconds: number;
  total_sessions: number;
  by_kind: UsageByKind[];
}
interface UsageSummary {
  period: { days: number; since: string | null };
  total_active_seconds: number;
  total_sessions: number;
  by_kind: UsageByKind[];
  by_instance_type: UsageByInstanceType[];
  daily: DailyBucket[];
  by_agent?: UsageByAgent[];
}

interface ServiceCost {
  usage: Record<string, number>;
  included: Record<string, number>;
  cost: number;
  breakdown?: Array<Record<string, unknown>>;
}
interface CostReport {
  available: true;
  period: { start: string; end: string; days: number };
  platform_fee: number;
  services: Record<string, ServiceCost>;
  total_estimated_cost: number;
}
// Returned instead of the full report when the deployment has no Cloudflare
// GraphQL cost credentials configured — the endpoint degrades to 200 with
// this marker rather than 501, so the rest of the page renders and only the
// infra-cost card shows a quiet inline note (mirrors apps/main/src/routes/
// cost-report.ts).
interface CostUnavailable {
  available: false;
  reason: string;
}
type CostResponse = CostReport | CostUnavailable;

type Range = "7d" | "30d" | "90d";
const RANGES: Range[] = ["7d", "30d", "90d"];
const RANGE_DAYS: Record<Range, number> = { "7d": 7, "30d": 30, "90d": 90 };

// usage_events.kind -> display label + the unit its `value` column holds.
// Most kinds are raw seconds; the two model_* kinds hold a raw token count
// in the same column (see packages/services/src/usage.ts's UsageKind).
const KIND_META: Record<string, { label: string; unit: "seconds" | "tokens" }> = {
  sandbox_active_seconds: { label: "Sandbox active time", unit: "seconds" },
  browser_active_seconds: { label: "Browser active time", unit: "seconds" },
  session_alive_seconds: { label: "Session alive time", unit: "seconds" },
  model_input_tokens: { label: "Model input tokens", unit: "tokens" },
  model_output_tokens: { label: "Model output tokens", unit: "tokens" },
  model_cache_read_tokens: { label: "Model cache read tokens", unit: "tokens" },
  model_cache_creation_tokens: { label: "Model cache write tokens", unit: "tokens" },
  model_reasoning_tokens: { label: "Model reasoning tokens", unit: "tokens" },
};

const SERVICE_LABELS: Record<string, string> = {
  workers: "Workers",
  durable_objects: "Durable Objects",
  kv: "KV",
  r2: "R2",
  d1: "D1",
  workers_ai: "Workers AI",
  browser_rendering: "Browser Rendering",
  containers: "Containers",
};

function kindValue(byKind: UsageByKind[], kind: string): number {
  return byKind.find((k) => k.kind === kind)?.total ?? 0;
}

function formatKindTotal(kind: string, value: number): string {
  return (KIND_META[kind]?.unit ?? "seconds") === "tokens"
    ? formatCompact(value)
    : formatSandboxTime(value);
}

/**
 * Tenant-wide usage & cost analytics (issue #174). There's no dedicated
 * top-level "Analytics" nav destination (the sidebar daily path is Agents,
 * Sessions, Overview, Usage, plus nested Resources / Settings — see
 * AppSidebar.tsx), so this page is the Usage item on that path.
 *
 * Consumes:
 *   - GET /v1/usage?days=0&group_by=agent — the "All time" stat tiles,
 *     By kind / By sandbox instance type / By agent tables, and the daily
 *     series all come from one call. `days=0` asks for the honest all-time
 *     totals (#231) rather than the server's own default of the last 30
 *     days — the *daily chart's* window is still range-adjustable, sliced
 *     client-side from the full series (see `dailySlice` below).
 *   - GET /v1/cost_report?days=N — genuinely range-scoped Cloudflare infra
 *     cost. Returns 200 with `{ available: false, reason }` when
 *     CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID aren't configured (never a
 *     4xx/5xx — a non-2xx would fire a page-level error toast) — rendered as
 *     a quiet inline note on the infra-cost card, not an error.
 *
 * Charts are hand-rolled inline SVG, matching AgentObservabilityTab — no
 * chart library. Error/retry states follow the Dashboard/#218 pattern
 * (each independent fetch renders its own loading/error/empty state so one
 * flaky endpoint doesn't hide the other's data).
 */
export function Usage() {
  const [range, setRange] = useState<Range>("30d");
  const days = RANGE_DAYS[range];

  const usageQuery = useApiQuery<UsageSummary>("/v1/usage", {
    days: "0",
    group_by: "agent",
  });
  const costQuery = useApiQuery<CostResponse>("/v1/cost_report", { days: String(days) });

  const usage = usageQuery.data;
  const costResponse = costQuery.data;
  // Narrow the union: `cost` is the priced report (only when available),
  // `costUnavailable` drives the not-configured inline note.
  const cost = costResponse?.available ? costResponse : null;
  const costUnavailable = costResponse?.available === false;

  const inputTokens = usage ? kindValue(usage.by_kind, "model_input_tokens") : 0;
  const outputTokens = usage ? kindValue(usage.by_kind, "model_output_tokens") : 0;
  const cacheReadTokens = usage ? kindValue(usage.by_kind, "model_cache_read_tokens") : 0;
  const cacheWriteTokens = usage ? kindValue(usage.by_kind, "model_cache_creation_tokens") : 0;
  const reasoningTokens = usage ? kindValue(usage.by_kind, "model_reasoning_tokens") : 0;
  const cacheHitRatio =
    cacheReadTokens + inputTokens > 0 ? cacheReadTokens / (cacheReadTokens + inputTokens) : 0;

  const dailySlice = useMemo(() => usage?.daily.slice(-days) ?? [], [usage, days]);

  const isAllEmpty =
    !!usage &&
    usage.total_sessions === 0 &&
    usage.total_active_seconds === 0 &&
    usage.by_kind.length === 0;

  return (
    <div className="pb-4 space-y-6">
      <div>
        <h2 className="font-display text-lg font-semibold text-fg">Usage &amp; cost</h2>
        <p className="text-sm text-fg-muted mt-0.5">
          Sandbox time, model tokens, and Cloudflare infra cost across every agent in this
          workspace.
        </p>
      </div>

      {/* Range picker — drives the daily-activity window (client-sliced;
          the server always returns the last 30 days) and the Cloudflare
          cost report's ?days= param. Rendered unconditionally, like the
          per-agent Observability tab's range chip, so a user stuck on an
          empty/error state for one range can try another without losing
          their place. */}
      <RangePicker range={range} onChange={setRange} />

      {usageQuery.isLoading && !usage ? (
        <UsageSkeleton />
      ) : usageQuery.error ? (
        <EmptyState
          title="Couldn't load usage"
          body={formatQueryError(usageQuery.error)}
          tone="danger"
          icon={<TriangleAlertIcon className="text-danger" />}
          action={<Button onClick={() => usageQuery.refetch()}>Retry</Button>}
        />
      ) : isAllEmpty || !usage ? (
        <EmptyState
          title="No usage in this period"
          body="Once agents run sessions, their sandbox time, tokens, and cost will appear here."
          size="lg"
        />
      ) : (
        <>
          <div>
            <h3 className="text-xs uppercase tracking-wider text-fg-subtle font-medium mb-2">
              All time
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-5xl">
              <StatCard
                label="Sandbox time"
                value={formatSandboxTime(usage.total_active_seconds)}
              />
              <StatCard
                label="Sessions with usage"
                value={formatCompact(usage.total_sessions)}
              />
              <StatCard label="Tokens in" value={formatCompact(inputTokens)} />
              <StatCard label="Tokens out" value={formatCompact(outputTokens)} />
            </div>
          </div>

          <div>
            <h3 className="text-xs uppercase tracking-wider text-fg-subtle font-medium mb-2">
              Model tokens
            </h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6 gap-3 max-w-5xl">
              <StatCard label="Input" value={formatCompact(inputTokens)} />
              <StatCard label="Output" value={formatCompact(outputTokens)} />
              <StatCard label="Cache read" value={formatCompact(cacheReadTokens)} />
              <StatCard label="Cache write" value={formatCompact(cacheWriteTokens)} />
              <StatCard label="Reasoning" value={formatCompact(reasoningTokens)} />
              <StatCard
                label="Cache hit ratio"
                value={`${(cacheHitRatio * 100).toFixed(0)}%`}
              />
            </div>
          </div>

          <Card title="Daily activity">
            <DailyChart data={dailySlice} />
          </Card>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 max-w-5xl">
            <Card title="By kind">
              <KindTable rows={usage.by_kind} />
            </Card>
            <Card title="By sandbox instance type">
              <InstanceTypeTable rows={usage.by_instance_type} />
            </Card>
          </div>

          <Card title="By agent">
            <ByAgentTable rows={usage.by_agent ?? []} />
          </Card>
        </>
      )}

      <Card title="Cloudflare cost">
        {costQuery.isLoading && !costResponse ? (
          <SkeletonRows count={3} />
        ) : costUnavailable ? (
          <EmptyState
            size="sm"
            title="Cloudflare infra cost unavailable"
            body={
              <>
                Set <code className="font-mono text-[11px]">CLOUDFLARE_API_TOKEN</code> and{" "}
                <code className="font-mono text-[11px]">CLOUDFLARE_ACCOUNT_ID</code> on this
                deployment to see priced Cloudflare resource consumption here.{" "}
                <a
                  href="https://docs.oma.duyet.net/reference/configuration/"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-fg"
                >
                  Configuration docs
                </a>
              </>
            }
          />
        ) : costQuery.error ? (
          <EmptyState
            size="sm"
            tone="danger"
            title="Couldn't load Cloudflare cost"
            body={formatQueryError(costQuery.error)}
            icon={<TriangleAlertIcon className="text-danger" />}
            action={<Button onClick={() => costQuery.refetch()}>Retry</Button>}
          />
        ) : cost ? (
          <>
            <div className="mb-3">
              <div className="text-lg font-semibold text-fg tabular-nums">
                {formatUsd(cost.total_estimated_cost)}
              </div>
              <div className="text-xs text-fg-subtle">
                {cost.period.start} – {cost.period.end} · incl.{" "}
                {formatUsd(cost.platform_fee)} platform fee
              </div>
            </div>
            <ServiceCostTable services={cost.services} />
          </>
        ) : null}
      </Card>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border rounded-lg bg-bg-surface/30 px-4 py-3">
      <div className="text-xs text-fg-muted uppercase tracking-wider">{label}</div>
      <div className="text-lg font-semibold text-fg mt-0.5 tabular-nums">{value}</div>
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border border-border rounded-lg bg-bg-surface/30 p-4 max-w-5xl">
      <h3 className="font-display text-base font-semibold mb-3">{title}</h3>
      {children}
    </div>
  );
}

function RangePicker({ range, onChange }: { range: Range; onChange: (r: Range) => void }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-fg-subtle">Range</span>
      <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-[3px]">
        {RANGES.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onChange(r)}
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
  );
}

function UsageSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 max-w-5xl">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="border border-border rounded-lg bg-bg-surface/30 px-4 py-3">
            <Skeleton className="h-3 w-20" rounded="sm" />
            <Skeleton className="h-6 w-16 mt-2" rounded="sm" />
          </div>
        ))}
      </div>
      <SkeletonRows count={4} />
    </div>
  );
}

/** Bar chart of daily sandbox-active-seconds — same hand-rolled inline-SVG
 *  approach as AgentObservabilityTab's ActivityChart (bars + baseline +
 *  `<title>` tooltips + thinned date labels), no chart library. */
function DailyChart({ data }: { data: DailyBucket[] }) {
  const n = data.length;
  if (n === 0) return <p className="text-sm text-fg-subtle">No data.</p>;

  const max = Math.max(1, ...data.map((d) => d.active_seconds));
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
        aria-label="Daily sandbox activity"
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
          const h = max > 0 ? (d.active_seconds / max) * chartH : 0;
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
                height={Math.max(h, d.active_seconds > 0 ? 1 : 0)}
                rx={Math.min(2, barW / 2)}
                fill="var(--color-brand)"
                opacity={0.85}
              >
                <title>{`${fmtDate(d.date)}: ${formatSandboxTime(d.active_seconds)} · ${d.runs} run${d.runs === 1 ? "" : "s"}`}</title>
              </rect>
              {tickSet.has(i) && (
                <text
                  x={cx}
                  y={labelY}
                  textAnchor={rotate ? "end" : "middle"}
                  fontSize={10}
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

function KindTable({ rows }: { rows: UsageByKind[] }) {
  if (rows.length === 0) return <p className="text-sm text-fg-subtle">No usage recorded.</p>;
  return (
    <SortableTable
      dense
      data={rows}
      getRowId={(r) => r.kind}
      columns={[
        {
          id: "kind",
          header: "Kind",
          accessor: (r) => KIND_META[r.kind]?.label ?? r.kind,
          cell: (r) => KIND_META[r.kind]?.label ?? r.kind,
        },
        {
          id: "total",
          header: "Total",
          align: "right",
          accessor: (r) => r.total,
          cell: (r) => formatKindTotal(r.kind, r.total),
        },
      ]}
    />
  );
}

function InstanceTypeTable({ rows }: { rows: UsageByInstanceType[] }) {
  if (rows.length === 0)
    return <p className="text-sm text-fg-subtle">No sandbox usage recorded.</p>;
  return (
    <SortableTable
      dense
      data={rows}
      getRowId={(r) => r.instance_type ?? "unknown"}
      columns={[
        {
          id: "instance_type",
          header: "Instance type",
          accessor: (r) => r.instance_type ?? "unknown",
          cell: (r) => (
            <span className="font-mono text-xs">{r.instance_type ?? "unknown"}</span>
          ),
        },
        {
          id: "active_time",
          header: "Active time",
          align: "right",
          accessor: (r) => r.total_seconds,
          cell: (r) => formatSandboxTime(r.total_seconds),
        },
      ]}
    />
  );
}

/** Per-agent breakdown (?group_by=agent, #231) with client-side column sort. */
function ByAgentTable({ rows }: { rows: UsageByAgent[] }) {
  if (rows.length === 0)
    return <p className="text-sm text-fg-subtle">No per-agent usage recorded.</p>;
  return (
    <SortableTable
      dense
      data={rows}
      getRowId={(r) => r.agent_id ?? "unattributed"}
      columns={[
        {
          id: "agent",
          header: "Agent",
          accessor: (r) => r.agent_name ?? r.agent_id ?? "",
          cell: (r) =>
            r.agent_name ?? (r.agent_id ? (
              <span className="font-mono text-xs">{r.agent_id}</span>
            ) : (
              <span className="text-fg-subtle italic">Unattributed</span>
            )),
        },
        {
          id: "sandbox_time",
          header: "Sandbox time",
          align: "right",
          accessor: (r) => r.total_active_seconds,
          cell: (r) => formatSandboxTime(r.total_active_seconds),
        },
        {
          id: "sessions",
          header: "Sessions",
          align: "right",
          accessor: (r) => r.total_sessions,
          cell: (r) => formatCompact(r.total_sessions),
        },
        {
          id: "tokens_in",
          header: "Tokens in",
          align: "right",
          accessor: (r) => kindValue(r.by_kind, "model_input_tokens"),
          cell: (r) => formatCompact(kindValue(r.by_kind, "model_input_tokens")),
        },
        {
          id: "tokens_out",
          header: "Tokens out",
          align: "right",
          accessor: (r) => kindValue(r.by_kind, "model_output_tokens"),
          cell: (r) => formatCompact(kindValue(r.by_kind, "model_output_tokens")),
        },
      ]}
    />
  );
}

/** Per-Cloudflare-service cost breakdown — /v1/cost_report groups by CF
 *  service (workers, durable_objects, kv, ...), not by agent or model
 *  (usage_events records neither model id nor a cost figure), so this is
 *  the grouping the API actually provides. Each service's `usage` record
 *  has different keys (requests/errors for workers, read/write/storage_gb
 *  for kv, ...) — joined generically rather than special-cased per
 *  service. */
function ServiceCostTable({ services }: { services: Record<string, ServiceCost> }) {
  const rows = Object.entries(services);
  if (rows.length === 0)
    return <p className="text-sm text-fg-subtle">No Cloudflare service usage recorded.</p>;
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-fg-subtle text-[11px] uppercase tracking-[0.08em]">
          <th className="text-left pb-2 font-medium">Service</th>
          <th className="text-left pb-2 font-medium">Usage</th>
          <th className="text-right pb-2 font-medium">Cost</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([key, svc]) => (
          <tr key={key} className="border-t border-border">
            <td className="py-2 text-fg">{SERVICE_LABELS[key] ?? key}</td>
            <td className="py-2 text-fg-muted text-xs">
              {Object.entries(svc.usage)
                .map(([k, v]) => `${k}: ${formatCompact(v)}`)
                .join(" · ") || "—"}
            </td>
            <td className="py-2 text-right text-fg-muted tabular-nums">
              {formatUsd(svc.cost)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

import { useMemo } from "react";
import { useNavigate } from "react-router";
import { TriangleAlertIcon } from "lucide-react";
import { useAuth } from "../lib/auth";
import { formatQueryError, useApiQuery } from "../lib/useApiQuery";
import { StatusPill } from "../components/Badge";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { StackedAssembly } from "../components/StackedAssembly";
import { GettingStartedGuide } from "../components/GettingStartedGuide";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { formatCompact, formatSandboxTime, formatSessionDuration } from "../lib/format";
import { rowActivateKeyDown } from "@/lib/utils";

// ── Usage wire shapes (mirror Usage.tsx) ──────────────────────────────────
interface DailyBucket {
  date: string;
  active_seconds: number;
  runs: number;
}
interface UsageByKind {
  kind: string;
  total: number;
}
interface UsageSummary {
  daily: DailyBucket[];
  by_kind: UsageByKind[];
  total_sessions: number;
  total_active_seconds: number;
}

interface Stats {
  agents: number;
  sessions: number;
  environments: number;
  vaults: number;
  skills: number;
  model_cards: number;
  api_keys: number;
  /** Cumulative sandbox seconds across all usage_events, all time. */
  total_sandbox_seconds: number;
  /** Distinct sessions with any recorded usage, all time. */
  total_usage_sessions: number;
}

interface RecentSession {
  id: string;
  /** Doubles as the session summary: when the caller didn't set a title,
   *  the runtime backfills it with the session's first user message
   *  (truncated) at the first turn transition — see
   *  RuntimeAdapterImpl.tryComputeRunSummary. No model call involved. */
  title: string;
  agent_id: string;
  status: string;
  created_at: string;
  /** Everything below arrives on the SAME /v1/sessions page request —
   *  they're columns on the session row, refreshed per turn, so enriching
   *  this table costs zero extra round-trips and no per-row fan-out. */
  stats?: { duration_seconds?: number };
  message_count?: number | null;
  tool_call_count?: number | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
}

/** A session that has never completed a turn has no rollup to show. `0`
 *  would be a lie (the turn may be in flight); an em-dash reads as
 *  "nothing recorded yet", which is the truth. */
function countLabel(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "—";
  return formatCompact(n);
}

export function Dashboard() {
  const nav = useNavigate();
  const { user: _user } = useAuth();
  // Headline cards + recent panel each ride their own TQ query so the
  // dashboard renders the parts it has — a flaky /v1/stats no longer
  // blocks the recent-sessions panel and vice versa. The previous
  // hand-rolled `Promise.all` + single `loading` boolean made one failure
  // hide both panels.
  const statsQuery = useApiQuery<Stats>("/v1/stats");
  const sessionsQuery = useApiQuery<{ data: RecentSession[] }>(
    "/v1/sessions",
    { limit: "5" },
  );
  // "Active sessions" isn't part of /v1/stats — there's no bespoke
  // analytics endpoint to ask for it, so derive it from a filtered
  // /v1/sessions?status=running page instead. `next_page` presence means
  // there are more than `limit` running sessions right now; render that
  // as "N+" rather than silently under-counting.
  const runningSessionsQuery = useApiQuery<{
    data: RecentSession[];
    next_page?: string;
  }>("/v1/sessions", { status: "running", limit: "100" });
  const stats = statsQuery.data ?? null;
  const recentSessions = sessionsQuery.data?.data.slice(0, 5) ?? [];

  // Mini analytics for the Overview — small inline SVG charts that give a
  // pulse without replacing the full Usage page. Two lightweight reads:
  //   - /v1/usage (all-time) for a 7-day activity sparkline and token mix
  //   - /v1/stats already in flight above for the "Sessions run" headline
  const usageQuery = useApiQuery<UsageSummary>("/v1/usage", {
    days: "7",
    group_by: "agent",
  });
  const usage = usageQuery.data ?? null;

  const runningCount = runningSessionsQuery.data?.data.length;
  const runningHasMore = Boolean(runningSessionsQuery.data?.next_page);

  // A failed /v1/stats or /v1/sessions?status=running used to leave these
  // cards showing "0"/"–" forever with no indication anything went wrong
  // (issue #182) — captions swap to a danger-toned "Couldn't load" instead
  // of the misleading "No usage yet" zero-state when the underlying query
  // errored and never got any data.
  const metrics = [
    {
      label: "Sandbox time",
      value: formatSandboxTime(stats?.total_sandbox_seconds),
      caption: statsQuery.error ? "Couldn't load" : stats?.total_sandbox_seconds ? "all time" : "No usage yet",
      isLoading: statsQuery.isLoading,
      isError: !!statsQuery.error,
    },
    {
      label: "Sessions run",
      value: (stats?.total_usage_sessions ?? 0).toLocaleString(),
      caption: statsQuery.error ? "Couldn't load" : stats?.total_usage_sessions ? "all time" : "No usage yet",
      isLoading: statsQuery.isLoading,
      isError: !!statsQuery.error,
    },
    {
      label: "Active sessions",
      value: `${runningCount ?? 0}${runningHasMore ? "+" : ""}`,
      caption: runningSessionsQuery.error ? "Couldn't load" : "right now",
      isLoading: runningSessionsQuery.isLoading,
      isError: !!runningSessionsQuery.error,
    },
    {
      label: "Agents",
      value: (stats?.agents ?? 0).toLocaleString(),
      caption: statsQuery.error ? "Couldn't load" : stats?.agents ? "total" : "No agents yet",
      isLoading: statsQuery.isLoading,
      isError: !!statsQuery.error,
    },
  ];

  return (
    <div className="pb-4">
      <div className="space-y-10 pt-3">
        {/* Header */}
        <header>
          <h1 className="font-display text-[32px] leading-tight font-semibold tracking-tight text-fg">
            Get started with oma
          </h1>
          <p className="mt-1.5 text-[15px] text-fg-muted">
            Configure the pieces below, compose them into an agent, and every
            conversation runs as a session inside a sandbox. Click any box to
            set it up. CLI install steps live on the{" "}
            <button
              onClick={() => nav("/runtimes")}
              className="text-brand hover:underline"
            >
              Sandbox Runtime page
            </button>
            .
          </p>
        </header>

        {/* Onboarding checklist — dismissible, ticks itself off from the
            counts already fetched below. Sits above the metrics because a
            first-run tenant has nothing to read in them yet. */}
        <GettingStartedGuide />

        {/* Headline metrics — prominent, number-forward cards leading the
            page (Claude Console home pattern). All values come from the
            existing /v1/stats + /v1/sessions endpoints; no new backend
            surface. Purely informational (unlike the resource-count row
            below), so no click-to-navigate here. */}
        <section>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {metrics.map((m) => (
              <Card
                key={m.label}
                data-testid={`metric-card-${m.label}`}
                className="bg-bg-surface/40"
              >
                <CardContent className="py-0.5">
                  {m.isLoading ? (
                    <Skeleton className="h-8 w-20" rounded="sm" />
                  ) : (
                    <div className="font-display text-[32px] leading-none font-semibold text-fg tabular-nums">
                      {m.value}
                    </div>
                  )}
                  <div className="mt-2.5 text-[11px] uppercase tracking-[0.08em] text-fg-muted font-medium">
                    {m.label}
                  </div>
                  <div className={`mt-0.5 text-[12px] ${m.isError ? "text-danger" : "text-fg-subtle"}`}>
                    {m.caption}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        {/* Mini analytics — inline SVG, no chart library. Each mini card
            rides its own query so one flaky endpoint doesn't hide the
            other; failed/empty fetches fall back to a quiet empty state
            rather than erroring the page. */}
        <section>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 max-w-5xl">
            {/* 7-day activity sparkline */}
            <Card title="Last 7 days">
              {usageQuery.isLoading && !usage ? (
                <Skeleton className="h-[120px] w-full" rounded="sm" />
              ) : usageQuery.error ? (
                <EmptyState
                  size="sm"
                  title="Couldn't load activity"
                  body={formatQueryError(usageQuery.error)}
                  tone="danger"
                  action={<Button onClick={() => usageQuery.refetch()}>Retry</Button>}
                />
              ) : usage && usage.daily.length > 0 ? (
                <MiniSparkline data={usage.daily.slice(-7)} />
              ) : (
                <p className="text-sm text-fg-subtle">No sessions in the last 7 days.</p>
              )}
            </Card>

            {/* Token mix — input vs output vs reasoning */}
            <Card title="Token mix">
              {usageQuery.isLoading && !usage ? (
                <Skeleton className="h-[120px] w-full" rounded="sm" />
              ) : usageQuery.error ? (
                <EmptyState
                  size="sm"
                  title="Couldn't load tokens"
                  body={formatQueryError(usageQuery.error)}
                  tone="danger"
                  action={<Button onClick={() => usageQuery.refetch()}>Retry</Button>}
                />
              ) : usage ? (
                <MiniTokenBar usage={usage} />
              ) : (
                <p className="text-sm text-fg-subtle">No token usage recorded.</p>
              )}
            </Card>
          </div>
        </section>

        {/* How it fits together — numbered setup-steps grid: three step
            columns ordered by setup dependency (① Foundation → ② Agent →
            ③ Reach). Each card is a component type with its real instances
            as badges; step headers check off as required cards go green —
            the conceptual map and the setup checklist in one panel. */}
        <StackedAssembly />

        {/* Recent sessions */}
        <section>
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-display text-lg font-semibold text-fg">Recent sessions</h2>
            <button
              onClick={() => nav("/sessions")}
              className="group/cta inline-flex items-center gap-1 min-h-11 sm:min-h-0 text-[13px] text-fg-muted hover:text-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
            >
              View all
              <span className="transition-transform duration-[var(--dur-quick)] ease-[var(--ease-soft)] group-hover/cta:translate-x-0.5">
                →
              </span>
            </button>
          </div>

          {sessionsQuery.isLoading ? (
            <div className="border border-border rounded-lg divide-y divide-border">
              {Array.from({ length: 4 }).map((_, i) => (
                /* Mirrors the loaded row: summary, status, agent, then the
                   right-aligned numeric block, so the panel doesn't jump
                   shape when the data lands. */
                <div key={i} className="flex items-center gap-4 px-4 py-3">
                  <Skeleton className="h-3.5 w-[30%]" rounded="sm" />
                  <Skeleton className="h-3.5 w-16" rounded="sm" />
                  <Skeleton className="h-3.5 w-24 hidden lg:block" rounded="sm" />
                  <Skeleton className="h-3.5 w-12 ml-auto" rounded="sm" />
                  <Skeleton className="h-3.5 w-10 hidden md:block" rounded="sm" />
                  <Skeleton className="h-3.5 w-10 hidden md:block" rounded="sm" />
                  <Skeleton className="h-3.5 w-12 hidden sm:block" rounded="sm" />
                </div>
              ))}
            </div>
          ) : sessionsQuery.error && recentSessions.length === 0 ? (
            <EmptyState
              title="Couldn't load recent sessions"
              body={formatQueryError(sessionsQuery.error)}
              tone="danger"
              icon={<TriangleAlertIcon className="text-danger" />}
              action={<Button onClick={() => sessionsQuery.refetch()}>Retry</Button>}
            />
          ) : recentSessions.length === 0 ? (
            <EmptyState
              title="No sessions yet — the stable's empty."
              body={
                <>
                  Tell your agent to start one, or visit the{" "}
                  <button
                    onClick={() => nav("/sessions")}
                    className="inline-flex items-center min-h-11 sm:min-h-0 text-brand hover:underline"
                  >
                    Sessions page
                  </button>
                  .
                </>
              }
            />
          ) : (
            /* The table — not the page — owns the horizontal overflow, so a
               narrow viewport scrolls this panel instead of the whole
               document. Secondary columns drop out below `md` rather than
               being squeezed; the primary summary + status + duration
               survive at every width. */
            <div className="border border-border rounded-lg overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-bg-surface/40 text-fg-subtle text-[11px] uppercase tracking-[0.08em]">
                    <th className="text-left px-4 py-2.5 font-medium">Session</th>
                    <th className="text-left px-4 py-2.5 font-medium">Status</th>
                    <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">Agent</th>
                    <th className="text-right px-4 py-2.5 font-medium">Duration</th>
                    <th className="text-right px-4 py-2.5 font-medium hidden md:table-cell">
                      Messages
                    </th>
                    <th className="text-right px-4 py-2.5 font-medium hidden md:table-cell">
                      Tools
                    </th>
                    <th className="text-right px-4 py-2.5 font-medium hidden sm:table-cell">
                      Tokens
                    </th>
                    <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">
                      Created
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {recentSessions.map((s) => {
                    const inTok = s.input_tokens ?? 0;
                    const outTok = s.output_tokens ?? 0;
                    const totalTok = inTok + outTok;
                    // A running session's duration is still accruing — the
                    // server's value is a snapshot taken at request time, so
                    // mark it rather than implying it's final.
                    const isRunning = s.status === "running";
                    return (
                      <tr
                        key={s.id}
                        onClick={() => nav(`/sessions/${s.id}`)}
                        onKeyDown={rowActivateKeyDown(() => nav(`/sessions/${s.id}`))}
                        tabIndex={0}
                        role="button"
                        className="border-t border-border hover:bg-bg-surface/40 cursor-pointer transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                      >
                        {/* Summary. Truncated to one line so a long opening
                            message can't blow the row height out; the full
                            text stays reachable via the native tooltip. */}
                        <td className="px-4 py-2.5 text-fg max-w-[22rem]">
                          <span
                            className="block truncate"
                            title={s.title || undefined}
                          >
                            {s.title || (
                              <span className="text-fg-subtle">Untitled</span>
                            )}
                          </span>
                        </td>
                        <td className="px-4 py-2.5">
                          <StatusPill status={s.status || "idle"} />
                        </td>
                        <td className="px-4 py-2.5 text-fg-muted font-mono text-[12px] hidden lg:table-cell">
                          {s.agent_id}
                        </td>
                        <td className="px-4 py-2.5 text-right text-fg-muted text-[12px] tabular-nums whitespace-nowrap">
                          {formatSessionDuration(s.stats?.duration_seconds)}
                          {isRunning && s.stats?.duration_seconds != null ? (
                            <span className="text-fg-subtle" title="Still running">
                              +
                            </span>
                          ) : null}
                        </td>
                        <td
                          className="px-4 py-2.5 text-right text-fg-muted text-[12px] tabular-nums hidden md:table-cell"
                          title={
                            s.message_count
                              ? `${s.message_count.toLocaleString()} agent messages`
                              : undefined
                          }
                        >
                          {countLabel(s.message_count)}
                        </td>
                        <td
                          className="px-4 py-2.5 text-right text-fg-muted text-[12px] tabular-nums hidden md:table-cell"
                          title={
                            s.tool_call_count
                              ? `${s.tool_call_count.toLocaleString()} tool calls`
                              : undefined
                          }
                        >
                          {countLabel(s.tool_call_count)}
                        </td>
                        <td
                          className="px-4 py-2.5 text-right text-fg-muted text-[12px] tabular-nums hidden sm:table-cell"
                          title={
                            totalTok
                              ? `${inTok.toLocaleString()} in · ${outTok.toLocaleString()} out`
                              : undefined
                          }
                        >
                          {countLabel(totalTok)}
                        </td>
                        <td className="px-4 py-2.5 text-fg-muted text-[12px] whitespace-nowrap hidden lg:table-cell">
                          {new Date(s.created_at).toLocaleDateString()}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// ── Mini chart helpers ───────────────────────────────────────────────────

function fmtTokenValue(v: number): string {
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

function kindValue(byKind: UsageByKind[], kind: string): number {
  return byKind.find((k) => k.kind === kind)?.total ?? 0;
}

/** 7-day area sparkline for daily active seconds. Mirrors Usage.tsx's
 *  DailyChart in spirit (inline SVG, tooltips) but is more compact and
 *  drives off active_seconds only. */
function MiniSparkline({ data }: { data: DailyBucket[] }) {
  const n = data.length;
  if (n === 0) return <p className="text-sm text-fg-subtle">No data.</p>;

  const max = Math.max(1, ...data.map((d) => d.active_seconds));
  const slot = 12;
  const barW = 8;
  const chartTop = 8;
  const chartH = 80;
  const baseline = chartTop + chartH;
  const totalW = n * slot;

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };

  return (
    <div className="overflow-x-auto">
      <svg
        viewBox={`0 0 ${totalW} ${baseline + 16}`}
        width="100%"
        height={baseline + 16}
        preserveAspectRatio="none"
        role="img"
        aria-label="7-day activity"
      >
        <line x1={0} y1={baseline} x2={totalW} y2={baseline} stroke="var(--color-border)" strokeWidth={1} />
        {data.map((d, i) => {
          const h = max > 0 ? (d.active_seconds / max) * chartH : 0;
          const x = i * slot + (slot - barW) / 2;
          const y = baseline - h;
          return (
            <g key={d.date}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(h, d.active_seconds > 0 ? 1 : 0)}
                rx={1.5}
                fill="var(--color-brand)"
                opacity={0.85}
              >
                <title>{`${fmtDate(d.date)}: ${formatSandboxTime(d.active_seconds)} · ${d.runs} run${d.runs === 1 ? "" : "s"}`}</title>
              </rect>
              {i % 2 === 0 && (
                <text
                  x={i * slot + slot / 2}
                  y={baseline + 12}
                  textAnchor="middle"
                  fontSize={7}
                  fill="var(--color-fg-subtle)"
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

/** Horizontal stacked bar showing the mix between input, output, and
 *  reasoning tokens. Pure decoration; empty/zero usage collapses to a
 *  quiet empty state. */
function MiniTokenBar({ usage }: { usage: UsageSummary }) {
  const input = kindValue(usage.by_kind, "model_input_tokens");
  const output = kindValue(usage.by_kind, "model_output_tokens");
  const reasoning = kindValue(usage.by_kind, "model_reasoning_tokens");
  const total = input + output + reasoning;
  if (total === 0) return <p className="text-sm text-fg-subtle">No token usage recorded.</p>;

  const W = 100;
  const H = 12;
  const segments = [
    { key: "input", value: input, color: "var(--color-brand)", label: "Input" },
    { key: "output", value: output, color: "var(--color-success)", label: "Output" },
    { key: "reasoning", value: reasoning, color: "var(--color-fg-subtle)", label: "Reasoning" },
  ].filter((s) => s.value > 0);

  let x = 0;
  return (
    <div className="space-y-2">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Token mix">
        {segments.map((s) => {
          const w = (s.value / total) * W;
          const rx = x === 0 ? H / 2 : 0;
          return (
            <rect
              key={s.key}
              x={x}
              y={0}
              width={w}
              height={H}
              rx={rx}
              fill={s.color}
              opacity={0.9}
            >
              <title>{`${s.label}: ${fmtTokenValue(s.value)} (${((s.value / total) * 100).toFixed(0)}%)`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fg-subtle">
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm" style={{ backgroundColor: "var(--color-brand)" }} />
          In {fmtTokenValue(input)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="size-2 rounded-sm" style={{ backgroundColor: "var(--color-success)" }} />
          Out {fmtTokenValue(output)}
        </span>
        {reasoning > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span className="size-2 rounded-sm" style={{ backgroundColor: "var(--color-fg-subtle)" }} />
            Reason {fmtTokenValue(reasoning)}
          </span>
        )}
        <span className="text-fg-muted tabular-nums ml-auto">{fmtTokenValue(total)} total</span>
      </div>
    </div>
  );
}

import type { ReactNode } from "react";
import { useMemo } from "react";
import { useNavigate } from "react-router";
import {
  ActivityIcon,
  BotIcon,
  ChartColumnIcon,
  CirclePlayIcon,
  HistoryIcon,
  TimerIcon,
  TriangleAlertIcon,
  CoinsIcon,
} from "lucide-react";
import { formatQueryError, useApiQuery } from "../lib/useApiQuery";
import { StatusPill } from "@/components/StatusPill";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "@/components/ui/skeleton";
import { StackedAssembly } from "../components/StackedAssembly";
import { GettingStartedGuide } from "../components/GettingStartedGuide";
import { Button } from "@/components/ui/button";
import { formatCompact, formatSandboxTime, formatSessionDuration } from "../lib/format";
import {
  DAILY_CHART_VIEW_W,
  dailyActivityBarWidth,
  dailyActivitySlot,
  dailyActivityTickIndices,
} from "../lib/daily-activity-chart";
import { cn, rowActivateKeyDown } from "@/lib/utils";

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

interface MetricCard {
  label: string;
  icon: typeof TimerIcon;
  /** Tailwind classes for the icon badge (bg + text). */
  iconTone: string;
  value: string;
  caption: string;
  isLoading: boolean;
  isError: boolean;
  isLive?: boolean;
  /** When set, the card navigates on activate — metrics that map cleanly
   *  to a list/detail page (agents, sessions, usage). Pure-aggregate
   *  numbers without a destination stay non-interactive. */
  href?: string;
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
  // Agent id → name for the recent-sessions table. Same list the console
  // already uses elsewhere; TanStack dedupes with StackedAssembly's
  // `/v1/agents` fetch when the limit matches a warm cache, otherwise this
  // is one extra cheap list call (not per-row).
  const agentsQuery = useApiQuery<{ data: { id: string; name: string }[] }>(
    "/v1/agents",
    { limit: "100" },
  );
  const agentNameById = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of agentsQuery.data?.data ?? []) {
      if (a.id) map.set(a.id, a.name || a.id);
    }
    return map;
  }, [agentsQuery.data]);
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
  // errored and never got any data. Values also render "—" on error so a
  // failed fetch never masquerades as a real zero.
  const metrics: MetricCard[] = [
    {
      label: "Sandbox time",
      icon: TimerIcon,
      iconTone: "bg-brand-subtle text-brand",
      value: statsQuery.error ? "—" : formatSandboxTime(stats?.total_sandbox_seconds),
      caption: statsQuery.error
        ? "Couldn't load"
        : stats?.total_sandbox_seconds
          ? "all time"
          : "No usage yet",
      isLoading: statsQuery.isLoading,
      isError: !!statsQuery.error,
      href: "/usage",
    },
    {
      label: "Sessions run",
      icon: CirclePlayIcon,
      iconTone: "bg-info-subtle text-info",
      value: statsQuery.error
        ? "—"
        : (stats?.total_usage_sessions ?? 0).toLocaleString(),
      caption: statsQuery.error
        ? "Couldn't load"
        : stats?.total_usage_sessions
          ? "all time"
          : "No usage yet",
      isLoading: statsQuery.isLoading,
      isError: !!statsQuery.error,
      href: "/usage",
    },
    {
      label: "Active sessions",
      icon: ActivityIcon,
      iconTone: runningSessionsQuery.error
        ? "bg-bg-surface text-fg-subtle"
        : (runningCount ?? 0) > 0
          ? "bg-success-subtle text-success"
          : "bg-bg-surface text-fg-muted",
      value: runningSessionsQuery.error
        ? "—"
        : `${runningCount ?? 0}${runningHasMore ? "+" : ""}`,
      caption: runningSessionsQuery.error ? "Couldn't load" : "right now",
      isLoading: runningSessionsQuery.isLoading,
      isError: !!runningSessionsQuery.error,
      isLive: !runningSessionsQuery.error && (runningCount ?? 0) > 0,
      // Deep-link into SessionsList with the running status chip pre-applied.
      href: "/sessions?status=running",
    },
    {
      label: "Agents",
      icon: BotIcon,
      iconTone: "bg-accent-violet-subtle text-accent-violet",
      value: statsQuery.error ? "—" : (stats?.agents ?? 0).toLocaleString(),
      caption: statsQuery.error
        ? "Couldn't load"
        : stats?.agents
          ? "total"
          : "No agents yet",
      isLoading: statsQuery.isLoading,
      isError: !!statsQuery.error,
      href: "/agents",
    },
  ];

  // Header copy tracks tenant maturity so a returning operator isn't
  // greeted with "Get started" forever, and a brand-new tenant still gets
  // a concrete next action above the fold.
  const header = useMemo(() => {
    const agents = stats?.agents ?? 0;
    const sessions = stats?.sessions ?? 0;
    const hasRecent = recentSessions.length > 0;
    if (statsQuery.isLoading && !stats) {
      return {
        title: "Overview",
        subtitle: "Your workspace at a glance.",
      };
    }
    if (agents === 0) {
      return {
        title: "Overview",
        subtitle:
          "Create an agent to start running sessions. The checklist below walks through the first setup.",
      };
    }
    if (sessions === 0 && !hasRecent) {
      return {
        title: "Overview",
        subtitle:
          "You have an agent — start a session to see live activity, sandbox time, and recent work here.",
      };
    }
    return {
      title: "Overview",
      subtitle:
        "Recent sessions, sandbox time, and what's running. Start another from Agents or Sessions.",
    };
  }, [stats, statsQuery.isLoading, recentSessions.length]);

  // Only surface the mini analytics strip when there's something to read
  // (or a load/error to acknowledge). Two empty chart shells on a brand-new
  // tenant just pad the page between the checklist and the assembly map.
  const hasUsageSignal = Boolean(
    usage &&
      (usage.daily.some((d) => d.active_seconds > 0 || d.runs > 0) ||
        usage.by_kind.some((k) => k.total > 0)),
  );
  const showAnalytics =
    usageQuery.isLoading || !!usageQuery.error || hasUsageSignal;

  const agentCount = stats?.agents ?? 0;

  // Mature tenants already know the stack map — keep it behind a disclosure
  // so Overview leads with metrics / recent work. New tenants (no agents or
  // no sessions yet) keep the assembly open and prominent.
  //
  // Default CLOSED while stats are still loading: `isSetUp` used to be false
  // during load (because of the `!isLoading` gate), which forced
  // `defaultOpen={true}` and then flipped to closed once counts landed —
  // returning operators saw the full map flash open then collapse.
  const isMature =
    (stats?.agents ?? 0) > 0 &&
    ((stats?.sessions ?? 0) > 0 || recentSessions.length > 0);
  const assemblyDefaultOpen = statsQuery.isLoading ? false : !isMature;

  return (
    <div className="pb-4">
      <div className="space-y-8 pt-3">
        {/* Header — page name matches the sidebar "Overview" crumb so the
            operator always knows where they are. Subtitle is the next-action
            line for new tenants, a pulse summary for returning ones. */}
        <header>
          <h1 className="font-display text-[32px] leading-tight font-semibold tracking-tight text-fg">
            {header.title}
          </h1>
          <p className="mt-1.5 max-w-2xl text-[15px] text-fg-muted">
            {header.subtitle}
          </p>
        </header>

        {/* Onboarding checklist — first-run only. Hides itself once any
            session exists so this page isn't a second Launch wizard. */}
        {!isMature ? <GettingStartedGuide /> : null}

        {/* Headline metrics — number-forward strip. Cards that map to a list
            page are activatable (keyboard + click) so the numbers double as
            navigation; failed fetches never render a fake "0". */}
        <section aria-label="Workspace metrics">
          {statsQuery.error && !statsQuery.isLoading ? (
            <div className="mb-3">
              <EmptyState
                size="sm"
                title="Couldn't load workspace stats"
                body={formatQueryError(statsQuery.error)}
                tone="danger"
                icon={<TriangleAlertIcon className="text-danger" />}
                action={
                  <Button onClick={() => statsQuery.refetch()}>Retry</Button>
                }
              />
            </div>
          ) : null}
          <div className="grid grid-cols-2 lg:grid-cols-4 rounded-xl border border-border bg-bg-surface/40 divide-y divide-border lg:divide-y-0 lg:divide-x max-lg:[&>*:nth-child(odd)]:border-r max-lg:[&>*:nth-child(odd)]:border-border">
            {metrics.map((m) => {
              const Icon = m.icon;
              const interactive = Boolean(m.href) && !m.isLoading;
              return (
                <div
                  key={m.label}
                  data-testid={`metric-card-${m.label}`}
                  className={cn(
                    "px-5 py-4 outline-none transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]",
                    interactive &&
                      "cursor-pointer hover:bg-bg-surface/70 focus-visible:bg-bg-surface/70 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand/40",
                  )}
                  role={interactive ? "link" : undefined}
                  tabIndex={interactive ? 0 : undefined}
                  aria-label={
                    interactive
                      ? `${m.label}: ${m.isLoading ? "loading" : m.value}. ${m.caption}`
                      : undefined
                  }
                  aria-busy={m.isLoading || undefined}
                  onClick={
                    interactive && m.href ? () => nav(m.href!) : undefined
                  }
                  onKeyDown={
                    interactive && m.href
                      ? rowActivateKeyDown(() => nav(m.href!))
                      : undefined
                  }
                >
                  <div className="flex items-start gap-3">
                    <span
                      className={cn(
                        "flex size-10 shrink-0 items-center justify-center rounded-2xl border border-border/50",
                        m.iconTone,
                      )}
                      aria-hidden
                    >
                      <Icon className="size-[18px]" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.08em] text-fg-muted font-medium">
                        {m.label}
                        {m.isLive ? (
                          <span
                            className="ml-0.5 h-1.5 w-1.5 rounded-full bg-success animate-pulse"
                            aria-hidden
                          />
                        ) : null}
                      </div>
                      {m.isLoading ? (
                        <Skeleton className="mt-2 h-7 w-16" rounded="sm" />
                      ) : (
                        <div
                          className={cn(
                            "mt-1.5 font-display text-[26px] leading-none font-semibold tabular-nums",
                            m.isError ? "text-fg-subtle" : "text-fg",
                          )}
                        >
                          {m.value}
                        </div>
                      )}
                      <div
                        className={cn(
                          "mt-1 text-[12px]",
                          m.isError ? "text-danger" : "text-fg-subtle",
                        )}
                      >
                        {m.caption}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* Mini analytics — only when there's signal, a load in flight, or an
            error to surface. Empty new-tenant dashboards skip this strip so
            the checklist → assembly map path stays short. */}
        {showAnalytics ? (
          <section aria-label="Usage summary">
            <div className="mb-3 flex items-baseline justify-between gap-3">
              <h2 className="font-display text-lg font-semibold text-fg inline-flex items-center gap-2">
                <ChartColumnIcon className="size-[18px] text-fg-muted" aria-hidden />
                Activity
              </h2>
              <button
                type="button"
                onClick={() => nav("/usage")}
                className="group/cta inline-flex items-center gap-1 min-h-11 sm:min-h-0 text-[13px] text-fg-muted hover:text-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
              >
                Full usage
                <span className="transition-transform duration-[var(--dur-quick)] ease-[var(--ease-soft)] group-hover/cta:translate-x-0.5">
                  →
                </span>
              </button>
            </div>
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <MiniCard title="Last 7 days" icon={ChartColumnIcon}>
                {usageQuery.isLoading && !usage ? (
                  <Skeleton className="h-[120px] w-full" rounded="sm" />
                ) : usageQuery.error ? (
                  <EmptyState
                    size="sm"
                    title="Couldn't load activity"
                    body={formatQueryError(usageQuery.error)}
                    tone="danger"
                    action={
                      <Button onClick={() => usageQuery.refetch()}>Retry</Button>
                    }
                  />
                ) : usage && usage.daily.length > 0 ? (
                  <MiniSparkline data={usage.daily.slice(-7)} />
                ) : (
                  <div className="flex h-[120px] items-center justify-center text-sm text-fg-subtle">
                    No sessions in the last 7 days.
                  </div>
                )}
              </MiniCard>

              <MiniCard title="Token mix" icon={CoinsIcon}>
                {usageQuery.isLoading && !usage ? (
                  <Skeleton className="h-[120px] w-full" rounded="sm" />
                ) : usageQuery.error ? (
                  <EmptyState
                    size="sm"
                    title="Couldn't load tokens"
                    body={formatQueryError(usageQuery.error)}
                    tone="danger"
                    action={
                      <Button onClick={() => usageQuery.refetch()}>Retry</Button>
                    }
                  />
                ) : usage ? (
                  <MiniTokenBar usage={usage} />
                ) : (
                  <div className="flex h-[120px] items-center justify-center text-sm text-fg-subtle">
                    No token usage recorded.
                  </div>
                )}
              </MiniCard>
            </div>
          </section>
        ) : null}

        {/* Recent sessions — above the architecture map so a workspace that
            already has runs leads with next action, not a second setup
            wizard. First-run empty state still sits here as the CTA. */}
        <section data-testid="recent-sessions">

          <div className="flex items-baseline justify-between mb-3">
            <h2 className="font-display text-lg font-semibold text-fg inline-flex items-center gap-2">
              <HistoryIcon className="size-[18px] text-fg-muted" aria-hidden />
              Recent sessions
            </h2>
            <button
              type="button"
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
              action={
                <Button onClick={() => sessionsQuery.refetch()}>Retry</Button>
              }
            />
          ) : recentSessions.length === 0 ? (
            <EmptyState
              kind="session"
              title="No sessions yet"
              body={
                agentCount === 0
                  ? "Create an agent first, then start a session — every conversation shows up here."
                  : "Start a session with one of your agents. Completed and running turns land here."
              }
              action={
                <Button
                  onClick={() =>
                    nav(agentCount === 0 ? "/agents/new" : "/sessions")
                  }
                >
                  {agentCount === 0 ? "Create an agent" : "Go to sessions"}
                </Button>
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
                    <th className="text-left px-4 py-2.5 font-medium hidden lg:table-cell">
                      Agent
                    </th>
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
                    const agentName = agentNameById.get(s.agent_id);
                    return (
                      <tr
                        key={s.id}
                        onClick={() => nav(`/sessions/${s.id}`)}
                        onKeyDown={rowActivateKeyDown(() =>
                          nav(`/sessions/${s.id}`),
                        )}
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
                        <td
                          className="px-4 py-2.5 text-fg-muted text-[12px] hidden lg:table-cell max-w-[12rem]"
                          title={
                            agentName
                              ? `${agentName} (${s.agent_id})`
                              : s.agent_id
                          }
                        >
                          {agentName ? (
                            <span className="block truncate">{agentName}</span>
                          ) : (
                            <span className="block truncate font-mono">
                              {s.agent_id}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-2.5 text-right text-fg-muted text-[12px] tabular-nums whitespace-nowrap">
                          {formatSessionDuration(s.stats?.duration_seconds)}
                          {isRunning && s.stats?.duration_seconds != null ? (
                            <span
                              className="text-fg-subtle"
                              title="Still running"
                            >
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

        {/* How it fits together — numbered setup-steps grid: three step
            columns ordered by setup dependency (① Foundation → ② Agent →
            ③ Reach). Each card is a component type with its real instances
            as badges; step headers check off as required cards go green —
            the conceptual map and the setup checklist in one panel.
            Set-up tenants get it collapsed by default so they aren't forced
            to scroll past the architecture map every visit. */}
        <StackedAssembly defaultOpen={assemblyDefaultOpen} />
      </div>
    </div>
  );
}

// ── Mini chart helpers ───────────────────────────────────────────────────

/** Local titled panel for the Activity strip. The shadcn `Card` only
 *  accepts DOM props, so a `title` string would land as an HTML tooltip —
 *  this helper renders a real visible heading instead (mirrors Usage.tsx). */
function MiniCard({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: typeof ChartColumnIcon;
  children: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border bg-bg-surface/30 p-4">
      <h3 className="font-display text-sm font-semibold text-fg mb-3 inline-flex items-center gap-2">
        {Icon ? (
          <Icon className="size-4 text-fg-muted" aria-hidden strokeWidth={1.75} />
        ) : null}
        {title}
      </h3>
      {children}
    </div>
  );
}

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
  const viewW = DAILY_CHART_VIEW_W;
  const slot = dailyActivitySlot(n, viewW);
  const barW = dailyActivityBarWidth(slot);
  const tickSet = new Set(dailyActivityTickIndices(n, slot));
  const rotate = slot < 28;
  const chartTop = 8;
  const chartH = 80;
  const baseline = chartTop + chartH;
  const labelH = rotate ? 28 : 16;
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
        aria-label="7-day activity"
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
          const labelY = baseline + 12;
          return (
            <g key={d.date}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={Math.max(h, d.active_seconds > 0 ? 1 : 0)}
                rx={Math.min(1.5, barW / 2)}
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

/** Horizontal stacked bar showing the mix between input, output, and
 *  reasoning tokens. Pure decoration; empty/zero usage collapses to a
 *  quiet empty state. */
function MiniTokenBar({ usage }: { usage: UsageSummary }) {
  const input = kindValue(usage.by_kind, "model_input_tokens");
  const output = kindValue(usage.by_kind, "model_output_tokens");
  const reasoning = kindValue(usage.by_kind, "model_reasoning_tokens");
  const total = input + output + reasoning;
  if (total === 0)
    return <p className="text-sm text-fg-subtle">No token usage recorded.</p>;

  const W = 100;
  const H = 12;
  const segments = [
    { key: "input", value: input, color: "var(--color-brand)", label: "Input" },
    {
      key: "output",
      value: output,
      color: "var(--color-success)",
      label: "Output",
    },
    {
      key: "reasoning",
      value: reasoning,
      color: "var(--color-fg-subtle)",
      label: "Reasoning",
    },
  ].filter((s) => s.value > 0);

  let x = 0;
  return (
    <div className="space-y-2">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label="Token mix"
      >
        {segments.map((s) => {
          const w = (s.value / total) * W;
          const rx = x === 0 ? H / 2 : 0;
          const el = (
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
          x += w;
          return el;
        })}
      </svg>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-fg-subtle">
        <span className="inline-flex items-center gap-1.5">
          <span
            className="size-2 rounded-sm"
            style={{ backgroundColor: "var(--color-brand)" }}
          />
          In {fmtTokenValue(input)}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span
            className="size-2 rounded-sm"
            style={{ backgroundColor: "var(--color-success)" }}
          />
          Out {fmtTokenValue(output)}
        </span>
        {reasoning > 0 && (
          <span className="inline-flex items-center gap-1.5">
            <span
              className="size-2 rounded-sm"
              style={{ backgroundColor: "var(--color-fg-subtle)" }}
            />
            Reason {fmtTokenValue(reasoning)}
          </span>
        )}
        <span className="text-fg-muted tabular-nums ml-auto">
          {fmtTokenValue(total)} total
        </span>
      </div>
    </div>
  );
}

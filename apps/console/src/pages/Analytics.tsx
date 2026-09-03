import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import { TriangleAlertIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { formatQueryError, useApiQuery } from "../lib/useApiQuery";
import { EmptyState } from "../components/EmptyState";
import { Skeleton, SkeletonRows } from "@/components/ui/skeleton";
import { formatCompact, formatUsd } from "../lib/format";
import {
  ANALYTICS_PERIODS,
  PERIOD_DAYS,
  deriveAnalyticsSnapshot,
  deriveDelegationEdges,
  type AgentRosterEntry,
  type AnalyticsPeriod,
  type UsageSummary,
} from "../lib/analytics-snapshot";
import { HorizontalBarList } from "../components/analytics/HorizontalBarList";
import { TokenMixBar } from "../components/analytics/TokenMixBar";
import { DailyAreaChart } from "../components/analytics/DailyAreaChart";
import { DelegationRoster } from "../components/analytics/DelegationRoster";

export function Analytics() {
  const [period, setPeriod] = useState<AnalyticsPeriod>("7d");
  const usageParams = useMemo(
    () => ({ days: String(PERIOD_DAYS[period]), group_by: "agent" }),
    [period],
  );

  const usageQuery = useApiQuery<UsageSummary>("/v1/usage", usageParams, {
    staleTime: 5 * 60_000,
  });
  const agentsQuery = useApiQuery<{ data: AgentRosterEntry[] }>(
    "/v1/agents",
    { limit: "100" },
    { staleTime: 5 * 60_000 },
  );

  const usage = usageQuery.data;
  const snap = useMemo(
    () => (usage ? deriveAnalyticsSnapshot(usage, period) : null),
    [usage, period],
  );
  const edges = deriveDelegationEdges(agentsQuery.data?.data ?? []);

  const isAllEmpty =
    !!usage &&
    !!snap &&
    snap.sessions === 0 &&
    snap.totalTokens === 0 &&
    usage.by_kind.length === 0;

  const delegationCard = (
    <Card
      title="Declared delegation"
      caption="Callable sub-agent roster, not observed call counts."
    >
      {agentsQuery.isLoading && !agentsQuery.data ? (
        <SkeletonRows count={3} />
      ) : agentsQuery.error ? (
        <EmptyState
          size="sm"
          tone="danger"
          title="Couldn't load agents"
          body={formatQueryError(agentsQuery.error)}
          icon={<TriangleAlertIcon className="text-danger" />}
          action={<Button onClick={() => agentsQuery.refetch()}>Retry</Button>}
        />
      ) : (
        <DelegationRoster edges={edges} />
      )}
    </Card>
  );

  return (
    <div className="pb-4 space-y-6">
      <div>
        <h2 className="font-display text-lg font-semibold text-foreground">Analytics</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Spend, tokens, and declared delegation across agents in this workspace.
        </p>
      </div>

      <RangePicker period={period} onChange={setPeriod} />

      {usageQuery.isLoading && !usage ? (
        <AnalyticsSkeleton />
      ) : usageQuery.error ? (
        <EmptyState
          title="Couldn't load analytics"
          body={formatQueryError(usageQuery.error)}
          tone="danger"
          icon={<TriangleAlertIcon className="text-danger" />}
          action={<Button onClick={() => usageQuery.refetch()}>Retry</Button>}
        />
      ) : isAllEmpty || !usage || !snap ? (
        <EmptyState
          title="No usage in this period"
          body="Once agents run sessions, their estimated spend, tokens, and daily trend will appear here."
          size="lg"
        />
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-5xl">
            <StatCard
              label="Est. spend"
              value={formatUsd(snap.estUsd)}
              caption="Sonnet-class rates"
            />
            <StatCard label="Tokens" value={formatCompact(snap.totalTokens)} />
            <StatCard label="Sessions" value={formatCompact(snap.sessions)} />
            <StatCard label="Agents" value={formatCompact(snap.agentsWithUsage)} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 max-w-5xl">
            <Card
              title="Token mix"
              caption="By token kind. Model ids are not recorded on usage events."
            >
              <TokenMixBar rows={snap.tokenMix} />
            </Card>
            <Card
              title="Cost by agent"
              caption="Top 10 by Sonnet-class estimate. Cache and reasoning tokens are unpriced."
            >
              <HorizontalBarList cost={snap.costByAgent} />
            </Card>
          </div>

          <Card
            title="Daily trend"
            caption="Sandbox-active seconds. Daily token and cost series are not on /v1/usage daily buckets."
          >
            <DailyAreaChart data={snap.daily} />
          </Card>
        </>
      )}

      {delegationCard}
    </div>
  );
}

function StatCard({
  label,
  value,
  caption,
}: {
  label: string;
  value: string;
  caption?: string;
}) {
  return (
    <div className="border border-border rounded-2xl bg-card px-4 py-3">
      <div className="text-xs text-muted-foreground uppercase tracking-wider">{label}</div>
      <div className="text-lg font-semibold text-foreground mt-0.5 tabular-nums">{value}</div>
      {caption ? (
        <div className="text-[11px] text-muted-foreground mt-0.5">{caption}</div>
      ) : null}
    </div>
  );
}

function Card({
  title,
  caption,
  children,
}: {
  title: string;
  caption?: string;
  children: ReactNode;
}) {
  return (
    <div className="border border-border rounded-2xl bg-card p-4 max-w-5xl">
      <h3 className="font-display text-base font-semibold mb-3">{title}</h3>
      {caption ? (
        <p className="-mt-2 mb-3 text-xs text-muted-foreground">{caption}</p>
      ) : null}
      {children}
    </div>
  );
}

function RangePicker({
  period,
  onChange,
}: {
  period: AnalyticsPeriod;
  onChange: (p: AnalyticsPeriod) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">Range</span>
      <div className="inline-flex items-center gap-1 rounded-lg bg-muted p-[3px]">
        {ANALYTICS_PERIODS.map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => onChange(r)}
            className={cn(
              "px-2.5 py-1 rounded-md text-xs font-medium transition-all",
              period === r
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

function AnalyticsSkeleton() {
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 max-w-5xl">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="border border-border rounded-2xl bg-card px-4 py-3">
            <Skeleton className="h-3 w-20" rounded="sm" />
            <Skeleton className="h-6 w-16 mt-2" rounded="sm" />
          </div>
        ))}
      </div>
      <SkeletonRows count={4} />
    </div>
  );
}

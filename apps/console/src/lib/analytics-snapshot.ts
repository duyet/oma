/**
 * Cross-agent analytics snapshot derived from GET /v1/usage?group_by=agent
 * plus the agents list roster. Pure functions so the /analytics page stays
 * a thin fetch + render. Cost uses the same Sonnet-class rates as
 * GET /v1/agents/:id/stats (usage_events has no model id).
 */

export type AnalyticsPeriod = "1d" | "7d" | "30d";

export const ANALYTICS_PERIODS: AnalyticsPeriod[] = ["1d", "7d", "30d"];

export const PERIOD_DAYS: Record<AnalyticsPeriod, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
};

/** Matches apps/main/src/routes/agent-stats.ts. Echoed so the UI can label
 *  the estimate honestly. Cache/reasoning tokens are counted in totals but
 *  not priced — the stats endpoint does the same. */
export const SONNET_USD_PER_MTOK_IN = 3;
export const SONNET_USD_PER_MTOK_OUT = 15;

const TOKEN_KINDS = new Set([
  "model_input_tokens",
  "model_output_tokens",
  "model_cache_read_tokens",
  "model_cache_creation_tokens",
  "model_reasoning_tokens",
]);

const COST_BY_AGENT_TOP_N = 10;

export interface UsageByKind {
  kind: string;
  total: number;
}

export interface DailyBucket {
  date: string;
  active_seconds: number;
  runs: number;
}

export interface UsageByAgent {
  agent_id: string | null;
  agent_name: string | null;
  total_active_seconds: number;
  total_sessions: number;
  by_kind: UsageByKind[];
}

export interface UsageSummary {
  period: { days: number; since: string | null };
  total_active_seconds: number;
  total_sessions: number;
  by_kind: UsageByKind[];
  daily: DailyBucket[];
  by_agent?: UsageByAgent[];
}

export type TokenMixKind =
  | "input"
  | "output"
  | "cache_read"
  | "cache_write"
  | "reasoning";

export interface TokenMixRow {
  kind: TokenMixKind;
  tokens: number;
  pct: number;
}

export interface AgentCostRow {
  agentId: string | null;
  label: string;
  tokens: number;
  sessions: number;
  estUsd: number;
  pctOfSpend: number;
}

export interface CostByAgent {
  rows: AgentCostRow[];
  others: AgentCostRow | null;
}

export interface DelegationEdge {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
}

export interface AgentRosterEntry {
  id: string;
  name: string;
  multiagent?: {
    agents: Array<{ id: string }>;
  } | null;
}

export interface AnalyticsSnapshot {
  period: AnalyticsPeriod;
  totalTokens: number;
  estUsd: number;
  sessions: number;
  agentsWithUsage: number;
  tokenMix: TokenMixRow[];
  costByAgent: CostByAgent;
  daily: DailyBucket[];
}

export function kindValue(byKind: UsageByKind[], kind: string): number {
  return byKind.find((k) => k.kind === kind)?.total ?? 0;
}

export function sumTokenKinds(byKind: UsageByKind[]): number {
  return byKind.reduce((n, k) => n + (TOKEN_KINDS.has(k.kind) ? k.total : 0), 0);
}

export function estimateSonnetUsd(byKind: UsageByKind[]): number {
  const input = kindValue(byKind, "model_input_tokens");
  const output = kindValue(byKind, "model_output_tokens");
  return (input / 1_000_000) * SONNET_USD_PER_MTOK_IN
    + (output / 1_000_000) * SONNET_USD_PER_MTOK_OUT;
}

const MIX_KINDS: Array<{ kind: TokenMixKind; usageKind: string }> = [
  { kind: "input", usageKind: "model_input_tokens" },
  { kind: "output", usageKind: "model_output_tokens" },
  { kind: "cache_read", usageKind: "model_cache_read_tokens" },
  { kind: "cache_write", usageKind: "model_cache_creation_tokens" },
  { kind: "reasoning", usageKind: "model_reasoning_tokens" },
];

export function deriveTokenMix(byKind: UsageByKind[]): TokenMixRow[] {
  const tokens = MIX_KINDS.map(({ kind, usageKind }) => ({
    kind,
    tokens: kindValue(byKind, usageKind),
  }));
  const total = tokens.reduce((n, r) => n + r.tokens, 0);
  return tokens.map((r) => ({
    ...r,
    pct: total > 0 ? r.tokens / total : 0,
  }));
}

function agentLabel(row: UsageByAgent): string {
  if (row.agent_name) return row.agent_name;
  if (row.agent_id) return row.agent_id;
  return "Unattributed";
}

export function deriveCostByAgent(byAgent: UsageByAgent[]): CostByAgent {
  const ranked = byAgent
    .map((row) => {
      const estUsd = estimateSonnetUsd(row.by_kind ?? []);
      return {
        agentId: row.agent_id,
        label: agentLabel(row),
        tokens: sumTokenKinds(row.by_kind ?? []),
        sessions: row.total_sessions,
        estUsd,
        pctOfSpend: 0,
      };
    })
    .sort((a, b) => b.estUsd - a.estUsd || b.tokens - a.tokens);

  const spend = ranked.reduce((n, r) => n + r.estUsd, 0);
  const withPct = ranked.map((r) => ({
    ...r,
    pctOfSpend: spend > 0 ? r.estUsd / spend : 0,
  }));

  if (withPct.length <= COST_BY_AGENT_TOP_N) {
    return { rows: withPct, others: null };
  }

  const rows = withPct.slice(0, COST_BY_AGENT_TOP_N);
  const rest = withPct.slice(COST_BY_AGENT_TOP_N);
  const others: AgentCostRow = {
    agentId: null,
    label: "Others",
    tokens: rest.reduce((n, r) => n + r.tokens, 0),
    sessions: rest.reduce((n, r) => n + r.sessions, 0),
    estUsd: rest.reduce((n, r) => n + r.estUsd, 0),
    pctOfSpend: rest.reduce((n, r) => n + r.pctOfSpend, 0),
  };
  return { rows, others };
}

export function deriveDelegationEdges(agents: AgentRosterEntry[]): DelegationEdge[] {
  const names = new Map(agents.map((a) => [a.id, a.name || a.id]));
  const edges: DelegationEdge[] = [];
  for (const agent of agents) {
    for (const child of agent.multiagent?.agents ?? []) {
      if (!child.id || child.id === agent.id) continue;
      edges.push({
        fromId: agent.id,
        fromName: agent.name || agent.id,
        toId: child.id,
        toName: names.get(child.id) ?? child.id,
      });
    }
  }
  return edges;
}

export function deriveAnalyticsSnapshot(
  usage: UsageSummary,
  period: AnalyticsPeriod,
): AnalyticsSnapshot {
  const byKind = usage.by_kind ?? [];
  return {
    period,
    totalTokens: sumTokenKinds(byKind),
    estUsd: estimateSonnetUsd(byKind),
    sessions: usage.total_sessions,
    agentsWithUsage: (usage.by_agent ?? []).filter((r) => r.agent_id).length,
    tokenMix: deriveTokenMix(byKind),
    costByAgent: deriveCostByAgent(usage.by_agent ?? []),
    daily: usage.daily ?? [],
  };
}

/** Closed SVG area path for a series of non-negative values. y=0 is the
 *  baseline; larger values go up. Empty / all-zero series returns "". */
export function areaPath(
  values: number[],
  width: number,
  height: number,
): string {
  const n = values.length;
  if (n === 0) return "";
  const max = Math.max(1, ...values);
  const step = n === 1 ? 0 : width / (n - 1);
  const points = values.map((v, i) => {
    const x = n === 1 ? width / 2 : i * step;
    const y = height - (v / max) * height;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  });
  const lastX = n === 1 ? width / 2 : (n - 1) * step;
  const firstX = n === 1 ? width / 2 : 0;
  return `M${firstX.toFixed(2)},${height.toFixed(2)} L${points.join(" L")} L${lastX.toFixed(2)},${height.toFixed(2)} Z`;
}

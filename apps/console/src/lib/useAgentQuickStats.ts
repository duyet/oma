/**
 * Per-agent quick stats for the agents table.
 *
 * Sourced from ONE aggregate call — `GET /v1/usage?group_by=agent` already
 * returns `total_sessions` plus the token split per agent, computed from the
 * `usage_events` table without replaying any event log. The alternative,
 * `GET /v1/agents/:id/stats` per row, would be N requests for a single page
 * of the table.
 *
 * The window is deliberately the usage route's default (30 days): an
 * all-time scan is the expensive query, and "how busy has this agent been
 * lately" is what the column answers.
 */
import { useApiQuery } from "./useApiQuery";

interface UsageByKind {
  kind: string;
  total: number;
}

interface UsageByAgent {
  agent_id: string | null;
  total_sessions: number;
  by_kind: UsageByKind[];
}

interface UsageSummary {
  by_agent?: UsageByAgent[];
}

export interface AgentQuickStats {
  sessions: number;
  /** Input + output + cache tokens over the window. */
  tokens: number;
}

export interface AgentQuickStatsResult {
  /** Undefined while loading — callers render a skeleton rather than "0",
   *  which would read as a real measurement. */
  statsFor: (agentId: string) => AgentQuickStats | undefined;
  isLoading: boolean;
}

const TOKEN_KINDS = new Set([
  "model_input_tokens",
  "model_output_tokens",
  "model_cache_read_tokens",
  "model_cache_creation_tokens",
  "model_reasoning_tokens",
]);

export function sumTokens(byKind: UsageByKind[]): number {
  return byKind.reduce((n, k) => (TOKEN_KINDS.has(k.kind) ? n + k.total : n), 0);
}

export function useAgentQuickStats(): AgentQuickStatsResult {
  const { data, isLoading } = useApiQuery<UsageSummary>("/v1/usage", { group_by: "agent" });

  const byId = new Map<string, AgentQuickStats>();
  for (const row of data?.by_agent ?? []) {
    // agent_id null is the "unattributed" bucket — real usage, but not
    // creditable to any row in this table.
    if (!row.agent_id) continue;
    byId.set(row.agent_id, {
      sessions: row.total_sessions,
      tokens: sumTokens(row.by_kind ?? []),
    });
  }

  return {
    isLoading,
    statsFor: (agentId: string) =>
      isLoading ? undefined : (byId.get(agentId) ?? { sessions: 0, tokens: 0 }),
  };
}

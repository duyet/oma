export type DailySummaryDays = 1 | 7 | 30;

export type ScheduleRunStatus = "ok" | "error" | "skipped_concurrency";

export interface TokenTotals {
  input: number;
  output: number;
  cache_read: number;
  cache_creation: number;
  reasoning: number;
}

export interface DailySummaryDay {
  date: string;
  runs: number;
  successful: number;
  failed: number;
  skipped_concurrency: number;
  tokens: TokenTotals;
  estimated_cost_usd: number;
}

export interface DailySummaryRecentRun {
  id: string;
  schedule_id: string;
  session_id: string | null;
  status: string;
  error: string | null;
  started_at: string | null;
  created_at: string;
}

export interface AgentDailySummary {
  agent_id: string;
  period: { since: string; days: DailySummaryDays };
  runs: {
    total: number;
    successful: number;
    failed: number;
    skipped_concurrency: number;
  };
  tokens: TokenTotals;
  estimated_cost_usd: number;
  cache_hit_ratio: number;
  sessions: number;
  avg_session_duration_seconds: number;
  top_outputs: [];
  daily: DailySummaryDay[];
  recent_runs: DailySummaryRecentRun[];
  assumptions: {
    model_usd_per_mtok_in: number;
    model_usd_per_mtok_out: number;
  };
}

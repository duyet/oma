/**
 * Console-side Session list/detail row. Differs from
 * `@duyet/oma-api-types`' `SessionMeta` (wire-format) — the
 * list endpoint returns `agent: {id, version}` rather than `agent_id`
 * + `agent_version`, and `title` may be null.
 *
 * Lifted out of SessionsList.tsx so SessionDetail and other consumers
 * can share the shape instead of redefining their own.
 */
export interface SessionRecord {
  id: string;
  title?: string | null;
  agent: { id: string; version: number };
  environment_id: string;
  status?: string;
  created_at: string;
  archived_at?: string;
  terminated_at?: string;
  /** Cumulative token usage on the session row, overlaid by the list
   *  and GET endpoints (#166/#186). Null/absent when the session has
   *  not reported usage yet. */
  input_tokens?: number | null;
  output_tokens?: number | null;
  /** Run-summary rollup kept on the session row itself and refreshed on
   *  every turn transition — so a list page reads them in the same single
   *  query as the rest of the row, never by replaying event logs.
   *  `message_count` counts `agent.message` events (agent replies), NOT
   *  user turns; `tool_call_count` counts built-in + MCP + custom tool
   *  calls. Both are 0 until the session's first turn completes. */
  message_count?: number | null;
  tool_call_count?: number | null;
  /** "end_turn" | "destroyed" | "terminated", or null before the first
   *  turn completes. */
  stop_reason?: string | null;
  /** Last turn transition (ISO). The clock a non-running session's
   *  duration stops at. */
  updated_at?: string | null;
  metadata?: Record<string, unknown>;
  /** Server-computed wall-clock duration in seconds: created_at → the
   *  session's end reference (terminated_at, else `now` while running,
   *  else updated_at for an idle session). Present on list/SDK responses;
   *  absent on create response. */
  stats?: {
    duration_seconds?: number;
  };
  /** Sandbox resource usage. Only populated by GET /:id — the list
   *  endpoint does not overlay live usage yet. */
  sandbox_usage?: {
    instance_type?: string;
    active_seconds: number;
  };
  /** Sandbox lifecycle state — "paused" once POST /pause has snapshotted
   *  + destroyed the container (no compute billed). Optional/permissive:
   *  the pause/resume backend contract is landing separately; older rows
   *  simply omit the field and the UI treats that as "running". */
  sandbox_status?: "running" | "paused" | "none";
}

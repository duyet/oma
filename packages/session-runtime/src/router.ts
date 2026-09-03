// SessionRouter — uniform contract over the per-runtime session routing
// layer. Lets `@duyet/oma-http-routes` mount /v1/sessions/*
// once and dispatch to either the CF SessionDO (apps/main) or the Node
// SessionRegistry (apps/main-node) without the routes touching env
// bindings or sandbox internals.
//
// Method shapes mirror the SessionDO RPC surface in
// apps/agent/src/runtime/session-do.ts:
//   PUT  /init                                → init()
//   DELETE /destroy                           → destroy()
//   POST /event                               → appendEvent()
//   GET  /events                              → getEvents()
//   GET  /full-status                         → getFullStatus()
//   POST /exec                                → exec()
//   POST /__debug_recovery__                  → triggerDebugRecovery()
//   GET  /file?path=...                       → readSandboxFile()
//   GET  /threads                             → listThreads()
//   GET  /threads/:tid                        → getThread()
//   POST /threads/:tid/archive                → archiveThread()
//   GET  /threads/:tid/events                 → getThreadEvents()
//   GET  /ws (WebSocket bridge)               → streamEvents() (SSE-shaped)

import type {
  ContentBlock,
  CredentialConfig,
  SessionEvent,
  SessionRecord,
  StoredEvent,
  AgentConfig,
  EnvironmentConfig,
  SessionDeclaredOutput,
} from "@duyet/oma-shared";

export interface SessionInitParams {
  agentId: string;
  environmentId: string;
  title: string;
  tenantId: string;
  vaultIds?: string[];
  agentSnapshot?: AgentConfig;
  environmentSnapshot?: EnvironmentConfig;
  vaultCredentials?: Array<{ vault_id: string; credentials: CredentialConfig[] }>;
  initEvents?: SessionEvent[];
  /**
   * Session metadata (publication_id/end_user_id for a public consumer
   * session, deployment_run/scheduled_run tags, etc.) — mirrored into DO
   * state at /init so notify-dispatch and turn-metering can read it
   * synchronously instead of round-tripping to the session row (issue #222).
   */
  metadata?: Record<string, unknown>;
  /**
   * Per-session override of the agent's default model. Resolution formula
   * (see AGENTS.md): `session.model ?? (environment.config.kind === "local"
   * ? environment.config.local.model : agent.model)`. Stored as DO/runtime
   * state only — NEVER appended to the event log, since it feeds the
   * byte-deterministic cached prompt prefix (interface.ts contract).
   */
  model?: string;
  /**
   * Per-session override of a local-kind environment's default reasoning
   * effort. No defined meaning for cloud-kind environments today. Same
   * storage rule as `model` — init params / DO state only.
   */
  reasoningEffort?: string;
}

export interface SessionEventsQuery {
  afterSeq?: number;
  beforeSeq?: number;
  limit?: number;
  order?: "asc" | "desc";
  threadId?: string;
}

export interface SessionEventsPage {
  data: StoredEvent[];
  has_more: boolean;
}

export interface SessionFullStatus {
  status: string;
  usage: { input_tokens: number; output_tokens: number };
  sandbox_usage?: { instance_type?: string; active_seconds: number };
  /** "paused" once POST /pause has snapshotted + destroyed the sandbox;
   *  "running" otherwise. Runtimes that don't track pause state (e.g.
   *  Node before pause support lands) may omit this field. */
  sandbox_status?: "running" | "paused";
  outcome_evaluations?: Array<{
    outcome_id?: string;
    result: string;
    iteration: number;
    explanation?: string;
    feedback?: string;
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    processed_at?: string;
  }>;
  resources?: unknown[];
  /** Agent-declared deliverables derived from `agent.output_declared` events. */
  outputs?: SessionDeclaredOutput[];
}

export interface SessionExecResult {
  exit_code: number;
  output: string;
  truncated: boolean;
}

export interface SessionAppendResult {
  /** Status returned by the underlying runtime's POST /event handler.
   *  202 on accept, 4xx/409 when the session is terminated. */
  status: number;
  /** JSON envelope to surface to the caller. Routes pass it through
   *  verbatim so the AMA wire shape (request_id, error.type) is
   *  preserved. */
  body: string;
}

export interface SessionStreamFrame {
  /** Raw event JSON. Bridge already validates it's well-formed. */
  data: string;
  /** When the event carries a session_thread_id, used by route filter. */
  threadId?: string;
}

/**
 * Read-only stream subscription. CF impls back this with the SessionDO
 * /ws WebSocket bridge; Node impls fan out from EventStreamHub.
 */
export interface SessionStreamHandle {
  /** Async iterator of frames. Iteration ends when the runtime closes
   *  the stream (session destroyed, hibernated, etc.). */
  [Symbol.asyncIterator](): AsyncIterator<SessionStreamFrame>;
  /** Caller-driven cancel — stops the underlying socket / subscription. */
  close(): void;
}

export interface SessionRouter {
  /** Initialize / warm the session. CF: PUT /init on the SessionDO.
   *  Node: warm the SessionRegistry entry + persist init events. */
  init(sessionId: string, params: SessionInitParams): Promise<void>;

  /** Tear down sandbox + emit final usage. CF: DELETE /destroy. Node:
   *  sandbox.destroy + clear registry entry. */
  destroy(sessionId: string): Promise<void>;

  /** Snapshot the workspace and destroy the sandbox container to save
   *  cost while keeping the session resumable. Returns 409 when the
   *  session has an in-flight turn; 200 (no-op) when already paused. */
  pause(sessionId: string): Promise<{ status: number; body: string }>;

  /** Reprovision the sandbox container, restoring the latest workspace
   *  snapshot. No-op (200) when the session isn't paused. */
  resume(sessionId: string): Promise<{ status: number; body: string }>;

  /** Change the session-level model / reasoning-effort override mid-flight.
   *  Same resolution slots the create-time `model` + `reasoning_effort`
   *  body fields write to, so the next turn picks the new value up without
   *  touching the agent record (which is shared by every other session).
   *  Returns 409 while a turn is in flight — swapping the model under a
   *  running harness would split one turn across two providers. Runtimes
   *  that can't mutate a live session return 501. */
  updateRuntimeSettings?(
    sessionId: string,
    settings: { model?: string | null; reasoningEffort?: string | null },
  ): Promise<{ status: number; body: string }>;

  /** Persist + broadcast a `session.config_updated` audit event after an
   *  operator injection. Overlay state is already on the session row —
   *  this is observational. Runtimes that cannot append to the event log
   *  may omit the method; the injection still takes effect. */
  recordConfigUpdated?(
    sessionId: string,
    event: Extract<SessionEvent, { type: "session.config_updated" }>,
  ): Promise<{ status: number; body: string }>;

  /** Submit a user.* event. Returns the underlying status + body so
   *  routes can pass non-202 (terminated 409) verbatim. */
  appendEvent(
    sessionId: string,
    event: SessionEvent,
  ): Promise<SessionAppendResult>;

  /** Paginated event read. */
  getEvents(
    sessionId: string,
    opts?: SessionEventsQuery,
  ): Promise<SessionEventsPage>;

  /** Open a live event stream. Caller drives consumption + close.
   *
   *  - `replay` (default false): replay full persisted history before tailing
   *    live events. With `lastEventId` set, replay is implicit and starts
   *    from `seq > lastEventId`.
   *  - `include` (default `[]`): comma-list of OMA extension buckets to admit
   *    onto the stream. v1 only `"chunks"` is recognized — when present, all
   *    OMA extension event types pass through (chunks, lifecycle, system.*,
   *    session.warning, extra spans). When absent, only the Anthropic-spec
   *    event union is delivered (see `SPEC_EVENT_TYPES` in api-types). */
  streamEvents(
    sessionId: string,
    opts?: {
      threadId?: string;
      lastEventId?: number;
      replay?: boolean;
      include?: string[];
    },
  ): Promise<SessionStreamHandle>;

  /** Abort the in-flight harness for the session. No-op when nothing's
   *  running. CF: DO POST /event with user.interrupt. Node:
   *  SessionRegistry.interrupt(). */
  interrupt(sessionId: string, reason?: string): Promise<void>;

  /** Run a raw shell command in the session's sandbox (eval / verifier
   *  helper). */
  exec(
    sessionId: string,
    body: { command: string; timeout_ms?: number },
  ): Promise<SessionExecResult>;

  /** Read the live full-status (usage, outcome_evaluations, resources,
   *  declared outputs) for GET /v1/sessions/:id overlay. Returns null when
   *  the runtime is unreachable; route falls back to the stored row. */
  getFullStatus(sessionId: string): Promise<SessionFullStatus | null>;

  /** Read a file out of the sandbox by path — used to promote sandbox
   *  paths to first-class file_ids. CF: DO GET /file?path=. Node: read
   *  from sandbox workdir. */
  readSandboxFile(sessionId: string, path: string): Promise<ArrayBuffer | null>;

  /** Token-gated debug recovery probe. */
  triggerDebugRecovery(
    sessionId: string,
    token: string,
  ): Promise<{ status: number; body: string }>;

  /** Build the Trajectory v1 envelope for /v1/sessions/:id/trajectory. */
  getTrajectory(
    session: SessionRecord,
    helpers: {
      fetchEnvironmentConfig: () => Promise<EnvironmentConfig | null>;
    },
  ): Promise<unknown>;

  // ── Threads ───────────────────────────────────────────────────────────
  listThreads(sessionId: string): Promise<unknown>;
  getThread(
    sessionId: string,
    threadId: string,
  ): Promise<{ status: number; body: string }>;
  getThreadEvents(
    sessionId: string,
    threadId: string,
    opts?: SessionEventsQuery,
  ): Promise<SessionEventsPage>;
  archiveThread(
    sessionId: string,
    threadId: string,
  ): Promise<{ status: number; body: string }>;

  // ── Pending events ────────────────────────────────────────────────────
  /** GET /v1/sessions/:id/pending — AMA-spec pending queue. Lists user.*
   *  events that have been enqueued but not yet drained by the harness.
   *  Implementations forward the raw search-string + return whatever the
   *  underlying store/SessionDO produces. */
  getPending(
    sessionId: string,
    opts?: { rawSearch?: string },
  ): Promise<{ status: number; body: string }>;

  // ── LLM call body ─────────────────────────────────────────────────────
  /** GET /v1/sessions/:id/llm-calls/:event_id — fetch the persisted full
   *  LLM request/response body for a single span.model_request_end event.
   *  CF reads from R2 (FILES_BUCKET) at
   *  `t/{tenantId}/sessions/{sessionId}/llm/{eventId}.json`; runtimes
   *  without that storage (Node single-host) return 501. */
  getLlmCallBody(
    tenantId: string,
    sessionId: string,
    eventId: string,
  ): Promise<{ status: number; body: BodyInit; contentType: string; contentLength?: number } | { status: 404 | 500 | 501; body: string; contentType: "application/json" }>;
}

/** Thin helper: converts a base64-encoded ContentBlock (image / document)
 *  back to its `{file_id}` source by uploading bytes to the runtime's
 *  storage. Currently unused — placeholder for the parallel route that
 *  promotes inline data into a re-referenceable file_id. */
export type FileIdResolver = (input: {
  tenantId: string;
  blocks: ContentBlock[];
}) => Promise<{ blocks: ContentBlock[]; mountFileIds: string[] }>;

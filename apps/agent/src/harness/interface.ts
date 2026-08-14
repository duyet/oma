import type { ModelMessage, LanguageModel } from "ai";
import type { AgentConfig, EnvironmentConfig, SessionEvent, UserMessageEvent } from "@duyet/oma-shared";
import type { FileResolver } from "../runtime/history";
import type { ClaudeSdkModelBinding } from "./claude-agent-sdk/model";

// SandboxExecutor + ProcessHandle live in @getoma/sandbox-sdk so
// non-CF runtimes (apps/main-node, future deployments) can implement the
// same shape without depending on apps/agent's CF-only modules. Imported
// for local use AND re-exported so existing imports keep working unchanged.
import type { SandboxExecutor, ProcessHandle } from "@getoma/sandbox-sdk";
export type { SandboxExecutor, ProcessHandle } from "@getoma/sandbox-sdk";
export type { FileResolver, ResolvedFile } from "../runtime/history";

export interface HarnessInterface {
  /** Main agent loop. Required. Drives generateText and emits events. */
  run(ctx: HarnessContext): Promise<void>;

  /**
   * Called once per session, after sandbox warmup, before the first user
   * message is processed. Default behavior (DefaultHarness): inject
   * <system-reminder> user.message events for each skill / memory_prompt /
   * appendable_prompt the agent opted into. Override to substitute a custom
   * RAG layer, or to opt out of platform reminders entirely (no-op).
   *
   * Anything written here lands in the events stream BEFORE the first user
   * message — it becomes part of the cached prefix for every subsequent turn.
   */
  onSessionInit?(ctx: HarnessContext, runtime: HarnessRuntime): Promise<void>;

  /**
   * Decide whether to trigger compaction for this turn. Default behavior:
   * estimate tokens via deriveModelContext + heuristic, fire when > 75% of
   * the model's context window. Override for cooldown / business rules /
   * never-compact / always-compact.
   *
   * `ctx.contextWindowTokens` is the resolved model's window (best-effort —
   * may be a default if the model card doesn't expose it).
   */
  shouldCompact?(events: SessionEvent[], ctx: { contextWindowTokens: number }): boolean;

  /**
   * Execute compaction. Implementation MUST persist its product as a
   * agent.thread_context_compacted event with `summary: ContentBlock[]`
   * filled in (via runtime.broadcast). Default: send the FULL conversation
   * (same model + system + tools as main agent's last call) to the model
   * with a "summarize the above" user message appended — Anthropic's prompt
   * cache then reads the prefix instead of recomputing it.
   */
  compact?(
    events: SessionEvent[],
    runtime: HarnessRuntime,
    ctx: {
      model: LanguageModel;
      systemPrompt: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tools: Record<string, any>;
    },
  ): Promise<void>;

  /**
   * Project events → ModelMessage[] for the next generateText call. Default:
   * eventsToMessagesAsync — strict bijection inverse of writes, with
   * agent.thread_context_compacted boundary handling and async file_id
   * resolution. Override for sliding-window / RAG / hierarchical / no-compact
   * strategies.
   *
   * Output MUST be byte-deterministic for any input — Anthropic's prompt
   * cache invalidates on any prefix byte drift.
   *
   * Sync-or-async: the union return type lets existing sync overrides
   * (e.g. AcpProxyHarness returning []) keep their shape. The default-loop
   * caller always `await`s the result so either form works.
   */
  deriveModelContext?(
    events: SessionEvent[],
    opts?: { fileFetcher?: FileResolver },
  ): ModelMessage[] | Promise<ModelMessage[]>;
}

export interface HarnessRuntime {
  history: HistoryStore;
  sandbox: SandboxExecutor;
  /**
   * Append an event to history AND broadcast to WS subscribers. The single
   * write path for harness-emitted events (model output, system_reminder,
   * compaction marker, custom marker, etc.).
   */
  broadcast: (event: SessionEvent) => void;
  /**
   * Mark the start of an in-flight LLM stream and broadcast a lifecycle
   * event to subscribers. The runtime persists the stream state to the
   * `streams` table (separate from the events log) so a deploy mid-
   * stream can be detected and the partial finalized. Lifecycle events
   * are NOT persisted to the events log — the eventual `agent.message`
   * with the same `id` is the canonical record. Idempotent on duplicate
   * start with the same id (e.g. harness retry minted a fresh id).
   */
  broadcastStreamStart: (messageId: string) => Promise<void>;
  /**
   * Append a token delta to an in-flight stream's buffer and broadcast
   * an `agent.message_chunk` event with the same message_id. Chunks are
   * buffered for restart recovery; they are NOT persisted to the events
   * log (would pollute history — the final agent.message is the source
   * of truth).
   */
  broadcastChunk: (messageId: string, delta: string) => Promise<void>;
  /**
   * Mark a stream as finished and broadcast an end lifecycle event.
   * `completed` = LLM finished cleanly; `aborted` = explicit abort or
   * harness retry minting a new id. The recovery scan uses `interrupted`
   * for streams left dangling by a runtime restart — callers shouldn't
   * pass that themselves.
   */
  broadcastStreamEnd: (
    messageId: string,
    status: "completed" | "aborted",
    errorText?: string,
  ) => Promise<void>;
  /**
   * Live thinking-block streaming. Broadcast-only — the eventual
   * `agent.thinking` event with the same `thinking_id` is the
   * persisted record. If the runtime dies mid-thinking, the
   * agent.thinking never lands and the harness retries the step (no
   * recovery work needed because nothing was committed).
   */
  broadcastThinkingStart: (thinkingId: string) => Promise<void>;
  broadcastThinkingChunk: (thinkingId: string, delta: string) => Promise<void>;
  broadcastThinkingEnd: (
    thinkingId: string,
    status: "completed" | "aborted",
  ) => Promise<void>;
  /**
   * Live tool-input streaming. `toolUseId` matches the eventual
   * `agent.tool_use` / `agent.mcp_tool_use` / `agent.custom_tool_use`
   * id. Broadcast-only — the canonical tool_use event lands once the
   * model commits the call, and recovery handles missing tool_results
   * via the existing scan (see recovery.ts).
   */
  broadcastToolInputStart: (toolUseId: string, toolName?: string) => Promise<void>;
  broadcastToolInputChunk: (toolUseId: string, delta: string) => Promise<void>;
  broadcastToolInputEnd: (
    toolUseId: string,
    status: "completed" | "aborted",
  ) => Promise<void>;
  reportUsage?: (input_tokens: number, output_tokens: number) => Promise<void>;
  /**
   * Emit an `agent.status` event — a broadcast+persisted heartbeat for
   * long-running agent progress ("working" / "blocked" / "waiting" +
   * a short summary, optional step/total_steps/detail). Mirrors the
   * `broadcast` write path (history.append + WS fan-out); the only
   * difference is this method builds the event shape for the caller.
   *
   * Purely observational: `agent.status` is intentionally NOT handled by
   * eventsToMessages/eventsToMessagesAsync, so calling this can never
   * perturb deriveModelContext's byte-deterministic output or bust
   * Anthropic's prompt cache. Optional so existing runtimes (tests,
   * NodeHarnessRuntime pre-adoption) keep compiling without it; harnesses
   * should guard with `runtime.reportStatus?.(...)`.
   */
  reportStatus?: (status: {
    state: "working" | "blocked" | "waiting";
    summary: string;
    step?: number;
    total_steps?: number;
    detail?: string;
    blocked_on?: string;
  }) => void;
  pendingConfirmations?: string[];
  abortSignal?: AbortSignal;
  /**
   * Wrap a long async operation (e.g. model fetch + stream consumption) so
   * the underlying Durable Object stays alive — refcounted keepAlive that
   * actually prevents CF eviction during the await. Without this the
   * 30s alarm-driven keepAlive heartbeat is the only thing reminding CF
   * the DO is busy, which is too coarse: CF can evict between heartbeats
   * if no request handler is on the stack and no fetch is pending in a
   * way the runtime credits.
   *
   * Implementation: SessionDO injects `(fn) => this.keepAliveWhile(fn)`
   * (cf-agents Agent.keepAliveWhile). Always returns whatever fn returns.
   */
  keepAliveWhile?: <T>(fn: () => Promise<T>) => Promise<T>;
}

export interface HarnessContext {
  agent: AgentConfig;
  userMessage: UserMessageEvent;
  /**
   * The OMA session id this turn belongs to. Optional during the transition
   * for legacy harnesses; AcpProxyHarness needs it to address the
   * RuntimeRoom DO. SessionDO populates this on every harness.run call.
   */
  session_id?: string;
  /**
   * The OMA tenant id this session belongs to. Optional during the
   * transition — AcpProxyHarness uses it to forward `x-harness-tenant` to
   * RuntimeRoom so the daemon receives the right `tenant_id` on every
   * session-scoped frame (step 2 of multi-tenant CLI bridge daemon). Other
   * harnesses ignore it. SessionDO populates this from its `state.tenant_id`.
   */
  tenant_id?: string;

  /** Platform-prepared tools: built from agent config, ready to pass to generateText. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tools: Record<string, any>;

  /** Platform-prepared model: resolved from agent config with API key. */
  model: LanguageModel;

  /**
   * Platform-augmented system prompt: agent.system + platform guidance
   * (authenticatedCommandGuidance + loopStopGuidance + sessionOutputsGuidance)
   * + sandbox environment facts (provider, paths, networking, packages) when
   * a session environment is bound + skill/memory/appendable content as
   * `<source>` blocks. Use this directly to inherit platform defaults; ignore
   * and use `rawSystemPrompt` if you want to take full control.
   */
  systemPrompt: string;

  /**
   * Just `agent.system` verbatim, no platform additions. Use this when
   * substituting a custom system prompt build path. Optional during the
   * transition; SessionDO will populate it once task #9 lands.
   */
  rawSystemPrompt?: string;

  /**
   * Platform-resolved reminders the default `onSessionInit` will inject as
   * `<system-reminder>` user.message events on first session run. Sources:
   * skill metadata, memory_store prompts, opted-in appendable_prompts.
   *
   * Custom harnesses can ignore this and inject differently — or skip
   * platform reminders entirely by overriding onSessionInit with a no-op.
   * Each reminder lands as ONE event, persisted in the events stream
   * before any user message, so it sits in the cached prefix forever.
   */
  platformReminders?: Array<{ source: string; text: string }>;

  /**
   * Resolve a `file_id` (Anthropic Managed Agents ImageBlock/DocumentBlock
   * `source.type === "file"`) into inline bytes + media type + filename for
   * the next derive cycle. SessionDO populates this with a
   * `services.files.get` + R2 fetch composition scoped to the session's
   * tenant; sub-agents and tests may leave it undefined, in which case the
   * sync projection runs and file_id sources collapse to placeholder text.
   *
   * Idempotent failure: returning `null` is the contract for "couldn't
   * resolve" (missing, deleted, permission denied, R2 fetch error) — the
   * derive layer emits a placeholder block so the turn keeps running.
   */
  fileFetcher?: FileResolver;

  /**
   * The session's environment snapshot (harness-to-environment migration).
   * `environment.config.kind === "local"` is what selects this harness in
   * the first place (SessionDO resolves "acp-proxy" from it); AcpProxyHarness
   * reads `environment.config.local` (runtime_id, acp_agent_id, working_dir,
   * branch, worktree, local_skill_blocklist) for its runtime binding —
   * replaces the removed `agent.runtime_binding`. Other harnesses ignore it.
   * Optional: sub-agent contexts and pre-migration test fixtures may leave
   * it undefined.
   */
  environment?: EnvironmentConfig;
  /**
   * Model id already resolved against the session-override formula
   * (`session.model ?? (environment.config.kind === "local"
   * ? environment.config.local.model : agent.model)`). AcpProxyHarness
   * forwards this on `session.start`; cloud harnesses use `model` (the
   * already-built LanguageModel) instead and can ignore this field.
   */
  resolvedModel?: string;
  /**
   * Reasoning-effort override already resolved against the session-override
   * formula. Only AcpProxyHarness has a defined consumer for this today.
   */
  resolvedReasoningEffort?: string;

  env: {
    ANTHROPIC_API_KEY: string;
    ANTHROPIC_BASE_URL?: string;
    ANTHROPIC_MODEL?: string;
    /** CI/CD alternative to ANTHROPIC_API_KEY for ClaudeAgentSdkHarness's
     *  CLI subprocess auth (minted via `claude setup-token`). Only
     *  consulted when ANTHROPIC_API_KEY is unset — see
     *  claude-agent-sdk-loop.ts. */
    CLAUDE_CODE_OAUTH_TOKEN?: string;
    /** Per-agent model + provider resolved from the agent's model card by
     *  the self-host Node shell (apps/main-node, issue #316). Only
     *  ClaudeAgentSdkHarness consumes it today — it maps the binding onto
     *  the CLI subprocess's ANTHROPIC_* environment. Absent (CF worker,
     *  or no card matched) → the global env vars above are used
     *  unchanged. */
    modelProvider?: ClaudeSdkModelBinding;
    OMA_MAX_OUTPUT_TOKENS?: string;
    /** Credentials for the "poolside" harness (poolside.ai's
     *  OpenAI-compatible inference API). POOLSIDE_BASE_URL defaults to
     *  https://inference.poolside.ai/v1; override it to point at a
     *  self-hosted poolside deployment's /openai/v1. See poolside-loop.ts. */
    POOLSIDE_API_KEY?: string;
    POOLSIDE_BASE_URL?: string;
    TAVILY_API_KEY?: string;
    delegateToAgent?: (agentId: string, message: string) => Promise<string>;
    /** Same delegation path as `delegateToAgent`, but also resolves the
     *  child's `session_thread_id` — used by the `call_agents_parallel`
     *  tool (buildTools) to surface per-child thread ids in its
     *  aggregated result. See tools.ts for the fallback when unset. */
    delegateToAgentDetailed?: (agentId: string, message: string) => Promise<{ text: string; threadId?: string }>;
    /**
     * Cross-instance federation, proxied-session flavour (issue #132 M1).
     * Runs ONE turn of this session against a session on a remote OMA
     * instance and streams the remote's events back through `onRemoteEvent`.
     *
     * The remote's API key never crosses this port in either direction:
     * SessionDO resolves it (CF: `MAIN_MCP.resolveFederationTarget` RPC;
     * Node: KV + crypto), uses it inside the call, and returns only the
     * remote session id + text. OmaRemoteHarness therefore cannot leak a
     * credential it never receives. Absent binding ⇒ the harness fails
     * loudly instead of falling back to a local sandbox run.
     */
    proxyRemoteTurn?: (opts: {
      instanceId: string;
      remoteAgentId: string;
      remoteEnvironmentId?: string;
      message: string;
      onRemoteEvent: (event: { seq?: number; type?: string; content?: unknown }) => void;
    }) => Promise<{ remote_session_id: string; text: string }>;
    CONFIG_KV?: KVNamespace;
    memoryStoreIds?: string[];
    environmentConfig?: { networking?: { type: string; allowed_hosts?: string[] } };
    /** Register a background task for completion notification (CC-style task_notification). */
    watchBackgroundTask?: (taskId: string, pid: string, outputFile: string, proc: ProcessHandle | null) => void;
    /** Cross-script DO binding to RuntimeRoom (declared on main worker but
     *  bound here via wrangler.jsonc `script_name`). AcpProxyHarness uses
     *  this to attach to the daemon's room without going through main as
     *  an HTTP service. */
    RUNTIME_ROOM?: DurableObjectNamespace;
    /** LLM full-body logging context. When set, the harness wraps each
     *  model call in middleware that PUTs request + response to R2 keyed
     *  by the per-step span event id. SessionDO populates this with the
     *  session's tenant + id and the FILES_BUCKET binding. Absent in
     *  test harnesses / non-CF deploys → middleware no-op. */
    llmLog?: {
      tenant_id: string;
      session_id: string;
      r2: R2Bucket | null;
    };
  };
  runtime: HarnessRuntime;
}

export interface HistoryStore {
  getMessages(): ModelMessage[];
  append(event: SessionEvent): void;
  getEvents(afterSeq?: number): SessionEvent[];
}

// SessionRegistry — Node thin shell around the unified SessionStateMachine.
//
// One SessionRegistry per process; one SessionStateMachine per active
// session, lazily created on first request. The shell's job is:
//
//   1. Hold the per-process deps (sql, hub, services, env-derived
//      config) in its closure.
//   2. Lazily build a SessionStateMachine on first access. The machine
//      itself owns the per-session sandbox + adapter.
//   3. Run a one-shot bootstrap() at process start to wake any session
//      whose row was left status='running' by a prior process (orphan
//      recovery via the unified machine.onWake path).
//
// Mirrors what apps/agent's SessionDO will become in Phase 3 (a thin
// shell around the same machine, with `alarm()` instead of bootstrap()
// as the orphan-detection trigger).
//
// Sandbox provisioning (memory mounts, /mnt/session/outputs, vault
// outbound, optional workspace-restore) is delegated to the
// SandboxOrchestrator from `@duyet/oma-sandbox/orchestrator`
// — same interface CF wires for the OmaSandbox path. Per-runtime
// mounters were removed in P5.

import { join } from "node:path";
import {
  RuntimeAdapterImpl,
  SessionStateMachine,
  resolveTurnTimeoutMs,
} from "@duyet/oma-session-runtime";
import type { SqlClient } from "@duyet/oma-sql-client";
import { SqlStreamRepo, type SqlEventLog } from "@duyet/oma-event-log/sql";
import type { SandboxExecutor } from "@duyet/oma-sandbox";
import type {
  OrchestratorMemoryMount,
  SandboxOrchestrator,
} from "@duyet/oma-sandbox/orchestrator";
import type { AgentService } from "@duyet/oma-agents-store";
import type { MemoryStoreService } from "@duyet/oma-memory-store";
import type {
  AgentConfig,
  SessionEvent,
  UserMessageEvent,
} from "@duyet/oma-shared";
import type { LanguageModel } from "ai";
import { getLogger } from "@duyet/oma-observability";
import type { EventStreamHub } from "./lib/event-stream-hub.js";

const log = getLogger("session-registry");

// Turn watchdog ceiling (issue #135) — resolved once at module load, not
// per-session, since it's process-wide config. `undefined` OMA_TURN_TIMEOUT_MS
// resolves to the 15-minute default inside resolveTurnTimeoutMs(); set it to
// "off" to disable the watchdog entirely.
const turnTimeoutMs = resolveTurnTimeoutMs(process.env.OMA_TURN_TIMEOUT_MS);

export interface SessionRegistryDeps {
  sql: SqlClient;
  hub: EventStreamHub;
  agentsService: AgentService;
  memoryService: MemoryStoreService;
  /** Sandbox provisioning — vault outbound, mounts, backup-restore.
   *  Replaces the per-runtime buildMemoryMounter / buildSessionOutputsMounter
   *  hooks from before P5. */
  sandboxOrchestrator: SandboxOrchestrator;

  /** Build the per-session event log. Mirrors main-node's existing
   *  newEventLog(sid) — keeps the stamp closure local to the shell. */
  newEventLog(sessionId: string): SqlEventLog;

  /** Build the per-session sandbox. The shell knows how to assemble a
   *  LocalSubprocess / E2B / Daytona / etc., the machine doesn't. */
  buildSandbox(sessionId: string, workdir: string): Promise<SandboxExecutor>;

  /** Build the LanguageModel for the agent. Reads env, applies custom
   *  headers, picks the right provider. */
  buildModel(agent: AgentConfig): LanguageModel;

  /** Build harness tools. Returns the tools dict the harness expects.
   *  `ctx` carries the sessionId/tenantId so the shell can thread MCP
   *  proxy routing headers (env.mcpBinding needs to know which session/
   *  tenant a tool call belongs to) without the machine itself knowing
   *  about MCP. */
  buildTools(
    agent: AgentConfig,
    sandbox: SandboxExecutor,
    ctx: { sessionId: string; tenantId: string },
  ): Promise<unknown>;

  /** Build harness instance + context. Each is platform-neutral so the
   *  machine just calls .run(ctx). */
  buildHarness(): { run: (ctx: unknown) => Promise<void> };
  buildHarnessContext(input: {
    agent: AgentConfig;
    userMessage: UserMessageEvent;
    sandbox: SandboxExecutor;
    tools: unknown;
    model: LanguageModel;
    sessionId: string;
    tenantId: string;
    eventLog: SqlEventLog;
  }): Promise<unknown>;

  /** Sandbox workdir root, e.g. /app/data/sandboxes. Per-session dirs
   *  are joined under it. */
  sandboxWorkdirRoot: string;

  /** SQL dialect under the SqlClient. Threaded through to SqlStreamRepo
   *  so its appendChunk picks the right JSON-array append (json_insert
   *  on sqlite, jsonb concat on postgres). */
  sqlDialect?: "sqlite" | "postgres";
}

interface SessionEntry {
  machine: SessionStateMachine;
  sandbox: SandboxExecutor;
  eventLog: SqlEventLog;
}

export class SessionRegistry {
  private map = new Map<string, Promise<SessionEntry>>();
  private paused = new Set<string>();

  constructor(private deps: SessionRegistryDeps) {}

  /** Whether the given session's sandbox was destroyed via pause() and
   *  hasn't been rebuilt (via getOrCreate) since. */
  isPaused(sessionId: string): boolean {
    return this.paused.has(sessionId);
  }

  /** Clear the paused marker without rebuilding the sandbox — the actual
   *  rebuild happens lazily on the next getOrCreate() (build() also
   *  clears this, so this is only needed for the resume no-op path
   *  where no request forces a rebuild immediately). */
  clearPaused(sessionId: string): void {
    this.paused.delete(sessionId);
  }

  /**
   * Get-or-create the SessionStateMachine for a session. Lazy: the
   * sandbox + adapter aren't built until first access. Cached: the same
   * machine is reused across HTTP requests (so chokidar watcher /
   * recovery / repeated user.messages all hit the same in-memory state).
   */
  async getOrCreate(sessionId: string, tenantId: string): Promise<SessionEntry> {
    let p = this.map.get(sessionId);
    if (!p) {
      p = this.build(sessionId, tenantId);
      this.map.set(sessionId, p);
    }
    return p;
  }

  /**
   * Process-startup orphan reconciliation. Reads sessions WHERE
   * status='running' and calls onWake() on each. Survivors of a prior
   * crash get their event log cleaned up (placeholder agent.message +
   * tool_result events injected) and the row flips back to 'idle'.
   *
   * No automatic re-execution of the interrupted turn — the user gets
   * a clean state and can retry by sending a new user.message. Mirrors
   * what apps/main-node did inline before this refactor.
   */
  async bootstrap(): Promise<void> {
    const r = await this.deps.sql
      .prepare(
        `SELECT id, tenant_id FROM sessions WHERE status='running' AND turn_id IS NOT NULL`,
      )
      .all<{ id: string; tenant_id: string }>();
    const rows = r.results ?? [];
    if (rows.length === 0) return;
    log.info({ op: "session_registry.bootstrap", recovering: rows.length }, `bootstrap: recovering ${rows.length} interrupted session(s)`);
    for (const row of rows) {
      const entry = await this.getOrCreate(row.id, row.tenant_id);
      try {
        await entry.machine.onWake();
      } catch (err) {
        log.error(
          { err, op: "session_registry.bootstrap.on_wake_failed", session_id: row.id },
          `bootstrap onWake(${row.id}) failed`,
        );
      }
    }
  }

  /**
   * Tear down all in-process sessions on shutdown. Best-effort; the
   * sessions row stays as-is (status='idle' for normal exits, status=
   * 'running' for kill -9, which the next bootstrap will handle).
   */
  async shutdown(): Promise<void> {
    for (const p of this.map.values()) {
      try {
        const entry = await p;
        if (entry.sandbox.destroy) await entry.sandbox.destroy();
      } catch {
        /* best-effort */
      }
    }
    this.map.clear();
  }

  /**
   * Abort the in-flight harness for a session. Routed from
   * POST /v1/sessions/:id/events when the body contains a `user.interrupt`
   * event. No-op if the session has no machine yet (nothing to interrupt).
   * The machine's adapter handles emitting the session-side
   * agent.message_stream_end(status="aborted") event chain.
   */
  /**
   * Destroy the session's sandbox to save cost while keeping it
   * resumable. Node has no container "pause" primitive — this mirrors
   * shutdown()'s per-entry teardown, then drops the map entry so the
   * next getOrCreate() rebuilds the sandbox from scratch, restoring the
   * workspace backup via SandboxOrchestrator.provision's
   * `backup: { restoreOnWarm: true }` (see build()).
   *
   * Returns `{ conflict: true }` when a turn is in-flight — callers
   * should surface a 409 rather than pausing mid-turn.
   */
  async pause(sessionId: string): Promise<{ conflict: boolean }> {
    const p = this.map.get(sessionId);
    if (!p) {
      this.paused.add(sessionId);
      return { conflict: false };
    }
    const entry = await p;
    if (entry.machine.hasInflightTurn()) {
      return { conflict: true };
    }
    try {
      if (entry.sandbox.destroy) await entry.sandbox.destroy();
    } catch {
      /* best-effort */
    }
    this.map.delete(sessionId);
    this.paused.add(sessionId);
    return { conflict: false };
  }

  interrupt(sessionId: string): void {
    const p = this.map.get(sessionId);
    if (!p) return;
    p.then((entry) => {
      const m = entry.machine as unknown as {
        interrupt?: () => void;
        abortInFlight?: () => void;
      };
      if (typeof m.interrupt === "function") m.interrupt();
      else if (typeof m.abortInFlight === "function") m.abortInFlight();
      // If the machine doesn't expose either method, the user.interrupt
      // event is appended to the log by the route handler (P3 wires the
      // actual abort plumbing into SessionStateMachine).
    }).catch(() => {
      /* getOrCreate failed — nothing to abort */
    });
  }

  // ── helpers ─────────────────────────────────────────────────────────

  private async build(
    sessionId: string,
    tenantId: string,
  ): Promise<SessionEntry> {
    this.paused.delete(sessionId);
    const sandboxWorkdir = join(this.deps.sandboxWorkdirRoot, sessionId);
    const sandbox = await this.deps.buildSandbox(sessionId, sandboxWorkdir);

    // Resolve the per-session memory bindings + outputs flag, then hand
    // the whole bundle to the orchestrator. The orchestrator owns
    // ordering (vault outbound first, restore second, mounts last) so
    // the registry no longer reasons about it.
    const memoryBindings = await this.deps.sql
      .prepare(`SELECT store_id, access FROM session_memory_stores WHERE session_id = ?`)
      .bind(sessionId)
      .all<{ store_id: string; access: string }>();
    const memoryMounts: OrchestratorMemoryMount[] = [];
    for (const binding of memoryBindings.results ?? []) {
      const store = await this.deps.memoryService.getStore({ tenantId, storeId: binding.store_id });
      if (!store) continue;
      memoryMounts.push({
        storeName: store.name,
        storeId: binding.store_id,
        readOnly: binding.access === "read_only",
      });
    }
    await this.deps.sandboxOrchestrator.provision(sandbox, {
      sessionId,
      tenantId,
      memoryMounts,
      mountOutputs: true,
      backup: { restoreOnWarm: true },
    });

    const eventLog = this.deps.newEventLog(sessionId);
    const streams = new SqlStreamRepo(this.deps.sql, sessionId, this.deps.sqlDialect ?? "sqlite");

    const adapter = new RuntimeAdapterImpl({
      sql: this.deps.sql,
      eventLog,
      streams,
      sandbox,
      // Node has no eviction — leave hintTurnInFlight unset.
    });

    const machine = new SessionStateMachine({
      sessionId,
      tenantId,
      adapter,
      sandbox,
      loadAgent: async (agentId) => {
        const row = await this.deps.agentsService.get({ tenantId, agentId });
        return row ?? null;
      },
      // Memory + outputs mounting happens in the orchestrator above.
      // SessionStateMachine still accepts the hooks for CF parity but
      // Node passes no-ops since the work has already been done.
      mountMemoryStores: async () => {},
      mountSessionOutputs: async () => {},
      buildModel: (agent) => this.deps.buildModel(agent),
      buildTools: (agent, sb) => this.deps.buildTools(agent, sb, { sessionId, tenantId }),
      buildHarness: () => this.deps.buildHarness(),
      buildHarnessContext: (input) =>
        this.deps.buildHarnessContext({
          ...input,
          sessionId,
          tenantId,
          eventLog,
        }),
      publish: (event: SessionEvent) => this.deps.hub.publish(sessionId, event),
      turnTimeoutMs,
    });

    return { machine, sandbox, eventLog };
  }
}

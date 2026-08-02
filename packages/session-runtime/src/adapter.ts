// Single RuntimeAdapter implementation, shared by CF and Node.
//
// All platform-specific details collapse into:
//   - The SqlClient passed in (CfD1SqlClient over DO storage / better-
//     sqlite3 / postgres.js — the platform decides which)
//   - The optional onTurnInFlight callback the entry shell wires (CF
//     uses it to setAlarm; Node leaves it unset)
//
// The state machine holds one of these per session and never branches on
// platform.

import type { SqlClient } from "@duyet/oma-sql-client";
import type { EventLogRepo, StreamRepo } from "@duyet/oma-event-log";
import type { SandboxExecutor } from "@duyet/oma-sandbox";
import type { SessionEvent } from "@duyet/oma-shared";
import type { OrphanTurn, RuntimeAdapter, TurnId } from "./ports";

export interface RuntimeAdapterOptions {
  sql: SqlClient;
  eventLog: EventLogRepo;
  streams: StreamRepo;
  /** Optional — only SessionStateMachine.runHarnessTurn uses this.
   *  turn-runtime.ts callers (CF SessionDO today) leave it unset. */
  sandbox?: SandboxExecutor;
  /** Per-platform shell hook. CF: setAlarm(now+30s) AND register turnId
   *  into the local active-turn set so _checkOrphanTurns can filter
   *  out the caller's own active turns (port contract; see ports.ts).
   *  Node: leave unset (SessionStateMachine tracks activeTurnId
   *  directly in runTurn). */
  onTurnInFlight?: (sessionId: string, turnId: TurnId) => void;
  /** Symmetric hook fired after endTurn's UPDATE lands. CF uses it to
   *  remove turnId from the local active-turn set so the next
   *  _checkOrphanTurns pass treats a row left behind by an out-of-band
   *  crash as a real orphan. Node leaves it unset. */
  onTurnEnded?: (sessionId: string, turnId: TurnId) => void;
}

export class RuntimeAdapterImpl implements RuntimeAdapter {
  readonly sql: SqlClient;
  readonly eventLog: EventLogRepo;
  readonly streams: StreamRepo;
  readonly sandbox?: SandboxExecutor;
  private readonly onTurnInFlight?: (sessionId: string, turnId: TurnId) => void;
  private readonly onTurnEnded?: (sessionId: string, turnId: TurnId) => void;

  constructor(opts: RuntimeAdapterOptions) {
    this.sql = opts.sql;
    this.eventLog = opts.eventLog;
    this.streams = opts.streams;
    this.sandbox = opts.sandbox;
    this.onTurnInFlight = opts.onTurnInFlight;
    this.onTurnEnded = opts.onTurnEnded;
  }

  async beginTurn(sessionId: string, turnId: TurnId): Promise<void> {
    const now = Date.now();
    await this.sql
      .prepare(
        `UPDATE sessions
            SET status='running', turn_id=?, turn_started_at=?, updated_at=?
          WHERE id=?`,
      )
      .bind(turnId, now, now, sessionId)
      .run();
  }

  async endTurn(
    sessionId: string,
    turnId: TurnId,
    status: "idle" | "destroyed",
  ): Promise<void> {
    const now = Date.now();
    // Run-history summary (issue #21): refreshed on every turn end so
    // GET /v1/agents/:id/runs can list history without replaying event
    // logs per row. stop_reason is derived from `status` alone (not
    // from the event log) so it's deterministic regardless of whether
    // the harness's session.status_idle append has landed yet on every
    // platform. See tryComputeRunSummary for why counts degrade
    // gracefully instead of blocking the status flip.
    const stopReason = status === "idle" ? "end_turn" : "destroyed";
    const counts = await this.tryComputeRunSummary();
    // Filter by turn_id so a stale endTurn (e.g. from a recovery that
    // raced with a new beginTurn) doesn't clobber a fresh run.
    if (counts) {
      await this.sql
        .prepare(
          `UPDATE sessions
              SET status=?, turn_id=NULL, turn_started_at=NULL, updated_at=?,
                  stop_reason=?, tool_call_count=?, message_count=?,
                  title=CASE WHEN title IS NULL OR title='' THEN ? ELSE title END
            WHERE id=? AND turn_id=?`,
        )
        .bind(
          status,
          now,
          stopReason,
          counts.toolCallCount,
          counts.messageCount,
          counts.summary,
          sessionId,
          turnId,
        )
        .run();
    } else {
      await this.sql
        .prepare(
          `UPDATE sessions
              SET status=?, turn_id=NULL, turn_started_at=NULL, updated_at=?
            WHERE id=? AND turn_id=?`,
        )
        .bind(status, now, sessionId, turnId)
        .run();
    }
    this.onTurnEnded?.(sessionId, turnId);
  }

  async terminate(sessionId: string, _reason: string): Promise<void> {
    const now = Date.now();
    const counts = await this.tryComputeRunSummary();
    // Idempotent: second call is a no-op because the WHERE filter only
    // matches rows that aren't already terminated. Also clears any
    // in-flight turn marker so listOrphanTurns doesn't see a ghost row.
    if (counts) {
      await this.sql
        .prepare(
          `UPDATE sessions
              SET status='terminated', terminated_at=?, turn_id=NULL,
                  turn_started_at=NULL, updated_at=?, stop_reason='terminated',
                  tool_call_count=?, message_count=?,
                  title=CASE WHEN title IS NULL OR title='' THEN ? ELSE title END
            WHERE id=? AND terminated_at IS NULL`,
        )
        .bind(now, now, counts.toolCallCount, counts.messageCount, counts.summary, sessionId)
        .run();
    } else {
      await this.sql
        .prepare(
          `UPDATE sessions
              SET status='terminated', terminated_at=?, turn_id=NULL,
                  turn_started_at=NULL, updated_at=?
            WHERE id=? AND terminated_at IS NULL`,
        )
        .bind(now, now, sessionId)
        .run();
    }
  }

  /**
   * Run-history summary (issue #21) — cumulative tool-call and message
   * totals for the whole session, plus a one-line `summary` lifted from
   * the session's first `user.message`. Recomputed from scratch on every
   * idle/destroyed/terminated transition (cheap: bounded by a session's
   * event count, and this only runs once per turn — not on the
   * GET /v1/agents/:id/runs or GET /v1/sessions read paths, which stay
   * plain indexed row scans). Recomputing from scratch (rather than
   * incrementing a stored counter) means a failed read here just leaves
   * the previous values in place next time; no drift accumulates.
   *
   * `summary` rides the SAME single event scan the counts already do, so
   * giving the sessions list a human-readable label costs no extra query
   * and — deliberately — no model call. Callers write it only into an
   * empty `title` (SQL `CASE WHEN title IS NULL OR title=''`), so a
   * caller-supplied title always wins and is never clobbered.
   *
   * Returns null — deliberately NOT {toolCallCount: 0, messageCount: 0} —
   * when the event log can't be read, so callers skip the summary
   * columns for this call instead of clobbering good data with zeros.
   * The core status-flip UPDATE must never be blocked by this.
   */
  private async tryComputeRunSummary(): Promise<
    { toolCallCount: number; messageCount: number; summary: string } | null
  > {
    try {
      const events = await this.freshEvents();
      let toolCallCount = 0;
      let messageCount = 0;
      let summary = "";
      for (const e of events) {
        switch (e.type) {
          case "agent.tool_use":
          case "agent.mcp_tool_use":
          case "agent.custom_tool_use":
            toolCallCount++;
            break;
          case "agent.message":
            messageCount++;
            break;
          case "user.message":
            if (summary === "") summary = firstUserText(e);
            break;
        }
      }
      return { toolCallCount, messageCount, summary };
    } catch {
      return null;
    }
  }

  /**
   * Prefer a fresh async read when the event log offers one. Node's
   * SqlEventLog serves sync getEvents() off an in-memory cache that's
   * only refreshed by explicit `.refresh()` calls — reading it here
   * could miss events appended earlier in the same turn. CF's
   * CfDoEventLog has no async variant; its sync getEvents() reads
   * DO-local SQLite directly and is always fresh. Same
   * cast-to-detect-getEventsAsync pattern SessionStateMachine's
   * recoverOrphan already uses (machine.ts).
   */
  private async freshEvents(): Promise<SessionEvent[]> {
    const withAsync = this.eventLog as unknown as {
      getEventsAsync?: (afterSeq?: number) => Promise<SessionEvent[]>;
    };
    if (typeof withAsync.getEventsAsync === "function") {
      return withAsync.getEventsAsync();
    }
    return this.eventLog.getEvents();
  }

  async listOrphanTurns(sessionId: string): Promise<OrphanTurn[]> {
    const r = await this.sql
      .prepare(
        `SELECT id AS session_id, turn_id, turn_started_at
           FROM sessions
          WHERE id=? AND status='running' AND turn_id IS NOT NULL`,
      )
      .bind(sessionId)
      .all<{ session_id: string; turn_id: string; turn_started_at: number }>();
    return (r.results ?? []).map((row) => ({
      session_id: row.session_id,
      turn_id: row.turn_id,
      turn_started_at: row.turn_started_at,
    }));
  }

  hintTurnInFlight(sessionId: string, turnId: TurnId): void {
    this.onTurnInFlight?.(sessionId, turnId);
  }

  hintTurnEnded(sessionId: string, turnId: TurnId): void {
    this.onTurnEnded?.(sessionId, turnId);
  }
}

/** Max stored summary length. Long enough that the sessions list can show a
 *  meaningful clause and the session detail page a full sentence; short
 *  enough that it never bloats a list-page payload. */
const SUMMARY_MAX = 200;

/**
 * One-line label lifted from a `user.message` event: the text blocks joined,
 * whitespace collapsed, truncated to SUMMARY_MAX with an ellipsis. Non-text
 * blocks (images, documents) are skipped — an image-only opening message
 * yields "" and simply leaves the title empty rather than inventing a label.
 */
function firstUserText(e: SessionEvent): string {
  const content = (e as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  const text = content
    .filter(
      (b): b is { type: "text"; text: string } =>
        typeof b === "object" &&
        b !== null &&
        (b as { type?: unknown }).type === "text" &&
        typeof (b as { text?: unknown }).text === "string",
    )
    .map((b) => b.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= SUMMARY_MAX) return text;
  return `${text.slice(0, SUMMARY_MAX - 1).trimEnd()}…`;
}

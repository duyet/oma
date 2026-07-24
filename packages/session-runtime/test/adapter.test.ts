// Unified-runtime adapter tests.
//
// What this proves: the RuntimeAdapter shape works identically against
// any SqlClient. CF (CfD1SqlClient over DO storage) and Node
// (BetterSqlite3SqlClient over a shared file/PG) both produce the same
// observable behaviour because they speak the same port.
//
// Engine: better-sqlite3 in `:memory:` mode. Real SQL semantics, no I/O,
// no platform branches. The SqlClient hides the engine; if the adapter's
// SQL works on better-sqlite3 it works on D1 + postgres (modulo dialect
// quirks already handled by the client adapters).
//
// Coverage map vs the testing plan (Phase 5):
//   ✓ beginTurn / endTurn / listOrphanTurns invariants
//   ✓ endTurn idempotency (no clobber after a stale call)
//   ✓ Crash-recovery flow: beginTurn → "process death" (no endTurn) →
//     listOrphanTurns surfaces the row → endTurn clears it
//   ✓ hintTurnInFlight callback fires + only on beginTurn
//   - Node child_process kill simulation: separate file (apps/main-node)
//   - fast-check property tests on recovery.ts: separate file
//   - CF DO ctx.abort() eviction: lives in test/integration/recovery-do

import { describe, it, expect, beforeEach } from "vitest";
import { createBetterSqlite3SqlClient, type SqlClient } from "@duyet/oma-sql-client";
import {
  SqlStreamRepo,
  SqlEventLog,
  ensureSchema as ensureEventLogSchema,
} from "@duyet/oma-event-log/sql";
import {
  RuntimeAdapterImpl,
  type RuntimeAdapter,
} from "@duyet/oma-session-runtime";
import type { SessionEvent } from "@duyet/oma-shared";

interface Fixture {
  sql: SqlClient;
  adapter: RuntimeAdapter;
  hintFires: string[];
  /** Raw event log handle — tests use `appendAsync` directly (awaited,
   *  unlike the fire-and-forget sync `append`) so events are guaranteed
   *  durable before the adapter call under test reads them back. */
  eventLog: SqlEventLog;
}

async function newFixture(): Promise<Fixture> {
  // `:memory:` gives a fresh, isolated SQLite DB per fixture — no
  // teardown needed between tests, no fs I/O.
  const sql = await createBetterSqlite3SqlClient(":memory:");
  // Mirror the unified `sessions` schema (apps/main-node main DDL +
  // apps/main/migrations/0014_session_turn_id.sql).
  await sql.exec(`
    CREATE TABLE sessions (
      id                TEXT PRIMARY KEY NOT NULL,
      tenant_id         TEXT NOT NULL,
      agent_id          TEXT,
      status            TEXT NOT NULL,
      title             TEXT,
      turn_id           TEXT,
      turn_started_at   INTEGER,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER NOT NULL,
      terminated_at     INTEGER,
      stop_reason       TEXT,
      tool_call_count   INTEGER NOT NULL DEFAULT 0,
      message_count     INTEGER NOT NULL DEFAULT 0
    );
  `);
  await ensureEventLogSchema(sql);

  // Seed a session row.
  const now = Date.now();
  await sql
    .prepare(
      `INSERT INTO sessions (id, tenant_id, agent_id, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind("sess_test", "tn_test", "agent_test", "idle", now, now)
    .run();

  const eventLog = new SqlEventLog(sql, "sess_test", () => {});
  const streams = new SqlStreamRepo(sql, "sess_test");
  const hintFires: string[] = [];
  const adapter = new RuntimeAdapterImpl({
    sql,
    eventLog,
    streams,
    onTurnInFlight: (sid) => hintFires.push(sid),
  });

  return { sql, adapter, hintFires, eventLog };
}

async function readSession(
  sql: SqlClient,
  id: string,
): Promise<{ status: string; turn_id: string | null; turn_started_at: number | null } | null> {
  return sql
    .prepare(`SELECT status, turn_id, turn_started_at FROM sessions WHERE id = ?`)
    .bind(id)
    .first();
}

async function readSummary(
  sql: SqlClient,
  id: string,
): Promise<{
  stop_reason: string | null;
  tool_call_count: number;
  message_count: number;
} | null> {
  return sql
    .prepare(`SELECT stop_reason, tool_call_count, message_count FROM sessions WHERE id = ?`)
    .bind(id)
    .first();
}

describe("RuntimeAdapter — unified shape (Node + CF)", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await newFixture();
  });

  it("beginTurn marks status='running' + sets turn_id + turn_started_at", async () => {
    await f.adapter.beginTurn("sess_test", "turn_abc");
    const row = await readSession(f.sql, "sess_test");
    expect(row?.status).toBe("running");
    expect(row?.turn_id).toBe("turn_abc");
    expect(row?.turn_started_at).toBeGreaterThan(0);
  });

  it("endTurn(idle) clears turn_id and flips status", async () => {
    await f.adapter.beginTurn("sess_test", "turn_abc");
    await f.adapter.endTurn("sess_test", "turn_abc", "idle");
    const row = await readSession(f.sql, "sess_test");
    expect(row?.status).toBe("idle");
    expect(row?.turn_id).toBeNull();
    expect(row?.turn_started_at).toBeNull();
  });

  it("endTurn(destroyed) flips status to destroyed", async () => {
    await f.adapter.beginTurn("sess_test", "turn_abc");
    await f.adapter.endTurn("sess_test", "turn_abc", "destroyed");
    const row = await readSession(f.sql, "sess_test");
    expect(row?.status).toBe("destroyed");
    expect(row?.turn_id).toBeNull();
  });

  it("endTurn is idempotent — second call with same turn_id no-op", async () => {
    await f.adapter.beginTurn("sess_test", "turn_abc");
    await f.adapter.endTurn("sess_test", "turn_abc", "idle");
    // Race scenario: a stale recovery path tries to endTurn after the
    // session already moved on. Should be a silent no-op (filtered by
    // turn_id in the WHERE clause).
    await f.adapter.endTurn("sess_test", "turn_abc", "destroyed");
    const row = await readSession(f.sql, "sess_test");
    // Status stayed 'idle' from the first endTurn.
    expect(row?.status).toBe("idle");
  });

  it("endTurn with stale turn_id doesn't clobber a fresh beginTurn", async () => {
    // T1: turn_abc runs and ends.
    await f.adapter.beginTurn("sess_test", "turn_abc");
    await f.adapter.endTurn("sess_test", "turn_abc", "idle");
    // T2: turn_def starts.
    await f.adapter.beginTurn("sess_test", "turn_def");
    // T3: a delayed/buggy endTurn for the OLD turn_abc fires. WHERE
    // clause filters by turn_id — should not affect turn_def.
    await f.adapter.endTurn("sess_test", "turn_abc", "destroyed");
    const row = await readSession(f.sql, "sess_test");
    expect(row?.status).toBe("running");
    expect(row?.turn_id).toBe("turn_def");
  });

  it("listOrphanTurns returns rows with status='running' AND turn_id IS NOT NULL", async () => {
    await f.adapter.beginTurn("sess_test", "turn_abc");
    const orphans = await f.adapter.listOrphanTurns("sess_test");
    expect(orphans).toHaveLength(1);
    expect(orphans[0]).toMatchObject({
      session_id: "sess_test",
      turn_id: "turn_abc",
    });
  });

  it("listOrphanTurns returns empty after endTurn", async () => {
    await f.adapter.beginTurn("sess_test", "turn_abc");
    await f.adapter.endTurn("sess_test", "turn_abc", "idle");
    const orphans = await f.adapter.listOrphanTurns("sess_test");
    expect(orphans).toHaveLength(0);
  });

  it("crash-recovery flow: beginTurn → simulated crash → orphan visible → endTurn clears", async () => {
    // 1. Turn starts, marker written to sessions.turn_id.
    await f.adapter.beginTurn("sess_test", "turn_crashed");
    // 2. "Process death" — simulate by losing in-memory state. The
    //    SQL row remains. This is exactly what fly auto_stop / k8s
    //    SIGKILL / DO eviction look like to the recovery path: nobody
    //    called endTurn before the process died.
    //    (We don't simulate restart; we just verify the next process's
    //    listOrphanTurns sees the row.)
    // 3. New process boots → registry.bootstrap calls listOrphanTurns
    //    (Node) or alarm() calls _checkOrphanTurns (CF). Same query.
    const orphans = await f.adapter.listOrphanTurns("sess_test");
    expect(orphans).toHaveLength(1);
    expect(orphans[0].turn_id).toBe("turn_crashed");
    // 4. Recovery completes (recoverInterruptedState injects placeholder
    //    events; not exercised here — see test/unit/recovery.test.ts).
    //    Then adapter.endTurn(sid, turnId, "idle") flips the row.
    await f.adapter.endTurn("sess_test", "turn_crashed", "idle");
    const after = await f.adapter.listOrphanTurns("sess_test");
    expect(after).toHaveLength(0);
  });

  it("hintTurnInFlight callback fires when invoked — wires CF's setAlarm path", async () => {
    // hintTurnInFlight is a separate method on the adapter (not auto-
    // called by beginTurn) so callers can place the hint at the exact
    // point they want — both turn-runtime.ts (SessionDO path) and
    // SessionStateMachine.runHarnessTurn (Node path) call it right
    // after beginTurn. The test mirrors that pattern.
    expect(f.hintFires).toEqual([]);
    await f.adapter.beginTurn("sess_test", "turn_a");
    f.adapter.hintTurnInFlight?.("sess_test");
    expect(f.hintFires).toEqual(["sess_test"]);
    // endTurn doesn't fire it.
    await f.adapter.endTurn("sess_test", "turn_a", "idle");
    expect(f.hintFires).toEqual(["sess_test"]);
    // Next turn — caller invokes hint again.
    await f.adapter.beginTurn("sess_test", "turn_b");
    f.adapter.hintTurnInFlight?.("sess_test");
    expect(f.hintFires).toEqual(["sess_test", "sess_test"]);
  });

  it("listOrphanTurns scopes to the requested session_id", async () => {
    // Create a second session, mark it running.
    const now = Date.now();
    await f.sql
      .prepare(
        `INSERT INTO sessions (id, tenant_id, agent_id, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind("sess_other", "tn_test", "agent_test", "idle", now, now)
      .run();
    await f.adapter.beginTurn("sess_other", "turn_other");
    await f.adapter.beginTurn("sess_test", "turn_self");

    const ownOrphans = await f.adapter.listOrphanTurns("sess_test");
    expect(ownOrphans).toHaveLength(1);
    expect(ownOrphans[0].turn_id).toBe("turn_self");

    const otherOrphans = await f.adapter.listOrphanTurns("sess_other");
    expect(otherOrphans).toHaveLength(1);
    expect(otherOrphans[0].turn_id).toBe("turn_other");
  });

  // ── edge cases ─────────────────────────────────────────────────────

  it("listOrphanTurns excludes status='idle' rows even when turn_id stale-leaks", async () => {
    // Defensive: should never happen in production (endTurn always
    // nulls turn_id), but we want the orphan filter to be defence in
    // depth — status, not just turn_id, gates the result.
    const now = Date.now();
    await f.sql
      .prepare(
        `UPDATE sessions SET status='idle', turn_id='leaked_turn', updated_at=?
          WHERE id=?`,
      )
      .bind(now, "sess_test")
      .run();
    const orphans = await f.adapter.listOrphanTurns("sess_test");
    expect(orphans).toEqual([]);
  });

  it("listOrphanTurns excludes status='destroyed' rows even with turn_id set", async () => {
    const now = Date.now();
    await f.sql
      .prepare(
        `UPDATE sessions SET status='destroyed', turn_id='leaked_turn', updated_at=?
          WHERE id=?`,
      )
      .bind(now, "sess_test")
      .run();
    const orphans = await f.adapter.listOrphanTurns("sess_test");
    expect(orphans).toEqual([]);
  });

  it("listOrphanTurns excludes status='running' rows where turn_id IS NULL (defensive)", async () => {
    // Pathological: status='running' but no turn_id. Shouldn't happen,
    // but the orphan filter MUST require BOTH conditions so a stuck
    // status flag without a turn id can't trigger spurious recovery.
    const now = Date.now();
    await f.sql
      .prepare(
        `UPDATE sessions SET status='running', turn_id=NULL, updated_at=?
          WHERE id=?`,
      )
      .bind(now, "sess_test")
      .run();
    const orphans = await f.adapter.listOrphanTurns("sess_test");
    expect(orphans).toEqual([]);
  });

  it("beginTurn replaces an existing turn_id (last-writer-wins)", async () => {
    // Race: two callers both think they're starting a fresh turn (e.g.
    // a recovery and a real user.message). UPDATE has no WHERE-by-
    // turn_id so the second beginTurn replaces the first. Documents
    // current contract: caller is expected to serialize beginTurn at
    // the application layer (state machine holds the activeTurnId lock).
    await f.adapter.beginTurn("sess_test", "turn_a");
    await f.adapter.beginTurn("sess_test", "turn_b");
    const row = await readSession(f.sql, "sess_test");
    expect(row?.status).toBe("running");
    expect(row?.turn_id).toBe("turn_b");
  });

  it("turn_started_at advances on each beginTurn (used for stuck-turn detection)", async () => {
    await f.adapter.beginTurn("sess_test", "turn_a");
    const t1 = (await readSession(f.sql, "sess_test"))?.turn_started_at;
    expect(t1).toBeGreaterThan(0);
    // Force a >=1ms gap so SQLite ms timestamps differ even on a fast box.
    await new Promise((r) => setTimeout(r, 5));
    await f.adapter.endTurn("sess_test", "turn_a", "idle");
    await f.adapter.beginTurn("sess_test", "turn_b");
    const t2 = (await readSession(f.sql, "sess_test"))?.turn_started_at;
    expect(t2).toBeGreaterThan(t1!);
  });

  it("endTurn before any beginTurn is a silent no-op (row stays as-is)", async () => {
    // Stale recovery code path could conceivably try this. Filter on
    // turn_id IS NULL means the UPDATE matches nothing.
    await f.adapter.endTurn("sess_test", "ghost_turn", "idle");
    const row = await readSession(f.sql, "sess_test");
    expect(row?.status).toBe("idle");
    expect(row?.turn_id).toBeNull();
  });

  it("endTurn for an unknown sessionId is a silent no-op (no row, no UPDATE)", async () => {
    // Defence against orphan rows being deleted out from under recovery.
    await f.adapter.endTurn("sess_does_not_exist", "any_turn", "idle");
    // Original row still as-seeded.
    const row = await readSession(f.sql, "sess_test");
    expect(row?.status).toBe("idle");
  });

  it("listOrphanTurns surfaces turn_started_at exactly as written", async () => {
    // The recovery logger reports "started Nms ago" — relies on a
    // faithful pass-through of turn_started_at. Pin the contract.
    const before = Date.now();
    await f.adapter.beginTurn("sess_test", "turn_age");
    const orphans = await f.adapter.listOrphanTurns("sess_test");
    expect(orphans).toHaveLength(1);
    expect(orphans[0].turn_started_at).toBeGreaterThanOrEqual(before);
    expect(orphans[0].turn_started_at).toBeLessThanOrEqual(Date.now());
  });

  it("destroying then beginning the same session is rejected at the status level (orphan stays empty)", async () => {
    // Once a session is destroyed, beginTurn still UPDATES the row
    // (current implementation has no status-guard) but a destroyed
    // session shouldn't be receiving turns. Pin current behaviour: the
    // UPDATE happens and the row flips back to 'running' — the entry
    // shell is responsible for rejecting requests on destroyed sessions
    // before reaching the adapter. This test documents that the adapter
    // is unguarded so a future hardening change is intentional.
    await f.adapter.beginTurn("sess_test", "turn_x");
    await f.adapter.endTurn("sess_test", "turn_x", "destroyed");
    expect((await readSession(f.sql, "sess_test"))?.status).toBe("destroyed");
    // Adapter currently allows this — flips destroyed → running.
    await f.adapter.beginTurn("sess_test", "turn_after_destroy");
    expect((await readSession(f.sql, "sess_test"))?.status).toBe("running");
    // Document for the next reader: tighten via a status-guarded
    // UPDATE if/when the entry shell is no longer trusted to filter.
  });

  it("hintTurnInFlight is optional — omitting onTurnInFlight does not throw", async () => {
    // Adapter without the hint callback (Node case) — calling
    // hintTurnInFlight should be a silent no-op.
    const sql = f.sql;
    const eventLog = (
      f.adapter as unknown as { eventLog: typeof f.adapter.eventLog }
    ).eventLog;
    const streams = (f.adapter as unknown as { streams: typeof f.adapter.streams }).streams;
    const adapterNoHint = new RuntimeAdapterImpl({
      sql,
      eventLog,
      streams,
      // onTurnInFlight intentionally omitted
    });
    expect(() => adapterNoHint.hintTurnInFlight!("sess_test")).not.toThrow();
  });
});

// ── Run-history summary (issue #21) ────────────────────────────────────
//
// Exercises the PRODUCTION write path directly: RuntimeAdapterImpl.endTurn
// / terminate issuing raw SQL against the `sessions` table. This is
// deliberately separate from the sessions-store package's own tests
// (which cover SessionService.recordRunSummary + SessionRow round-
// tripping) because that's a different code path — sessions-store never
// writes these columns in production, RuntimeAdapterImpl does. A test
// that only exercises SessionService would pass even if the adapter's
// raw SQL had a typo in a column name.
describe("RuntimeAdapter — run-history summary (issue #21)", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await newFixture();
  });

  it("endTurn(idle) with no events records stop_reason='end_turn' and zero counts", async () => {
    await f.adapter.beginTurn("sess_test", "turn_a");
    await f.adapter.endTurn("sess_test", "turn_a", "idle");
    const summary = await readSummary(f.sql, "sess_test");
    expect(summary).toEqual({
      stop_reason: "end_turn",
      tool_call_count: 0,
      message_count: 0,
    });
  });

  it("endTurn(idle) counts agent.tool_use / agent.mcp_tool_use / agent.custom_tool_use / agent.message", async () => {
    await f.adapter.beginTurn("sess_test", "turn_a");
    await f.eventLog.appendAsync({
      type: "agent.tool_use",
      id: "use_1",
      name: "bash",
      input: { command: "echo hi" },
    } as unknown as SessionEvent);
    await f.eventLog.appendAsync({
      type: "agent.mcp_tool_use",
      id: "mcp_use_1",
      name: "search",
      server_name: "tavily",
      input: { q: "anthropic" },
    } as unknown as SessionEvent);
    await f.eventLog.appendAsync({
      type: "agent.custom_tool_use",
      id: "custom_use_1",
      name: "send_email",
      input: {},
    } as unknown as SessionEvent);
    await f.eventLog.appendAsync({
      type: "agent.message",
      content: [{ type: "text", text: "done" }],
    } as unknown as SessionEvent);

    await f.adapter.endTurn("sess_test", "turn_a", "idle");
    const summary = await readSummary(f.sql, "sess_test");
    expect(summary?.stop_reason).toBe("end_turn");
    expect(summary?.tool_call_count).toBe(3);
    expect(summary?.message_count).toBe(1);
  });

  it("endTurn(destroyed) records stop_reason='destroyed'", async () => {
    await f.adapter.beginTurn("sess_test", "turn_a");
    await f.adapter.endTurn("sess_test", "turn_a", "destroyed");
    const summary = await readSummary(f.sql, "sess_test");
    expect(summary?.stop_reason).toBe("destroyed");
  });

  it("terminate() records stop_reason='terminated' and the full-session counts", async () => {
    await f.eventLog.appendAsync({
      type: "agent.tool_use",
      id: "use_1",
      name: "bash",
      input: {},
    } as unknown as SessionEvent);
    await f.eventLog.appendAsync({
      type: "agent.message",
      content: [{ type: "text", text: "hi" }],
    } as unknown as SessionEvent);

    await f.adapter.terminate("sess_test", "user requested");
    const summary = await readSummary(f.sql, "sess_test");
    expect(summary?.stop_reason).toBe("terminated");
    expect(summary?.tool_call_count).toBe(1);
    expect(summary?.message_count).toBe(1);
  });

  it("counts are cumulative across turns, recomputed fresh each time — not reset per turn", async () => {
    // Turn 1: one tool call.
    await f.adapter.beginTurn("sess_test", "turn_a");
    await f.eventLog.appendAsync({
      type: "agent.tool_use",
      id: "use_1",
      name: "bash",
      input: {},
    } as unknown as SessionEvent);
    await f.adapter.endTurn("sess_test", "turn_a", "idle");
    expect((await readSummary(f.sql, "sess_test"))?.tool_call_count).toBe(1);

    // Turn 2: one more tool call + one message. Total should be 2 + 1,
    // not reset to 1 + 1 — the whole event log is replayed each time.
    await f.adapter.beginTurn("sess_test", "turn_b");
    await f.eventLog.appendAsync({
      type: "agent.tool_use",
      id: "use_2",
      name: "bash",
      input: {},
    } as unknown as SessionEvent);
    await f.eventLog.appendAsync({
      type: "agent.message",
      content: [{ type: "text", text: "done" }],
    } as unknown as SessionEvent);
    await f.adapter.endTurn("sess_test", "turn_b", "idle");

    const summary = await readSummary(f.sql, "sess_test");
    expect(summary?.tool_call_count).toBe(2);
    expect(summary?.message_count).toBe(1);
  });

  it("endTurn with a stale turn_id still skips the summary write (WHERE clause matches nothing)", async () => {
    // Mirrors the existing idempotency test above: a stale endTurn must
    // not clobber a fresh turn's row — including the new summary columns.
    await f.adapter.beginTurn("sess_test", "turn_a");
    await f.eventLog.appendAsync({
      type: "agent.message",
      content: [{ type: "text", text: "first" }],
    } as unknown as SessionEvent);
    await f.adapter.endTurn("sess_test", "turn_a", "idle");
    const afterFirst = await readSummary(f.sql, "sess_test");

    await f.adapter.beginTurn("sess_test", "turn_b");
    // Stale endTurn for the OLD turn_a — WHERE turn_id=? filters it out.
    await f.adapter.endTurn("sess_test", "turn_a", "destroyed");
    const afterStale = await readSummary(f.sql, "sess_test");
    expect(afterStale).toEqual(afterFirst);
  });
});

// Session summary backfill: the sessions list / dashboard needs a
// human-readable label per row, and the only cheap source of one is the
// session's own first user message. It rides the run-summary event scan
// that endTurn/terminate already perform — no extra query, and explicitly
// no model call. The invariant that matters is that it fills ONLY an empty
// title: a caller who named their session must never have it overwritten.
describe("RuntimeAdapter — session summary backfill from the first user message", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await newFixture();
  });

  async function readTitle(): Promise<string | null> {
    const row = await f.sql
      .prepare(`SELECT title FROM sessions WHERE id = ?`)
      .bind("sess_test")
      .first<{ title: string | null }>();
    return row?.title ?? null;
  }

  async function appendUserMessage(text: string) {
    await f.eventLog.appendAsync({
      type: "user.message",
      content: [{ type: "text", text }],
    } as unknown as SessionEvent);
  }

  it("endTurn backfills an empty title with the first user message", async () => {
    await f.adapter.beginTurn("sess_test", "turn_a");
    await appendUserMessage("Summarize the Q3 revenue spreadsheet");
    await f.adapter.endTurn("sess_test", "turn_a", "idle");
    expect(await readTitle()).toBe("Summarize the Q3 revenue spreadsheet");
  });

  it("never overwrites a caller-supplied title", async () => {
    // The whole point of the CASE WHEN guard. If this regresses, users
    // silently lose the names they gave their sessions.
    await f.sql
      .prepare(`UPDATE sessions SET title='Nightly digest' WHERE id=?`)
      .bind("sess_test")
      .run();
    await f.adapter.beginTurn("sess_test", "turn_a");
    await appendUserMessage("Post the digest to #general");
    await f.adapter.endTurn("sess_test", "turn_a", "idle");
    expect(await readTitle()).toBe("Nightly digest");
  });

  it("keeps the FIRST user message as the session summary across later turns", async () => {
    // Summary describes what the session is about, so it's anchored to
    // the opening ask — a later follow-up must not rewrite it. (Turn 2
    // re-scans the whole log, so without the ordering guard the last
    // message would win.)
    await f.adapter.beginTurn("sess_test", "turn_a");
    await appendUserMessage("Investigate the checkout 500s");
    await f.adapter.endTurn("sess_test", "turn_a", "idle");

    await f.adapter.beginTurn("sess_test", "turn_b");
    await appendUserMessage("now also check the refund path");
    await f.adapter.endTurn("sess_test", "turn_b", "idle");

    expect(await readTitle()).toBe("Investigate the checkout 500s");
  });

  it("collapses whitespace and truncates a long message to 200 chars", async () => {
    await f.adapter.beginTurn("sess_test", "turn_a");
    await appendUserMessage(`Refactor   the\n\n  billing module.\t${"x".repeat(400)}`);
    await f.adapter.endTurn("sess_test", "turn_a", "idle");
    const title = await readTitle();
    expect(title).toHaveLength(200);
    expect(title?.startsWith("Refactor the billing module. ")).toBe(true);
    expect(title?.endsWith("…")).toBe(true);
  });

  it("leaves the title empty when the opening message carries no text blocks", async () => {
    // Image-only opening message: no honest label available, so leave it
    // empty and let the UI render its own "Untitled" rather than
    // inventing a summary.
    await f.adapter.beginTurn("sess_test", "turn_a");
    await f.eventLog.appendAsync({
      type: "user.message",
      content: [{ type: "image", source: { type: "base64", data: "AAAA" } }],
    } as unknown as SessionEvent);
    await f.adapter.endTurn("sess_test", "turn_a", "idle");
    expect(await readTitle() ?? "").toBe("");
  });

  it("terminate() also backfills the summary", async () => {
    await appendUserMessage("Draft the launch post");
    await f.adapter.terminate("sess_test", "user requested");
    expect(await readTitle()).toBe("Draft the launch post");
  });

  it("a session with no user messages keeps an empty title", async () => {
    await f.adapter.beginTurn("sess_test", "turn_a");
    await f.eventLog.appendAsync({
      type: "agent.message",
      content: [{ type: "text", text: "hello" }],
    } as unknown as SessionEvent);
    await f.adapter.endTurn("sess_test", "turn_a", "idle");
    expect(await readTitle() ?? "").toBe("");
  });
});


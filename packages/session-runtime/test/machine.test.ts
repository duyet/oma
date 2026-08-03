// SessionStateMachine.runHarnessTurn — turn watchdog integration (issue
// #135). Proves the watchdog is actually wired into the real turn
// lifecycle, not just correct in isolation (see watchdog.test.ts):
//
//   - A harness.run() that never resolves gets force-failed once the
//     configured ceiling elapses, as TurnWatchdogTimeoutError.
//   - The turn is still properly ended (adapter.endTurn fires, session
//     row flips back to 'idle', activeTurnId clears) even though the
//     harness itself never returned — the `finally` in runHarnessTurn
//     doesn't get skipped just because the failure came from the race
//     instead of the harness throwing directly.
//   - A harness that finishes comfortably inside the ceiling is
//     unaffected.
//   - `turnTimeoutMs: null` disables the watchdog outright (an
//     intentionally slow harness — e.g. a long agentic run — isn't
//     force-failed).
//
// Reuses the better-sqlite3 RuntimeAdapter fixture from adapter.test.ts
// so this exercises the real beginTurn/endTurn SQL, not a mock.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { createBetterSqlite3SqlClient, type SqlClient } from "@duyet/oma-sql-client";
import {
  SqlStreamRepo,
  SqlEventLog,
  ensureSchema as ensureEventLogSchema,
} from "@duyet/oma-event-log/sql";
import { RuntimeAdapterImpl, type RuntimeAdapter } from "../src/adapter";
import { SessionStateMachine, type SessionMachineDeps } from "../src/machine";
import { TurnWatchdogTimeoutError } from "../src/watchdog";
import type { AgentConfig, UserMessageEvent } from "@duyet/oma-shared";
import type { SandboxExecutor } from "@getoma/sandbox-sdk";

const AGENT: AgentConfig = {
  id: "agent_test",
  name: "Test Agent",
  model: "claude-sonnet-4-6",
  system: "You are a test agent.",
  tools: [],
};

const USER_MESSAGE: UserMessageEvent = {
  type: "user.message",
  content: [{ type: "text", text: "hi" }],
};

const FAKE_SANDBOX: SandboxExecutor = {
  exec: async () => "",
};

interface Fixture {
  sql: SqlClient;
  adapter: RuntimeAdapter;
}

async function newFixture(): Promise<Fixture> {
  const sql = await createBetterSqlite3SqlClient(":memory:");
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
  const adapter = new RuntimeAdapterImpl({ sql, eventLog, streams });

  return { sql, adapter };
}

async function readStatus(sql: SqlClient, id: string): Promise<string | undefined> {
  const row = await sql
    .prepare(`SELECT status FROM sessions WHERE id = ?`)
    .bind(id)
    .first<{ status: string }>();
  return row?.status;
}

function buildMachine(
  f: Fixture,
  opts: {
    harnessRun: () => Promise<void>;
    turnTimeoutMs?: number | null;
    logger?: SessionMachineDeps["logger"];
  },
): SessionStateMachine {
  return new SessionStateMachine({
    sessionId: "sess_test",
    tenantId: "tn_test",
    adapter: f.adapter,
    sandbox: FAKE_SANDBOX,
    loadAgent: async () => AGENT,
    buildModel: () => ({}) as never,
    buildTools: async () => ({}),
    buildHarness: () => ({ run: opts.harnessRun }),
    buildHarnessContext: async () => ({}),
    publish: () => {},
    turnTimeoutMs: opts.turnTimeoutMs,
    logger: opts.logger,
  });
}

describe("SessionStateMachine.runHarnessTurn — turn watchdog (issue #135)", () => {
  let f: Fixture;

  beforeEach(async () => {
    f = await newFixture();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("force-fails a harness that never resolves once the ceiling elapses", async () => {
    const warn = vi.fn();
    const machine = buildMachine(f, {
      harnessRun: () => new Promise<void>(() => {}), // simulated hang
      turnTimeoutMs: 5000,
      logger: { warn, log: () => {} },
    });

    const turnPromise = machine.runHarnessTurn("agent_test", USER_MESSAGE);
    const assertion = expect(turnPromise).rejects.toBeInstanceOf(TurnWatchdogTimeoutError);

    await vi.advanceTimersByTimeAsync(5000);
    await assertion;

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/turn watchdog fired/);
  });

  it("still ends the turn (session back to idle) even though the harness never returned", async () => {
    const machine = buildMachine(f, {
      harnessRun: () => new Promise<void>(() => {}),
      turnTimeoutMs: 1000,
    });

    const turnPromise = machine.runHarnessTurn("agent_test", USER_MESSAGE);
    const assertion = expect(turnPromise).rejects.toBeInstanceOf(TurnWatchdogTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;

    expect(await readStatus(f.sql, "sess_test")).toBe("idle");
    expect(machine.hasInflightTurn()).toBe(false);
  });

  it("does not fire when the harness finishes comfortably inside the ceiling", async () => {
    const machine = buildMachine(f, {
      harnessRun: async () => {
        await new Promise((r) => setTimeout(r, 10));
      },
      turnTimeoutMs: 5000,
    });

    const turnPromise = machine.runHarnessTurn("agent_test", USER_MESSAGE);
    await vi.advanceTimersByTimeAsync(10);
    await expect(turnPromise).resolves.toBeUndefined();
    expect(await readStatus(f.sql, "sess_test")).toBe("idle");
  });

  it("propagates the harness's own error unchanged when it rejects before the ceiling", async () => {
    const machine = buildMachine(f, {
      harnessRun: async () => {
        throw new Error("harness blew up");
      },
      turnTimeoutMs: 5000,
    });

    await expect(machine.runHarnessTurn("agent_test", USER_MESSAGE)).rejects.toThrow(
      "harness blew up",
    );
    expect(await readStatus(f.sql, "sess_test")).toBe("idle");
  });

  it("turnTimeoutMs: null disables the watchdog — a slow-but-legitimate harness is never force-failed", async () => {
    const machine = buildMachine(f, {
      harnessRun: async () => {
        await new Promise((r) => setTimeout(r, 20 * 60 * 1000)); // 20 min, past the 15-min default
      },
      turnTimeoutMs: null,
    });

    const turnPromise = machine.runHarnessTurn("agent_test", USER_MESSAGE);
    await vi.advanceTimersByTimeAsync(20 * 60 * 1000);
    await expect(turnPromise).resolves.toBeUndefined();
  });

  it("defaults to the 15-minute ceiling when turnTimeoutMs is left unset", async () => {
    const machine = buildMachine(f, {
      harnessRun: () => new Promise<void>(() => {}),
      // turnTimeoutMs intentionally omitted
    });

    const turnPromise = machine.runHarnessTurn("agent_test", USER_MESSAGE);
    const assertion = expect(turnPromise).rejects.toBeInstanceOf(TurnWatchdogTimeoutError);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    await assertion;
  });
});

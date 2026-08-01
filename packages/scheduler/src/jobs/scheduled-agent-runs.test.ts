import { describe, it, expect, beforeEach } from "vitest";
import { Cron } from "croner";
import {
  computeNextRunWith,
  scheduledAgentRunsTick,
  type ClaimedSchedule,
  type RecordRunInput,
  type ScheduledRunsStore,
  type ScheduledRunLauncher,
  type CronCtor,
} from "./scheduled-agent-runs";

const compute = (cron: string, tz: string, fromMs: number) =>
  computeNextRunWith(Cron as unknown as CronCtor, cron, tz, fromMs);

// ─── next_run recompute (incl. DST boundary) ────────────────────────────────

describe("computeNextRun", () => {
  it("advances to the next occurrence of a daily cron (UTC)", () => {
    const from = Date.UTC(2026, 0, 1, 12, 0, 0); // 2026-01-01T12:00Z
    const next = compute("0 15 * * *", "UTC", from);
    expect(next).toBe(Date.UTC(2026, 0, 1, 15, 0, 0));
  });

  it("returns null for a cron that never fires (Feb 30)", () => {
    const from = Date.UTC(2026, 0, 1, 0, 0, 0);
    expect(compute("0 0 30 2 *", "UTC", from)).toBeNull();
  });

  it("returns null (not a throw) for an unparseable cron", () => {
    expect(compute("not a cron", "UTC", Date.now())).toBeNull();
  });

  it("recomputes correctly across a US spring-forward DST boundary", () => {
    // US DST 2026 begins 2026-03-08. A 09:30 America/New_York daily cron is
    // -05:00 (14:30Z) before the switch and -04:00 (13:30Z) after it. The
    // recompute must honor the zone, not a fixed offset.
    const tz = "America/New_York";
    const beforeDst = compute("30 9 * * *", tz, Date.UTC(2026, 2, 7, 0, 0, 0));
    const afterDst = compute("30 9 * * *", tz, Date.UTC(2026, 2, 9, 0, 0, 0));
    expect(beforeDst).not.toBeNull();
    expect(afterDst).not.toBeNull();
    expect(new Date(beforeDst!).getUTCHours()).toBe(14); // EST
    expect(new Date(afterDst!).getUTCHours()).toBe(13); // EDT
  });
});

// ─── Faithful in-memory store mirroring the SqlClient CAS claim ──────────────

interface Row {
  id: string;
  tenantId: string;
  agentId: string;
  environmentId: string | null;
  userId: string | null;
  cron: string;
  timezone: string;
  prompt: string;
  enabled: boolean;
  nextRunAt: number | null;
  maxSessions: number;
  /** Per-schedule alert config (issue #313) — mirrors the parsed `notify`
   *  JSON column the SqlClient store hydrates onto ClaimedSchedule. */
  notify?: ClaimedSchedule["notify"];
  lastRun?: RecordRunInput;
}

/** Mirrors a durable agent_schedule_runs history row (issue #312, WP3). */
interface HistoryRow {
  scheduleId: string;
  status: RecordRunInput["status"];
  sessionId?: string | null;
  error?: string | null;
}

/** Models agent_schedules + the compare-and-set claim in-memory. `yield_`
 *  forces a microtask between select and CAS so two concurrent claimDue
 *  calls actually race (mirrors two overlapping cron ticks). */
class FakeStore implements ScheduledRunsStore {
  history: HistoryRow[] = [];

  constructor(
    public rows: Row[],
    private readonly yield_ = false,
  ) {}

  async claimDue(
    nowMs: number,
    limit: number,
    computeNextRun: (cron: string, timezone: string, fromMs: number) => number | null,
  ): Promise<ClaimedSchedule[]> {
    const due = this.rows
      .filter((r) => r.enabled && r.nextRunAt != null && r.nextRunAt <= nowMs)
      .slice(0, limit)
      .map((r) => ({ row: r, observed: r.nextRunAt }));

    const claimed: ClaimedSchedule[] = [];
    for (const { row, observed } of due) {
      const next = computeNextRun(row.cron, row.timezone, nowMs);
      if (this.yield_) await Promise.resolve();
      // CAS: only claim if next_run_at is still what we selected.
      if (row.nextRunAt !== observed) continue;
      row.nextRunAt = next;
      claimed.push({
        id: row.id,
        tenantId: row.tenantId,
        agentId: row.agentId,
        environmentId: row.environmentId,
        userId: row.userId,
        cron: row.cron,
        timezone: row.timezone,
        prompt: row.prompt,
        maxSessions: row.maxSessions,
        notify: row.notify ?? null,
      });
    }
    return claimed;
  }

  async recordRun(schedule: ClaimedSchedule, input: RecordRunInput): Promise<void> {
    const row = this.rows.find((r) => r.id === schedule.id);
    if (row) row.lastRun = input;
    this.history.push({
      scheduleId: schedule.id,
      status: input.status,
      sessionId: input.sessionId,
      error: input.error,
    });
  }
}

function row(over: Partial<Row> = {}): Row {
  return {
    id: "sch_1",
    tenantId: "t1",
    agentId: "agent_1",
    environmentId: "env_1",
    userId: "user_1",
    cron: "*/5 * * * *",
    timezone: "UTC",
    prompt: "daily digest",
    enabled: true,
    nextRunAt: Date.UTC(2026, 0, 1, 0, 0, 0),
    maxSessions: 1, // matches the DB column default (schedules.ts createSchema)
    ...over,
  };
}

const NOW = Date.UTC(2026, 0, 1, 0, 1, 0);

describe("claimDue — due selection", () => {
  it("selects only enabled rows whose next_run_at is due", async () => {
    const store = new FakeStore([
      row({ id: "due" }),
      row({ id: "future", nextRunAt: Date.UTC(2026, 0, 2, 0, 0, 0) }),
      row({ id: "disabled", enabled: false }),
      row({ id: "no-next", nextRunAt: null }),
    ]);
    const claimed = await store.claimDue(NOW, 50, compute);
    expect(claimed.map((c) => c.id)).toEqual(["due"]);
  });

  it("advances next_run_at so a second tick at the same instant re-selects nothing (idempotent)", async () => {
    const store = new FakeStore([row({ id: "due" })]);
    const first = await store.claimDue(NOW, 50, compute);
    const second = await store.claimDue(NOW, 50, compute);
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0);
    expect(store.rows[0].nextRunAt).toBeGreaterThan(NOW);
  });
});

describe("claimDue — idempotent claim under concurrent ticks", () => {
  it("two overlapping ticks racing the same row claim it exactly once", async () => {
    const store = new FakeStore([row({ id: "due" })], /* yield_ */ true);
    const [a, b] = await Promise.all([
      store.claimDue(NOW, 50, compute),
      store.claimDue(NOW, 50, compute),
    ]);
    const totalClaims = a.length + b.length;
    expect(totalClaims).toBe(1);
  });
});

// ─── tick loop: fires claimed schedules, fail-open per row ───────────────────

class FakeLauncher implements ScheduledRunLauncher {
  launched: string[] = [];
  constructor(
    private readonly failIds: Set<string> = new Set(),
    /** schedule id → in-flight session count `countActive` reports. Absent
     *  id defaults to 0 (nothing in-flight — matches a schedule whose prior
     *  run already went idle/terminated). */
    private readonly activeCounts: Map<string, number> = new Map(),
  ) {}
  async countActive(schedule: ClaimedSchedule): Promise<number> {
    return this.activeCounts.get(schedule.id) ?? 0;
  }
  async launch(schedule: ClaimedSchedule): Promise<{ sessionId: string }> {
    this.launched.push(schedule.id);
    if (this.failIds.has(schedule.id)) throw new Error("boom");
    return { sessionId: `sess_${schedule.id}` };
  }
}

describe("scheduledAgentRunsTick", () => {
  let store: FakeStore;
  beforeEach(() => {
    store = new FakeStore([
      row({ id: "a", nextRunAt: Date.UTC(2026, 0, 1, 0, 0, 0) }),
      row({ id: "b", nextRunAt: Date.UTC(2026, 0, 1, 0, 0, 0) }),
    ]);
  });

  it("fires each due schedule once and records success", async () => {
    const launcher = new FakeLauncher();
    const tick = scheduledAgentRunsTick({
      resolveStore: async () => store,
      resolveLauncher: async () => launcher,
      now: () => NOW,
    });
    await tick();
    expect(launcher.launched.sort()).toEqual(["a", "b"]);
    expect(store.rows.find((r) => r.id === "a")!.lastRun).toMatchObject({
      status: "ok",
      sessionId: "sess_a",
    });
  });

  it("is fail-open: a failing schedule records error but doesn't block others", async () => {
    const launcher = new FakeLauncher(new Set(["a"]));
    const tick = scheduledAgentRunsTick({
      resolveStore: async () => store,
      resolveLauncher: async () => launcher,
      now: () => NOW,
    });
    await tick();
    expect(store.rows.find((r) => r.id === "a")!.lastRun).toMatchObject({ status: "error" });
    expect(store.rows.find((r) => r.id === "b")!.lastRun).toMatchObject({ status: "ok" });
  });

  it("appends a durable history row for a successful fire and a failed fire (issue #312)", async () => {
    const launcher = new FakeLauncher(new Set(["a"]));
    const tick = scheduledAgentRunsTick({
      resolveStore: async () => store,
      resolveLauncher: async () => launcher,
      now: () => NOW,
    });
    await tick();
    expect(store.history).toContainEqual(
      expect.objectContaining({ scheduleId: "a", status: "error" }),
    );
    expect(store.history).toContainEqual(
      expect.objectContaining({ scheduleId: "b", status: "ok", sessionId: "sess_b" }),
    );
  });

  it("no-ops cleanly when store/launcher resolve to null", async () => {
    const tick = scheduledAgentRunsTick({
      resolveStore: async () => null,
      resolveLauncher: async () => null,
    });
    await expect(tick()).resolves.toBeUndefined();
  });
});

// ─── max_sessions concurrency cap (issue #165) ───────────────────────────────

describe("scheduledAgentRunsTick — max_sessions concurrency cap", () => {
  it("fires when the in-flight count is under max_sessions", async () => {
    const store = new FakeStore([
      row({ id: "a", nextRunAt: Date.UTC(2026, 0, 1, 0, 0, 0), maxSessions: 2 }),
    ]);
    // 1 already in-flight, cap is 2 — still room for one more.
    const launcher = new FakeLauncher(new Set(), new Map([["a", 1]]));
    const tick = scheduledAgentRunsTick({
      resolveStore: async () => store,
      resolveLauncher: async () => launcher,
      now: () => NOW,
    });
    await tick();
    expect(launcher.launched).toEqual(["a"]);
    expect(store.rows.find((r) => r.id === "a")!.lastRun).toMatchObject({
      status: "ok",
      sessionId: "sess_a",
    });
  });

  it("skips firing when the in-flight count is at max_sessions, but still advances next_run_at", async () => {
    const dueAt = Date.UTC(2026, 0, 1, 0, 0, 0);
    const store = new FakeStore([row({ id: "a", nextRunAt: dueAt, maxSessions: 1 })]);
    // 1 already in-flight, cap is 1 — at cap.
    const launcher = new FakeLauncher(new Set(), new Map([["a", 1]]));
    const tick = scheduledAgentRunsTick({
      resolveStore: async () => store,
      resolveLauncher: async () => launcher,
      now: () => NOW,
    });
    await tick();

    // Never launched — a skipped occurrence must not create a session.
    expect(launcher.launched).toEqual([]);

    const updated = store.rows.find((r) => r.id === "a")!;
    // Skipped is a distinct, explicit outcome, not lumped in with "error".
    expect(updated.lastRun).toMatchObject({ status: "skipped_concurrency" });
    // A skipped occurrence is skipped, not queued: claimDue's CAS already
    // advanced next_run_at to the next cron occurrence, same as a normal
    // fire — it must NOT be left pointing at the same due instant (which
    // would just re-select and re-skip every tick forever).
    expect(updated.nextRunAt).not.toBeNull();
    expect(updated.nextRunAt).toBeGreaterThan(dueAt);

    // A skipped_concurrency firing still gets a durable history row
    // (issue #312).
    expect(store.history).toContainEqual(
      expect.objectContaining({ scheduleId: "a", status: "skipped_concurrency" }),
    );
  });

  it("skips firing when the in-flight count exceeds max_sessions", async () => {
    const store = new FakeStore([
      row({ id: "a", nextRunAt: Date.UTC(2026, 0, 1, 0, 0, 0), maxSessions: 2 }),
    ]);
    const launcher = new FakeLauncher(new Set(), new Map([["a", 3]]));
    const tick = scheduledAgentRunsTick({
      resolveStore: async () => store,
      resolveLauncher: async () => launcher,
      now: () => NOW,
    });
    await tick();
    expect(launcher.launched).toEqual([]);
    expect(store.rows.find((r) => r.id === "a")!.lastRun).toMatchObject({
      status: "skipped_concurrency",
    });
  });

  it("enforces the cap independently per schedule in the same tick", async () => {
    const store = new FakeStore([
      row({ id: "at-cap", nextRunAt: Date.UTC(2026, 0, 1, 0, 0, 0), maxSessions: 1 }),
      row({ id: "under-cap", nextRunAt: Date.UTC(2026, 0, 1, 0, 0, 0), maxSessions: 1 }),
    ]);
    const launcher = new FakeLauncher(
      new Set(),
      new Map([
        ["at-cap", 1],
        ["under-cap", 0],
      ]),
    );
    const tick = scheduledAgentRunsTick({
      resolveStore: async () => store,
      resolveLauncher: async () => launcher,
      now: () => NOW,
    });
    await tick();
    expect(launcher.launched).toEqual(["under-cap"]);
    expect(store.rows.find((r) => r.id === "at-cap")!.lastRun).toMatchObject({
      status: "skipped_concurrency",
    });
    expect(store.rows.find((r) => r.id === "under-cap")!.lastRun).toMatchObject({
      status: "ok",
    });
  });
});

// ─── per-schedule alerts: onRunRecorded + the `on` filter (issue #313) ───────

const target = { type: "slack_message", credential_id: "cred_1", channel: "C1" } as const;
const DUE = Date.UTC(2026, 0, 1, 0, 0, 0);

/** Collect every (scheduleId, status) the tick hands to onRunRecorded. */
function recorder() {
  const seen: Array<{ id: string; status: RecordRunInput["status"] }> = [];
  return {
    seen,
    onRunRecorded: (schedule: ClaimedSchedule, run: RecordRunInput) => {
      seen.push({ id: schedule.id, status: run.status });
    },
  };
}

describe("onRunRecorded — per-schedule alerts", () => {
  it("is not called at all for a schedule with no notify config", async () => {
    const store = new FakeStore([row({ id: "a", nextRunAt: DUE })]);
    const rec = recorder();
    await scheduledAgentRunsTick({
      resolveStore: async () => store,
      resolveLauncher: async () => new FakeLauncher(),
      onRunRecorded: rec.onRunRecorded,
      now: () => NOW,
    })();
    expect(rec.seen).toEqual([]);
  });

  it("defaults to alerting on error + skipped_concurrency only (no `on`)", async () => {
    const notify = { targets: [target] };
    const store = new FakeStore([
      row({ id: "ok", nextRunAt: DUE, notify }),
      row({ id: "err", nextRunAt: DUE, notify }),
      row({ id: "skip", nextRunAt: DUE, notify, maxSessions: 1 }),
    ]);
    const launcher = new FakeLauncher(new Set(["err"]), new Map([["skip", 1]]));
    const rec = recorder();
    await scheduledAgentRunsTick({
      resolveStore: async () => store,
      resolveLauncher: async () => launcher,
      onRunRecorded: rec.onRunRecorded,
      now: () => NOW,
    })();
    // "ok" fired successfully but is not in the default `on` set.
    expect(rec.seen).toEqual([
      { id: "err", status: "error" },
      { id: "skip", status: "skipped_concurrency" },
    ]);
  });

  it("honors an explicit `on` filter (ok-only opts into success alerts)", async () => {
    const notify = { on: ["ok" as const], targets: [target] };
    const store = new FakeStore([
      row({ id: "ok", nextRunAt: DUE, notify }),
      row({ id: "err", nextRunAt: DUE, notify }),
    ]);
    const rec = recorder();
    await scheduledAgentRunsTick({
      resolveStore: async () => store,
      resolveLauncher: async () => new FakeLauncher(new Set(["err"])),
      onRunRecorded: rec.onRunRecorded,
      now: () => NOW,
    })();
    expect(rec.seen).toEqual([{ id: "ok", status: "ok" }]);
  });

  it("skips a notify config with an empty targets array", async () => {
    const store = new FakeStore([
      row({ id: "err", nextRunAt: DUE, notify: { on: ["error"], targets: [] } }),
    ]);
    const rec = recorder();
    await scheduledAgentRunsTick({
      resolveStore: async () => store,
      resolveLauncher: async () => new FakeLauncher(new Set(["err"])),
      onRunRecorded: rec.onRunRecorded,
      now: () => NOW,
    })();
    expect(rec.seen).toEqual([]);
  });

  it("never lets a throwing notifier fail the tick or the other schedules", async () => {
    const notify = { on: ["ok" as const], targets: [target] };
    const store = new FakeStore([
      row({ id: "a", nextRunAt: DUE, notify }),
      row({ id: "b", nextRunAt: DUE, notify }),
    ]);
    const launcher = new FakeLauncher();
    const seen: string[] = [];
    await expect(
      scheduledAgentRunsTick({
        resolveStore: async () => store,
        resolveLauncher: async () => launcher,
        onRunRecorded: async (schedule) => {
          seen.push(schedule.id);
          throw new Error("notify upstream down");
        },
        now: () => NOW,
      })(),
    ).resolves.toBeUndefined();
    // Both schedules fired and both notifications were attempted.
    expect(launcher.launched).toEqual(["a", "b"]);
    expect(seen).toEqual(["a", "b"]);
    expect(store.rows.every((r) => r.lastRun?.status === "ok")).toBe(true);
  });
});

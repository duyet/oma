// Scheduled agent runs — the user-facing "run this agent on a schedule"
// tick (issue #77).
//
// Each per-minute cron tick:
//   1. Selects due schedules (enabled AND next_run_at <= now).
//   2. Claims each row idempotently — a compare-and-set that advances
//      next_run_at to the *next* cron occurrence in the same statement.
//      Only the tick whose UPDATE matched the old next_run_at wins the
//      claim, so overlapping ticks or multiple Node replicas can't
//      double-fire the same occurrence.
//   3. Launches a session for the claimed schedule (the configured prompt
//      injected as a user.message — no human turn required), reusing the
//      host's existing session-creation path.
//   4. Records last_run status/error on the row.
//
// Fail-open per schedule: one bad row (bad cron, launch failure) is logged
// and skipped, never blocking the others. Mirrors linear-dispatch.ts.
//
// The store + launcher are ports so this stays host-agnostic and unit
// testable; the CF host wires the concrete SqlClient store (agent_schedules
// in MAIN_DB) and a launcher over the internal session-create path.

import { getLogger } from "@duyet/oma-observability";
import type { ScheduleNotifyInput } from "@duyet/oma-api-types";
import { DEFAULT_SCHEDULE_NOTIFY_ON } from "@duyet/oma-api-types";

const log = getLogger("scheduler.scheduled-agent-runs");

/** A schedule the tick has *claimed* and is responsible for firing once. */
export interface ClaimedSchedule {
  id: string;
  tenantId: string;
  agentId: string;
  environmentId: string | null;
  userId: string | null;
  cron: string;
  timezone: string;
  prompt: string;
  /** Concurrency cap (1-100, default 1) — see AGENTS.md "Agent Schedules".
   *  Enforced by the tick against {@link ScheduledRunLauncher.countActive}
   *  before calling {@link ScheduledRunLauncher.launch} (issue #165). */
  maxSessions: number;
  /** Per-schedule alert config, parsed from the `notify` JSON column
   *  (issue #313). Null/absent = this schedule raises no alerts. */
  notify?: ScheduleNotifyInput | null;
}

export interface RecordRunInput {
  /** "skipped_concurrency" — claimed, next_run_at advanced, but NOT launched
   *  because `maxSessions` in-flight sessions already exist for this
   *  schedule (issue #165). A skipped occurrence is skipped, not queued —
   *  it does not retry; the next cron occurrence gets its own chance. */
  status: "ok" | "error" | "skipped_concurrency";
  error?: string | null;
  sessionId?: string | null;
  ranAtMs: number;
}

export interface ScheduledRunsStore {
  /**
   * Atomically select-and-claim up to `limit` due schedules. The claim MUST
   * advance next_run_at to the next occurrence within the same compare-and-set
   * so a concurrent tick can't re-select the same row. Returns only the rows
   * this caller won.
   *
   * `computeNextRun` is passed in so the store can advance next_run_at from
   * the cron+timezone without owning cron parsing.
   */
  claimDue(
    nowMs: number,
    limit: number,
    computeNextRun: (cron: string, timezone: string, fromMs: number) => number | null,
  ): Promise<ClaimedSchedule[]>;

  /** Persist the outcome of a fired schedule (last_run_* columns) and, best
   *  effort, append a durable history row (issue #312, WP3). */
  recordRun(schedule: ClaimedSchedule, input: RecordRunInput): Promise<void>;
}

export interface ScheduledRunLauncher {
  /** Create a session for the schedule and inject `prompt` as a user.message.
   *  Returns the created session id. Throws on failure (caught per-row). */
  launch(schedule: ClaimedSchedule): Promise<{ sessionId: string }>;

  /**
   * Count sessions this schedule previously launched that are still
   * in-flight — `status IN ('running', 'rescheduling')`. `idle` is
   * deliberately excluded: a scheduled run that finished its turn and went
   * idle is done, not occupying a concurrency slot, so future occurrences
   * must still be able to fire (otherwise a `max_sessions: 1` schedule
   * would only ever fire once). `terminated` sessions are likewise done.
   * The tick calls this before {@link launch} and skips firing when the
   * count is already `>= maxSessions` (issue #165).
   */
  countActive(schedule: ClaimedSchedule): Promise<number>;
}

export interface ScheduledAgentRunsTickDeps {
  /** Per-tick store resolver. Async so hosts can lazy-build. A thrown/`null`
   *  resolve is swallowed at the tick boundary; cron keeps ticking. */
  resolveStore: () => Promise<ScheduledRunsStore | null>;
  /** Per-tick launcher resolver. Same swallow semantics as `resolveStore`. */
  resolveLauncher: () => Promise<ScheduledRunLauncher | null>;
  /**
   * Called after every `recordRun` — ok, error, and skipped_concurrency
   * alike — so a host can raise per-schedule alerts (issue #313). Only
   * invoked for schedules that carry a `notify` config whose `on` filter
   * (default `["error", "skipped_concurrency"]`) includes the outcome, so
   * the common no-alert schedule costs nothing.
   *
   * Purely observational: the call is try/caught and a rejection is logged
   * and swallowed — a notification failure must never fail a firing or
   * abort the batch.
   */
  onRunRecorded?: (schedule: ClaimedSchedule, run: RecordRunInput) => void | Promise<void>;
  /** Cap schedules fired per tick. Default 50. */
  limit?: number;
  /** Injectable clock for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Compute the next cron occurrence strictly after `fromMs`, honoring
 * `timezone` (IANA name, e.g. "America/New_York") so DST transitions land
 * correctly. Returns epoch ms, or null when the cron never fires again /
 * is unparseable.
 *
 * Uses `croner` (pure JS, runs identically on Workers and Node) via a lazy
 * import so consumers that never fire schedules don't pay for it.
 */
export async function computeNextRunAsync(
  cron: string,
  timezone: string,
  fromMs: number,
): Promise<number | null> {
  const { Cron } = await import(/* @vite-ignore */ "croner");
  return computeNextRunWith(Cron as CronCtor, cron, timezone, fromMs);
}

// The croner surface we depend on — kept minimal so the import shape is
// obvious and the sync helper below is trivially testable with a fake.
export interface CronInstanceLike {
  nextRun(from?: Date): Date | null;
}
export interface CronCtor {
  new (pattern: string, options: { timezone?: string }): CronInstanceLike;
}

export function computeNextRunWith(
  Cron: CronCtor,
  cron: string,
  timezone: string,
  fromMs: number,
): number | null {
  try {
    const c = new Cron(cron, { timezone: timezone || "UTC" });
    const next = c.nextRun(new Date(fromMs));
    return next ? next.getTime() : null;
  } catch (err) {
    log.warn({ err, cron, timezone, op: "scheduled-runs.bad_cron" }, "unparseable cron");
    return null;
  }
}

/**
 * Should this firing outcome raise a per-schedule alert? True only when the
 * schedule carries at least one notify target AND the outcome is listed in
 * `notify.on` (defaulting to {@link DEFAULT_SCHEDULE_NOTIFY_ON} when absent).
 */
export function shouldNotifyRun(schedule: ClaimedSchedule, status: RecordRunInput["status"]): boolean {
  const notify = schedule.notify;
  if (!notify || !notify.targets || notify.targets.length === 0) return false;
  const on = notify.on && notify.on.length > 0 ? notify.on : DEFAULT_SCHEDULE_NOTIFY_ON;
  return (on as readonly string[]).includes(status);
}

export function scheduledAgentRunsTick(deps: ScheduledAgentRunsTickDeps): () => Promise<void> {
  const limit = deps.limit ?? 50;
  const now = deps.now ?? (() => Date.now());

  // Fire the host's alert hook for one recorded run. Never throws: alerts
  // are observational, so a bad target or a dead upstream can't affect the
  // firing that produced them.
  const notifyRun = async (schedule: ClaimedSchedule, run: RecordRunInput): Promise<void> => {
    if (!deps.onRunRecorded) return;
    if (!shouldNotifyRun(schedule, run.status)) return;
    try {
      await deps.onRunRecorded(schedule, run);
    } catch (err) {
      log.warn(
        { err, schedule_id: schedule.id, status: run.status, op: "scheduled-runs.notify_failed" },
        "per-schedule notification failed",
      );
    }
  };

  return async () => {
    const startedAt = now();
    let store: ScheduledRunsStore | null;
    let launcher: ScheduledRunLauncher | null;
    try {
      store = await deps.resolveStore();
      launcher = await deps.resolveLauncher();
    } catch (err) {
      log.warn({ err, op: "scheduled-runs.resolve_failed" }, "resolve failed");
      return;
    }
    if (!store || !launcher) return;

    const { Cron } = await import(/* @vite-ignore */ "croner").catch((err) => {
      log.warn({ err, op: "scheduled-runs.croner_missing" }, "croner unavailable");
      return { Cron: null };
    });
    if (!Cron) return;
    const compute = (cron: string, tz: string, fromMs: number) =>
      computeNextRunWith(Cron as CronCtor, cron, tz, fromMs);

    let claimed: ClaimedSchedule[];
    try {
      claimed = await store.claimDue(startedAt, limit, compute);
    } catch (err) {
      log.error({ err, op: "scheduled-runs.claim_failed" }, "claimDue failed");
      return;
    }

    let ok = 0;
    let failed = 0;
    let skipped = 0;
    for (const schedule of claimed) {
      const ranAtMs = now();
      try {
        // Concurrency gate (issue #165): next_run_at was already advanced by
        // claimDue's CAS above regardless of what happens next, so a skip
        // here correctly means "this occurrence is skipped, not queued" —
        // the schedule's next cron occurrence gets its own fresh check.
        const activeCount = await launcher.countActive(schedule);
        if (activeCount >= schedule.maxSessions) {
          skipped += 1;
          log.info(
            {
              schedule_id: schedule.id,
              agent_id: schedule.agentId,
              active_count: activeCount,
              max_sessions: schedule.maxSessions,
              op: "scheduled-runs.skipped_concurrency",
            },
            "schedule fire skipped: concurrency cap reached",
          );
          const skippedRun: RecordRunInput = { status: "skipped_concurrency", ranAtMs };
          await store.recordRun(schedule, skippedRun);
          await notifyRun(schedule, skippedRun);
          continue;
        }

        const { sessionId } = await launcher.launch(schedule);
        const okRun: RecordRunInput = { status: "ok", sessionId, ranAtMs };
        await store.recordRun(schedule, okRun);
        await notifyRun(schedule, okRun);
        ok += 1;
      } catch (err) {
        failed += 1;
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { err, schedule_id: schedule.id, agent_id: schedule.agentId, op: "scheduled-runs.fire_failed" },
          "schedule fire failed",
        );
        // Best-effort — recording the failure must not itself abort the batch.
        const errorRun: RecordRunInput = { status: "error", error: message, ranAtMs };
        try {
          await store.recordRun(schedule, errorRun);
        } catch (recordErr) {
          log.warn(
            { err: recordErr, schedule_id: schedule.id, op: "scheduled-runs.record_failed" },
            "recordRun failed",
          );
        }
        // Alert even when the history write failed — the operator cares
        // about the failed firing, not about our bookkeeping.
        await notifyRun(schedule, errorRun);
      }
    }

    if (claimed.length > 0) {
      log.info(
        { op: "scheduled-runs.tick", claimed: claimed.length, ok, skipped, failed, dur_ms: now() - startedAt },
        "scheduled-agent-runs tick complete",
      );
    }
  };
}

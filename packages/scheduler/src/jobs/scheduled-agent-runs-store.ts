// SqlClient-backed store for scheduled agent runs (issue #77).
//
// agent_schedules lives in the single shared control-plane DB (MAIN_DB on
// CF). This adapter is dialect-neutral — it only uses the SqlClient port,
// so the same code runs on D1 (CF) and better-sqlite3 / postgres (Node).
//
// next_run_at is stored as an ISO-8601 TEXT string (matching created_at):
// ISO-8601 sorts lexicographically, so `next_run_at <= ?` string comparison
// is a correct time comparison.

import { nanoid } from "nanoid";
import type { SqlClient } from "@duyet/oma-sql-client";
import { getLogger } from "@duyet/oma-observability";
import type {
  ClaimedSchedule,
  RecordRunInput,
  ScheduledRunsStore,
} from "./scheduled-agent-runs";

const log = getLogger("scheduler.scheduled-agent-runs-store");

interface DueRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  environment_id: string | null;
  user_id: string | null;
  cron_expression: string;
  timezone: string | null;
  input: string;
  next_run_at: string;
  max_sessions: number;
}

export class SqlClientScheduledRunsStore implements ScheduledRunsStore {
  constructor(private readonly db: SqlClient) {}

  async claimDue(
    nowMs: number,
    limit: number,
    computeNextRun: (cron: string, timezone: string, fromMs: number) => number | null,
  ): Promise<ClaimedSchedule[]> {
    const nowIso = new Date(nowMs).toISOString();

    const candidates = await this.db
      .prepare(
        `SELECT id, tenant_id, agent_id, environment_id, user_id, cron_expression, timezone, input, next_run_at, max_sessions
         FROM agent_schedules
         WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?
         ORDER BY next_run_at ASC
         LIMIT ?`,
      )
      .bind(nowIso, limit)
      .all<DueRow>();

    const rows = candidates.results ?? [];
    const claimed: ClaimedSchedule[] = [];

    for (const row of rows) {
      const timezone = row.timezone || "UTC";
      const nextMs = computeNextRun(row.cron_expression, timezone, nowMs);
      // null → cron never fires again (or unparseable): park the row by
      // nulling next_run_at so it stops being selected, but keep it claimed
      // via the same CAS so exactly one tick advances it.
      const nextIso = nextMs != null ? new Date(nextMs).toISOString() : null;

      // Compare-and-set: only the tick whose old next_run_at still matches
      // wins. A concurrent tick that already advanced this row sees changes=0.
      const res = await this.db
        .prepare(
          `UPDATE agent_schedules
           SET next_run_at = ?
           WHERE id = ? AND next_run_at = ? AND enabled = 1`,
        )
        .bind(nextIso, row.id, row.next_run_at)
        .run();

      if ((res.meta?.changes ?? 0) === 1) {
        claimed.push({
          id: row.id,
          tenantId: row.tenant_id,
          agentId: row.agent_id,
          environmentId: row.environment_id,
          userId: row.user_id,
          cron: row.cron_expression,
          timezone,
          prompt: row.input,
          maxSessions: row.max_sessions,
        });
      }
    }

    return claimed;
  }

  async recordRun(schedule: ClaimedSchedule, input: RecordRunInput): Promise<void> {
    const ranAtIso = new Date(input.ranAtMs).toISOString();
    await this.db
      .prepare(
        `UPDATE agent_schedules
         SET last_run_at = ?, last_run_status = ?, last_run_error = ?, last_session_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .bind(ranAtIso, input.status, input.error ?? null, input.sessionId ?? null, ranAtIso, schedule.id)
      .run();

    // Durable per-firing history row (issue #312, WP3). Best-effort — a
    // failure here must never take down last_run_* recording above, which
    // is what the tick's concurrency gate and Console "last run" surface
    // depend on.
    try {
      const runId = `srun_${nanoid(24)}`;
      await this.db
        .prepare(
          `INSERT INTO agent_schedule_runs
             (id, schedule_id, tenant_id, agent_id, session_id, status, error, summary, started_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          runId,
          schedule.id,
          schedule.tenantId,
          schedule.agentId,
          input.sessionId ?? null,
          input.status,
          input.error ?? null,
          null,
          ranAtIso,
          ranAtIso,
        )
        .run();
    } catch (err) {
      log.warn(
        { err, schedule_id: schedule.id, op: "scheduled-agent-runs.history_insert_failed" },
        "failed to write agent_schedule_runs history row",
      );
    }
  }
}

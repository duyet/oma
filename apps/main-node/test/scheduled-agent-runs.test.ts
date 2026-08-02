// Scheduled agent runs on the self-host Node runtime (issue #262).
//
// Exercises the real pieces the Node deployment wires together:
//   1. The 0006_agent_schedules migration applies cleanly on the sqlite
//      dialect (drizzle migrate over apps/main-node/migrations-sqlite).
//   2. SqlClientScheduledRunsStore.claimDue selects + CAS-advances a due row.
//   3. scheduledAgentRunsTick fires the launcher and records the outcome —
//      the same tick + store the CF deployment uses, so we only assert the
//      Node-specific store/launcher glue rather than re-testing tick logic.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { createBetterSqlite3SqlClient, type SqlClient } from "@duyet/oma-sql-client";
import BetterSqlite3 from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scheduledAgentRunsTick } from "@duyet/oma-scheduler/jobs/scheduled-agent-runs";
import { SqlClientScheduledRunsStore } from "@duyet/oma-scheduler/jobs/scheduled-agent-runs-store";
import type { ScheduledRunLauncher } from "@duyet/oma-scheduler/jobs/scheduled-agent-runs";
import { scheduledDeploymentRunsTick } from "@duyet/oma-scheduler/jobs/scheduled-deployment-runs";
import { SqlClientScheduledDeploymentRunsStore } from "@duyet/oma-scheduler/jobs/scheduled-deployment-runs-store";
import type { ScheduledDeploymentRunLauncher } from "@duyet/oma-scheduler/jobs/scheduled-deployment-runs";

const migrationsFolder = fileURLToPath(
  new URL("../migrations-sqlite", import.meta.url),
);

async function insertSchedule(
  sql: SqlClient,
  overrides: Partial<{
    id: string;
    tenantId: string;
    agentId: string;
    environmentId: string;
    input: string;
    nextRunAt: string;
    maxSessions: number;
    enabled: number;
  }> = {},
) {
  const now = new Date().toISOString();
  const row = {
    id: overrides.id ?? "sch_test1",
    agentId: overrides.agentId ?? "agent_1",
    tenantId: overrides.tenantId ?? "tn_1",
    input: overrides.input ?? "ping the world",
    environmentId: overrides.environmentId ?? "env_1",
    // Due: one minute in the past so claimDue selects it.
    nextRunAt: overrides.nextRunAt ?? new Date(Date.now() - 60_000).toISOString(),
    maxSessions: overrides.maxSessions ?? 1,
    enabled: overrides.enabled ?? 1,
  };
  await sql
    .prepare(
      `INSERT INTO agent_schedules
         (id, agent_id, tenant_id, cron_expression, input, environment_id, user_id, timezone, next_run_at, max_sessions, enabled, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.agentId,
      row.tenantId,
      "* * * * *",
      row.input,
      row.environmentId,
      "user_1",
      "UTC",
      row.nextRunAt,
      row.maxSessions,
      row.enabled,
      now,
      now,
    )
    .run();
  return row;
}

describe("scheduled-agent-runs on Node", () => {
  let sql: SqlClient;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "oma-sched-"));
    const dbPath = join(tmpDir, "sched.db");
    const raw = new BetterSqlite3(dbPath);
    raw.exec("PRAGMA foreign_keys = OFF");
    migrate(drizzle(raw), { migrationsFolder });
    raw.close();
    sql = await createBetterSqlite3SqlClient(dbPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("migration creates the agent_schedules table with firing columns", async () => {
    // A successful insert of every firing column proves the migration ran.
    await insertSchedule(sql);
    const row = await sql
      .prepare("SELECT id, next_run_at, enabled FROM agent_schedules WHERE id = ?")
      .bind("sch_test1")
      .first<{ id: string; next_run_at: string; enabled: number }>();
    expect(row?.id).toBe("sch_test1");
    expect(row?.enabled).toBe(1);
  });

  it("fires a due schedule and records last_run_status=ok", async () => {
    const seed = await insertSchedule(sql);
    const launched: Array<{ agentId: string; prompt: string; tenantId: string }> = [];
    const launcher: ScheduledRunLauncher = {
      async countActive() {
        return 0;
      },
      async launch(schedule) {
        launched.push({
          agentId: schedule.agentId,
          prompt: schedule.prompt,
          tenantId: schedule.tenantId,
        });
        return { sessionId: "sess_launched" };
      },
    };

    const tick = scheduledAgentRunsTick({
      resolveStore: async () => new SqlClientScheduledRunsStore(sql),
      resolveLauncher: async () => launcher,
    });
    await tick();

    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({
      agentId: "agent_1",
      tenantId: "tn_1",
      prompt: "ping the world",
    });

    const row = await sql
      .prepare(
        "SELECT last_run_status, last_session_id, next_run_at FROM agent_schedules WHERE id = ?",
      )
      .bind("sch_test1")
      .first<{ last_run_status: string; last_session_id: string; next_run_at: string }>();
    expect(row?.last_run_status).toBe("ok");
    expect(row?.last_session_id).toBe("sess_launched");
    // next_run_at was CAS-advanced past the seeded (due) value.
    expect(row?.next_run_at).not.toBe(seed.nextRunAt);
    expect(Date.parse(row!.next_run_at)).toBeGreaterThan(Date.parse(seed.nextRunAt));

    // Durable history row (issue #312, WP3).
    const historyRow = await sql
      .prepare("SELECT * FROM agent_schedule_runs WHERE schedule_id = ?")
      .bind("sch_test1")
      .first<{ status: string; session_id: string; tenant_id: string; agent_id: string }>();
    expect(historyRow?.status).toBe("ok");
    expect(historyRow?.session_id).toBe("sess_launched");
    expect(historyRow?.tenant_id).toBe("tn_1");
    expect(historyRow?.agent_id).toBe("agent_1");
  });

  it("skips firing when the max_sessions concurrency cap is reached", async () => {
    await insertSchedule(sql, { maxSessions: 1 });
    let launchCalls = 0;
    const launcher: ScheduledRunLauncher = {
      async countActive() {
        return 1; // already at the cap
      },
      async launch() {
        launchCalls += 1;
        return { sessionId: "should_not_happen" };
      },
    };

    const tick = scheduledAgentRunsTick({
      resolveStore: async () => new SqlClientScheduledRunsStore(sql),
      resolveLauncher: async () => launcher,
    });
    await tick();

    expect(launchCalls).toBe(0);
    const row = await sql
      .prepare("SELECT last_run_status FROM agent_schedules WHERE id = ?")
      .bind("sch_test1")
      .first<{ last_run_status: string }>();
    expect(row?.last_run_status).toBe("skipped_concurrency");

    // Skipped firings still get a durable history row (issue #312, WP3).
    const historyRow = await sql
      .prepare("SELECT status FROM agent_schedule_runs WHERE schedule_id = ?")
      .bind("sch_test1")
      .first<{ status: string }>();
    expect(historyRow?.status).toBe("skipped_concurrency");
  });

  it("fires a schedule-triggered deployment and records last_run_status=ok", async () => {
    // The 0007_deployments migration must have created the table (else this
    // insert throws), and the shared deployment tick + CAS store must select
    // and fire the due row.
    const now = new Date().toISOString();
    const due = new Date(Date.now() - 60_000).toISOString();
    await sql
      .prepare(
        `INSERT INTO deployments
           (id, tenant_id, name, agent_id, environment_id, vault_ids, memory_store_ids,
            initial_message, trigger, enabled, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "dep_1",
        "tn_1",
        "Nightly",
        "agent_1",
        "env_1",
        JSON.stringify(["vlt_1"]),
        JSON.stringify(["ms_1"]),
        "post the digest",
        JSON.stringify({ type: "schedule", cron_expression: "* * * * *", timezone: "UTC" }),
        1,
        due,
        now,
        now,
      )
      .run();

    const launched: Array<{ id: string; message: string; vaults: string[] }> = [];
    const launcher: ScheduledDeploymentRunLauncher = {
      async launch(deployment) {
        launched.push({
          id: deployment.id,
          message: deployment.initialMessage,
          vaults: deployment.vaultIds,
        });
        return { sessionId: "sess_dep" };
      },
    };

    const tick = scheduledDeploymentRunsTick({
      resolveStore: async () => new SqlClientScheduledDeploymentRunsStore(sql),
      resolveLauncher: async () => launcher,
    });
    await tick();

    expect(launched).toHaveLength(1);
    expect(launched[0]).toMatchObject({
      id: "dep_1",
      message: "post the digest",
      vaults: ["vlt_1"],
    });

    const row = await sql
      .prepare("SELECT last_run_status, last_session_id, next_run_at FROM deployments WHERE id = ?")
      .bind("dep_1")
      .first<{ last_run_status: string; last_session_id: string; next_run_at: string }>();
    expect(row?.last_run_status).toBe("ok");
    expect(row?.last_session_id).toBe("sess_dep");
    expect(Date.parse(row!.next_run_at)).toBeGreaterThan(Date.parse(due));
  });
});

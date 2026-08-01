// Agent schedules CRUD — shared across CF (apps/main) and self-host Node
// (apps/main-node). Was apps/main/src/routes/schedules.ts (D1-only); moved
// here so both runtimes mount one implementation (issue #262).
//
// agent_schedules lives in the shared control-plane DB, which is NOT the
// per-request tenant shard `services.sql` exposes on CF — so this builder
// takes the control-plane SqlClient explicitly (a value on Node, a
// per-request resolver on CF that wraps env.MAIN_DB). The SqlClient port
// mirrors the D1 surface (prepare/bind/all/run/first + meta.changes), so the
// handler bodies are unchanged from the original D1 route.

import { Hono } from "hono";
import type { Context } from "hono";
import { z } from "zod";
import { nanoid } from "nanoid";
import type { SqlClient } from "@duyet/oma-sql-client";
import { clampLimit, encodeCursor, decodeCursor } from "@duyet/oma-shared";
import { getLogger } from "@duyet/oma-observability";
import { computeNextRunAsync } from "@duyet/oma-scheduler/jobs/scheduled-agent-runs";

const log = getLogger("schedules");

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

/** Control-plane DB: a fixed client (Node) or a per-request resolver (CF,
 *  which wraps env.MAIN_DB off the request context). */
export type ScheduleDbArg = SqlClient | ((c: Context) => SqlClient);

export interface ScheduleRoutesDeps {
  db: ScheduleDbArg;
}

function resolveDb(arg: ScheduleDbArg, c: Context): SqlClient {
  return typeof arg === "function" ? arg(c) : arg;
}

const createSchema = z.object({
  cron_expression: z.string().regex(/^(\S+\s+){4}\S+$/, "Must be a valid 5-field cron expression"),
  input: z.string().min(1).max(10000),
  // Required for the schedule to actually fire — the tick creates a session
  // in this environment (issue #77).
  environment_id: z.string().min(1),
  timezone: z.string().min(1).max(64).optional().default("UTC"),
  max_sessions: z.number().int().positive().max(100).optional().default(1),
  enabled: z.boolean().optional().default(true),
});

const updateSchema = z
  .object({
    enabled: z.boolean().optional(),
    cron_expression: z
      .string()
      .regex(/^(\S+\s+){4}\S+$/, "Must be a valid 5-field cron expression")
      .optional(),
    input: z.string().min(1).max(10000).optional(),
    environment_id: z.string().min(1).optional(),
    timezone: z.string().min(1).max(64).optional(),
    max_sessions: z.number().int().positive().max(100).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, "At least one field must be provided");

/**
 * Tenant-wide schedule list — `GET /v1/schedules`, mounted separately from the
 * per-agent CRUD above (which lives under `/v1/agents`). Exists so a
 * cross-agent view (the Console Kanban board) can read every schedule in one
 * request instead of fanning out one call per agent.
 *
 * Follows the repo's cursor contract: ordered `(created_at, id) DESC`, opaque
 * `next_cursor`, stale cursor silently restarts from page 1.
 */
export function buildTenantScheduleRoutes(deps: ScheduleRoutesDeps) {
  const app = new Hono<Vars>();

  app.get("/", async (c) => {
    const tenantId = c.var.tenant_id;
    const db = resolveDb(deps.db, c);
    const limit = clampLimit(c.req.query("limit") ? Number(c.req.query("limit")) : undefined);
    const after = decodeCursor(c.req.query("cursor"));

    let where = "tenant_id = ?";
    const binds: unknown[] = [tenantId];
    const agentId = c.req.query("agent_id");
    if (agentId) {
      where += " AND agent_id = ?";
      binds.push(agentId);
    }
    if (after) {
      where += " AND (created_at < ? OR (created_at = ? AND id < ?))";
      const afterIso = new Date(after.createdAt).toISOString();
      binds.push(afterIso, afterIso, after.id);
    }
    binds.push(limit + 1);

    const res = await db
      .prepare(
        `SELECT * FROM agent_schedules WHERE ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(...binds)
      .all<{ id: string; created_at: string }>();

    const rows = res.results ?? [];
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: new Date(last.created_at).getTime(), id: last.id })
        : undefined;

    return c.json({ data: items, next_cursor: nextCursor });
  });

  return app;
}

export function buildScheduleRoutes(deps: ScheduleRoutesDeps) {
  const app = new Hono<Vars>();

  app.post("/:agentId/schedules", async (c) => {
    const agentId = c.req.param("agentId");
    const tenantId = c.var.tenant_id;
    const body = await c.req.json().catch(() => ({}));
    const parsed = createSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 400);
    }

    const db = resolveDb(deps.db, c);
    const id = `sch_${nanoid(24)}`;
    const nowMs = Date.now();
    const now = new Date(nowMs).toISOString();
    const userId = c.var.user_id ?? null;

    // Seed the first firing time from the cron+timezone so the tick can pick
    // the row up. Unparseable cron → null → never fires (guarded at select).
    const nextMs = await computeNextRunAsync(parsed.data.cron_expression, parsed.data.timezone, nowMs);
    const nextRunAt = nextMs != null ? new Date(nextMs).toISOString() : null;

    await db
      .prepare(
        `INSERT INTO agent_schedules
           (id, agent_id, tenant_id, cron_expression, input, environment_id, user_id, timezone, next_run_at, max_sessions, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        agentId,
        tenantId,
        parsed.data.cron_expression,
        parsed.data.input,
        parsed.data.environment_id,
        userId,
        parsed.data.timezone,
        nextRunAt,
        parsed.data.max_sessions,
        parsed.data.enabled ? 1 : 0,
        now,
        now,
      )
      .run();

    log.info({ schedule_id: id, agent_id: agentId, cron: parsed.data.cron_expression }, "schedule created");

    return c.json({
      id,
      agent_id: agentId,
      cron_expression: parsed.data.cron_expression,
      input: parsed.data.input,
      environment_id: parsed.data.environment_id,
      timezone: parsed.data.timezone,
      next_run_at: nextRunAt,
      max_sessions: parsed.data.max_sessions,
      enabled: parsed.data.enabled,
      created_at: now,
      updated_at: now,
    }, 201);
  });

  // Run now — nudge next_run_at to the current instant so the next cron tick
  // fires this schedule immediately (reuses the same idempotent firing path
  // rather than a second create path). Tenant-scoped.
  app.post("/:agentId/schedules/:scheduleId/run", async (c) => {
    const scheduleId = c.req.param("scheduleId");
    const tenantId = c.var.tenant_id;
    const db = resolveDb(deps.db, c);

    const now = new Date().toISOString();
    const res = await db
      .prepare("UPDATE agent_schedules SET next_run_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?")
      .bind(now, now, scheduleId, tenantId)
      .run();

    if ((res.meta?.changes ?? 0) === 0) {
      return c.json({ error: "Schedule not found" }, 404);
    }

    log.info({ schedule_id: scheduleId }, "schedule run-now requested");
    return c.json({ status: "queued", next_run_at: now }, 200);
  });

  app.get("/:agentId/schedules", async (c) => {
    const agentId = c.req.param("agentId");
    const tenantId = c.var.tenant_id;
    const db = resolveDb(deps.db, c);

    const rows = await db
      .prepare("SELECT * FROM agent_schedules WHERE agent_id = ? AND tenant_id = ? ORDER BY created_at DESC")
      .bind(agentId, tenantId)
      .all();

    return c.json({ data: rows.results });
  });

  // Partial update. Any of cron_expression/input/environment_id/timezone/
  // max_sessions/enabled may be patched. When cron_expression or timezone
  // changes, next_run_at is recomputed atomically in the same request so it
  // can never drift from the cron (mirrors create's seeding logic).
  app.patch("/:agentId/schedules/:scheduleId", async (c) => {
    const scheduleId = c.req.param("scheduleId");
    const tenantId = c.var.tenant_id;
    const body = await c.req.json().catch(() => ({}));
    const parsed = updateSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid input", details: parsed.error.flatten() }, 400);
    }

    const db = resolveDb(deps.db, c);

    const existing = await db
      .prepare("SELECT * FROM agent_schedules WHERE id = ? AND tenant_id = ?")
      .bind(scheduleId, tenantId)
      .first<{ cron_expression: string; timezone: string }>();

    if (!existing) {
      return c.json({ error: "Schedule not found" }, 404);
    }

    const patch = parsed.data;
    const now = new Date().toISOString();

    const sets: string[] = [];
    const binds: unknown[] = [];

    if (patch.cron_expression !== undefined) {
      sets.push("cron_expression = ?");
      binds.push(patch.cron_expression);
    }
    if (patch.input !== undefined) {
      sets.push("input = ?");
      binds.push(patch.input);
    }
    if (patch.environment_id !== undefined) {
      sets.push("environment_id = ?");
      binds.push(patch.environment_id);
    }
    if (patch.timezone !== undefined) {
      sets.push("timezone = ?");
      binds.push(patch.timezone);
    }
    if (patch.max_sessions !== undefined) {
      sets.push("max_sessions = ?");
      binds.push(patch.max_sessions);
    }
    if (patch.enabled !== undefined) {
      sets.push("enabled = ?");
      binds.push(patch.enabled ? 1 : 0);
    }

    // Recompute next_run_at whenever cron or timezone changes, using the
    // patched value if present else the existing row's — same "unparseable
    // cron → null → never fires" contract as create.
    if (patch.cron_expression !== undefined || patch.timezone !== undefined) {
      const nextMs = await computeNextRunAsync(
        patch.cron_expression ?? existing.cron_expression,
        patch.timezone ?? existing.timezone,
        Date.now(),
      );
      const nextRunAt = nextMs != null ? new Date(nextMs).toISOString() : null;
      sets.push("next_run_at = ?");
      binds.push(nextRunAt);
    }

    sets.push("updated_at = ?");
    binds.push(now);

    binds.push(scheduleId, tenantId);

    await db
      .prepare(`UPDATE agent_schedules SET ${sets.join(", ")} WHERE id = ? AND tenant_id = ?`)
      .bind(...binds)
      .run();

    const row = await db
      .prepare("SELECT * FROM agent_schedules WHERE id = ? AND tenant_id = ?")
      .bind(scheduleId, tenantId)
      .first();

    log.info({ schedule_id: scheduleId, patch }, "schedule updated");
    return c.json(row, 200);
  });

  app.delete("/:agentId/schedules/:scheduleId", async (c) => {
    const scheduleId = c.req.param("scheduleId");
    const tenantId = c.var.tenant_id;
    const db = resolveDb(deps.db, c);

    const existing = await db
      .prepare("SELECT id FROM agent_schedules WHERE id = ? AND tenant_id = ?")
      .bind(scheduleId, tenantId)
      .first();

    if (!existing) {
      return c.json({ error: "Schedule not found" }, 404);
    }

    await db
      .prepare("DELETE FROM agent_schedules WHERE id = ?")
      .bind(scheduleId)
      .run();

    log.info({ schedule_id: scheduleId }, "schedule deleted");

    return c.json({ status: "deleted" }, 200);
  });

  return app;
}

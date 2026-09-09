import type { SessionRow } from "@duyet/oma-sessions-store";
import type { SessionService } from "@duyet/oma-sessions-store";
import type { SqlClient } from "@duyet/oma-sql-client";

/** Session metadata flag for the Agent's long-lived inbox (issue #460). */
export const HOME_SESSION_METADATA_KEY = "home";

/** Heartbeat older than this is offline (runtime.last_heartbeat is unix seconds). */
export const HOME_RUNTIME_STALE_SECONDS = 90;

export type HomeRuntimePresence = "online" | "offline" | "provisioning";

export interface HomeRuntimeView {
  id: string;
  hostname: string;
  os: string | null;
  status: HomeRuntimePresence;
  last_heartbeat: number | null;
}

export function isHomeSessionMetadata(
  metadata: Record<string, unknown> | null | undefined,
): boolean {
  return metadata?.[HOME_SESSION_METADATA_KEY] === true;
}

export function homeSessionMetadata(
  extra?: Record<string, unknown> | null,
): Record<string, unknown> {
  return { ...(extra ?? {}), [HOME_SESSION_METADATA_KEY]: true };
}

export async function findHomeSession(opts: {
  sessions: SessionService;
  tenantId: string;
  agentId: string;
}): Promise<SessionRow | null> {
  let cursor: string | undefined;
  for (let i = 0; i < 20; i++) {
    const page = await opts.sessions.listPage({
      tenantId: opts.tenantId,
      agentId: opts.agentId,
      includeArchived: false,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const hit = page.items.find((row) => isHomeSessionMetadata(row.metadata));
    if (hit) return hit;
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return null;
}

export function deriveHomeRuntimePresence(
  row: {
    status?: string | null;
    last_heartbeat?: number | null;
  } | null,
  nowSeconds: number,
  staleSeconds = HOME_RUNTIME_STALE_SECONDS,
): HomeRuntimePresence {
  if (!row) return "provisioning";
  const hb = row.last_heartbeat;
  if (hb == null || !Number.isFinite(hb)) {
    return row.status === "online" ? "online" : "offline";
  }
  if (nowSeconds - hb > staleSeconds) return "offline";
  if (row.status === "offline") return "offline";
  return "online";
}

function coerceHeartbeat(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export async function loadHomeRuntime(
  sql: SqlClient | undefined,
  tenantId: string,
  nowSeconds = Math.floor(Date.now() / 1000),
  ownerUserId?: string,
): Promise<HomeRuntimeView | null> {
  if (!sql) return null;
  try {
    const stmt = ownerUserId
      ? sql
          .prepare(
            `SELECT id, hostname, os, status, last_heartbeat
               FROM "runtimes"
              WHERE owner_tenant_id = ? OR owner_user_id = ?
              ORDER BY COALESCE(last_heartbeat, 0) DESC
              LIMIT 8`,
          )
          .bind(tenantId, ownerUserId)
      : sql
          .prepare(
            `SELECT id, hostname, os, status, last_heartbeat
               FROM "runtimes"
              WHERE owner_tenant_id = ?
              ORDER BY COALESCE(last_heartbeat, 0) DESC
              LIMIT 8`,
          )
          .bind(tenantId);
    const rows = await stmt.all<{
      id: string;
      hostname: string;
      os: string | null;
      status: string | null;
      last_heartbeat: number | string | null;
    }>();
    const list = rows.results ?? [];
    if (list.length === 0) return null;
    const best = list[0]!;
    const lastHeartbeat = coerceHeartbeat(best.last_heartbeat);
    return {
      id: best.id,
      hostname: best.hostname,
      os: best.os ?? null,
      status: deriveHomeRuntimePresence(
        { status: best.status, last_heartbeat: lastHeartbeat },
        nowSeconds,
      ),
      last_heartbeat: lastHeartbeat,
    };
  } catch {
    return null;
  }
}

export type HomeRuntimePresence = "online" | "offline" | "provisioning";

export const HOME_RUNTIME_STALE_SECONDS = 90;

export interface RuntimeHeartbeatRow {
  id: string;
  hostname?: string;
  os?: string | null;
  status?: string | null;
  last_heartbeat?: number | null;
  kind?: string | null;
}

export function deriveHomeRuntimePresence(
  row: RuntimeHeartbeatRow | null | undefined,
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

export function pickHomeRuntime(
  runtimes: RuntimeHeartbeatRow[] | undefined,
): RuntimeHeartbeatRow | null {
  if (!runtimes || runtimes.length === 0) return null;
  return [...runtimes].sort(
    (a, b) => (b.last_heartbeat ?? 0) - (a.last_heartbeat ?? 0),
  )[0] ?? null;
}

export function sessionStatusKind(
  status: string | undefined,
): "working" | "idle" | "error" | "other" {
  if (status === "running" || status === "rescheduled" || status === "rescheduling") {
    return "working";
  }
  if (status === "idle") return "idle";
  if (status === "error" || status === "terminated") return "error";
  return "other";
}

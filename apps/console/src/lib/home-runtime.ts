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

function coerceHeartbeat(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

export function deriveHomeRuntimePresence(
  row: RuntimeHeartbeatRow | null | undefined,
  nowSeconds: number,
  staleSeconds = HOME_RUNTIME_STALE_SECONDS,
): HomeRuntimePresence {
  if (!row) return "provisioning";
  const hb = coerceHeartbeat(row.last_heartbeat);
  if (hb == null) {
    if (row.status === "provisioning") return "provisioning";
    return row.status === "online" ? "online" : "offline";
  }
  if (nowSeconds - hb > staleSeconds) return "offline";
  if (row.status === "offline") return "offline";
  if (row.status === "provisioning") return "provisioning";
  return "online";
}

/** Prefer the home-session payload's already-derived runtime; fall back to /v1/runtimes. */
export function resolveHomePresence(opts: {
  homeRuntime?: { status?: string | null; last_heartbeat?: number | null } | null;
  runtimes?: RuntimeHeartbeatRow[];
  nowSeconds: number;
}): HomeRuntimePresence {
  const s = opts.homeRuntime?.status;
  if (s === "online" || s === "offline" || s === "provisioning") return s;
  if (opts.homeRuntime) {
    return deriveHomeRuntimePresence(
      {
        id: "home",
        status: opts.homeRuntime.status,
        last_heartbeat: opts.homeRuntime.last_heartbeat,
      },
      opts.nowSeconds,
    );
  }
  return deriveHomeRuntimePresence(pickHomeRuntime(opts.runtimes), opts.nowSeconds);
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

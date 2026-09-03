import type { Event } from "../../lib/events";

/** Default expected heartbeat cadence (issue #345). Lag warns at 2× this. */
export const HEARTBEAT_EXPECTED_INTERVAL_MS = 5 * 60 * 1000;

export type HeartbeatState = "working" | "blocked" | "waiting";

export interface HeartbeatEntry {
  ts: number | null;
  summary: string;
  state: HeartbeatState;
  step?: number;
  total_steps?: number;
  blocked_on?: string;
  gapMs: number | null;
  lagged: boolean;
}

export interface HeartbeatView {
  entries: HeartbeatEntry[];
  latest: HeartbeatEntry | null;
  lagMs: number | null;
  lagging: boolean;
  progress: { step: number; total: number } | null;
  blockedOn: string | null;
  live: boolean;
}

function isTerminal(type: string): boolean {
  return (
    type === "session.error" ||
    type === "session.status_idle" ||
    type === "session.status_terminated"
  );
}

function asState(value: unknown): HeartbeatState {
  if (value === "blocked" || value === "waiting" || value === "working") return value;
  return "working";
}

function eventTs(e: Event): number | null {
  if (typeof e.ts === "string") {
    const ms = Date.parse(e.ts);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

export function deriveHeartbeatView(
  events: Event[],
  now: number,
  expectedIntervalMs = HEARTBEAT_EXPECTED_INTERVAL_MS,
): HeartbeatView {
  const lagLimit = expectedIntervalMs * 2;
  const collected: HeartbeatEntry[] = [];
  let live = false;
  let prevTs: number | null = null;

  for (const e of events) {
    if (e.type === "agent.status") {
      const ts = eventTs(e);
      const gapMs = ts != null && prevTs != null ? ts - prevTs : null;
      const lagged = gapMs != null && gapMs > lagLimit;
      const step = typeof e.step === "number" ? e.step : undefined;
      const total = typeof e.total_steps === "number" ? e.total_steps : undefined;
      const blockedOn = typeof e.blocked_on === "string" ? e.blocked_on : undefined;
      collected.push({
        ts,
        summary: typeof e.summary === "string" ? e.summary : "",
        state: asState(e.state),
        step,
        total_steps: total,
        blocked_on: blockedOn,
        gapMs,
        lagged,
      });
      prevTs = ts ?? prevTs;
      live = true;
    } else if (isTerminal(e.type)) {
      live = false;
    }
  }

  const entries = collected.slice().reverse();
  const latest = entries[0] ?? null;
  const lagMs =
    live && latest?.ts != null && Number.isFinite(latest.ts) ? Math.max(0, now - latest.ts) : null;
  const lagging = lagMs != null && lagMs > lagLimit;
  const progress =
    latest && typeof latest.step === "number" && typeof latest.total_steps === "number"
      ? { step: latest.step, total: latest.total_steps }
      : latest && typeof latest.step === "number"
        ? { step: latest.step, total: latest.step }
        : null;
  const blockedOn =
    latest && (latest.state === "blocked" || latest.blocked_on)
      ? latest.blocked_on || latest.summary || "unknown"
      : null;

  return { entries, latest, lagMs, lagging, progress, blockedOn, live };
}

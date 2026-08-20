import type { Event } from "../../lib/events";
import type { Trajectory, TrajectoryOutcome } from "../../lib/trajectory";

/**
 * Session-header / failed-turn helpers (issue #397).
 *
 * Trajectory.outcome used to follow sandbox lifecycle: SessionDO always
 * emits `session.status_idle` after a failed model turn so the user can
 * send again, and that idle was mapped to green "Outcome: success". These
 * helpers derive the chip from the *latest turn*, clear stale `agent.status`
 * "working" chips when the stream ends in error/idle, recover the last
 * user prompt for Retry, and turn 502 / no-output blobs into a line a
 * human can act on — without logging or asking for secrets.
 */

export function deriveOutcomeFromEvents(events: Event[]): TrajectoryOutcome | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const t = events[i].type;
    if (t === "session.error") return "failure";
    if (t === "user.interrupt") return "interrupted";
    if (t === "session.status_terminated") return "interrupted";
    if (t === "session.status_idle") {
      const sameTurn = outcomeOfTurnBeforeIdle(events, i);
      if (sameTurn) return sameTurn;
      return "success";
    }
    if (t === "session.status_running") return "running";
  }
  return undefined;
}

function outcomeOfTurnBeforeIdle(
  events: Event[],
  idleIndex: number,
): TrajectoryOutcome | undefined {
  for (let j = idleIndex - 1; j >= 0; j--) {
    const t = events[j].type;
    if (t === "session.error") return "failure";
    if (t === "user.interrupt") return "interrupted";
    if (
      t === "session.status_running" ||
      t === "session.status_idle" ||
      t === "session.status_terminated"
    ) {
      return undefined;
    }
  }
  return undefined;
}

/** Prefer live events over a one-shot trajectory fetch (which lags, and
 *  historically reported success after crash-recovery idle). */
export function displayTrajectoryOutcome(
  trajectory: Trajectory | "loading" | "error" | undefined,
  events: Event[],
): TrajectoryOutcome | undefined {
  const live = deriveOutcomeFromEvents(events);
  if (live && live !== "running") return live;
  if (live === "running") return "running";
  if (trajectory && trajectory !== "loading" && trajectory !== "error") {
    return trajectory.outcome;
  }
  return undefined;
}

/**
 * Latest `agent.status` is only "current" until the turn ends. After
 * `session.error` / `status_idle` / `status_terminated` the green
 * "working · step 1" chip is noise.
 */
export function latestLiveAgentStatus(events: Event[]): Event | undefined {
  let latest: Event | undefined;
  let stale = false;
  for (const e of events) {
    if (e.type === "agent.status") {
      latest = e;
      stale = false;
    } else if (
      e.type === "session.error" ||
      e.type === "session.status_idle" ||
      e.type === "session.status_terminated"
    ) {
      stale = true;
    }
  }
  if (!latest || stale) return undefined;
  return latest;
}

/** Most recent user prompt before `beforeIndex` (exclusive), skipping
 *  schedule-tool wakeups. Used to Retry a failed turn without retyping. */
export function lastUserMessageText(events: Event[], beforeIndex?: number): string {
  const end = beforeIndex ?? events.length;
  for (let i = end - 1; i >= 0; i--) {
    const e = events[i];
    if (e.type !== "user.message") continue;
    const metadata = e.metadata as { harness?: string; kind?: string } | undefined;
    if (metadata?.harness === "schedule" && metadata?.kind === "wakeup") continue;
    const content = Array.isArray(e.content) ? e.content : [];
    const text = content.find((b) => b.type === "text")?.text?.trim();
    if (text) return text;
  }
  return "";
}

/**
 * One actionable line for 502 / no-output / credential failures.
 * Never echoes tokens, never asks the user to paste a key.
 */
export function humanizeTurnError(error?: string, cause?: string): string | undefined {
  const blob = [error, cause].filter((s): s is string => !!s && s.length > 0).join("\n");
  if (!blob) return undefined;
  const lower = blob.toLowerCase();

  if (
    /\b401\b/.test(lower) ||
    /unauthorized/.test(lower) ||
    /invalid.?api.?key/.test(lower) ||
    /authentication/.test(lower) ||
    /no api key/.test(lower) ||
    /api key.*(missing|not (set|configured))/.test(lower) ||
    /missing.*(credential|api key|token)/.test(lower)
  ) {
    return "The model provider rejected this request (missing or invalid credentials). Check the agent's model card or workspace provider connection.";
  }

  if (
    /\b502\b/.test(lower) ||
    /bad gateway/.test(lower) ||
    /\b503\b/.test(lower) ||
    /service unavailable/.test(lower) ||
    /gateway timeout/.test(lower) ||
    /\b504\b/.test(lower)
  ) {
    return "The model provider or gateway is down. Wait a moment and retry — this is not a problem with your prompt.";
  }

  if (
    /\b429\b/.test(lower) ||
    /rate.?limit/.test(lower) ||
    /too many requests/.test(lower) ||
    /overloaded/.test(lower)
  ) {
    return "The provider rate-limited or overloaded this request. Wait and retry.";
  }

  // AnyRouter/requesty (hoian) wrapping Gemini's built-in+function-tools
  // rejection. Not a missing key — the free-chain hop cannot combine tools
  // until the gateway fails over (or you pin a tool-capable model).
  if (
    /include_server_side_tool_invocations/.test(lower) ||
    /built-in tools with function calling/.test(lower)
  ) {
    return "The gateway routed this turn to an upstream that cannot combine built-in tools with function calling. Retry, or set the agent to a tool-capable model (not a free auto-route hop).";
  }

  if (/no output generated/.test(lower)) {
    return "The model returned no output. This is usually a provider outage or missing model credentials — retry, or check the agent's model setup.";
  }

  return undefined;
}

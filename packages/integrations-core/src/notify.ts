// Provider-agnostic session-status notification shape.
//
// Outbound notifiers (packages/github, packages/slack, packages/matrix)
// each format this into a platform-specific message (GitHub markdown
// comment, Slack mrkdwn, Matrix plain-text) rather than duplicating the
// wording. Callers derive it from the session event log — see AGENTS.md's
// Event Types table — typically `session.status_idle`, `session.error`, or
// `session.status_terminated`.
//
// This is the OUTBOUND direction (session → chat/issue-tracker). It is
// unrelated to `IntegrationProvider` in provider.ts, which handles the
// INBOUND direction (chat/issue-tracker → session).

import type { SessionId } from "./domain";

/**
 * `idle` / `terminated` / `error` describe a SESSION's lifecycle. The
 * `schedule_*` variants describe one firing of an agent schedule
 * (issue #313) — the same envelope + provider formatting reused for
 * per-schedule alerts, so target posters need no schedule-specific code.
 */
export type SessionNotifyStatus =
  | "idle"
  | "terminated"
  | "error"
  | "schedule_ok"
  | "schedule_error"
  | "schedule_skipped"
  | "sandbox_provision_failed"
  | "sandbox_unhealthy";

/**
 * Sandbox lifecycle outcomes an operator can subscribe to (issue #80). The
 * set is deliberately tiny: only the two states that need a human. Routine
 * churn — per-turn warmups, operator-initiated pause/resume, snapshot
 * retries — is excluded, because an integration that fires on those gets
 * muted and then the real failures are missed too.
 */
export type SandboxNotifyKind = "provision_failed" | "unhealthy";

export const SANDBOX_NOTIFY_STATUS: Record<SandboxNotifyKind, SessionNotifyStatus> = {
  provision_failed: "sandbox_provision_failed",
  unhealthy: "sandbox_unhealthy",
};

export interface SessionNotifyEvent {
  sessionId: SessionId;
  status: SessionNotifyStatus;
  /** Agent display name, when known — keeps the message legible without a lookup. */
  agentName?: string;
  /** Free-form detail: idle stop_reason, terminated reason, or error message. */
  detail?: string;
  /** Deep link back to the session (e.g. console URL), when available. */
  sessionUrl?: string;
  /** Publication id, when the session was created via a publish flow. */
  publicationId?: string;
  /** End-user id the session is acting on behalf of, when known. */
  endUserId?: string;
  /** Final agent message text, when the session reached an idle/terminal state. */
  finalMessage?: string;
  /** Agent schedule id (`sch_*`) this notification is about, for the
   *  `schedule_*` statuses. Absent for ordinary session notifications. */
  scheduleId?: string;
  /** Tenant that owns the session — an operator watching a shared cluster
   *  needs it to know whose sandbox broke. Set for the `sandbox_*` statuses. */
  tenantId?: string;
  /** Sandbox provider id the session resolved to (`cloud`, `k8s-remote`,
   *  `boxrun`, …). Set for the `sandbox_*` statuses. */
  sandboxProvider?: string;
  /** Where in the sandbox lifecycle the failure surfaced (e.g. `warmup`,
   *  `provider_unavailable`). Set for the `sandbox_*` statuses. */
  sandboxPhase?: string;
}

/**
 * JSON envelope shape POSTed to a `webhook` NotificationTarget. Stable
 * wire contract — receivers should key off `session_id` + `status`.
 */
export interface WebhookEnvelope {
  session_id: string;
  publication_id?: string;
  end_user_id?: string;
  agent_name?: string;
  status: SessionNotifyStatus;
  stop_reason?: string;
  message?: string;
  session_url?: string;
  /** Present only for the `schedule_*` statuses (issue #313). Appended last
   *  so the pre-existing field order — and therefore every existing
   *  receiver's signature check — is unchanged. */
  schedule_id?: string;
  /** Present only for the `sandbox_*` statuses (issue #80). Appended last,
   *  same reason as `schedule_id` — existing receivers' signing bytes are
   *  untouched for every pre-existing status. */
  tenant_id?: string;
  sandbox_provider?: string;
  sandbox_phase?: string;
}

const STATUS_LABEL: Record<SessionNotifyStatus, string> = {
  idle: "finished and is waiting for input",
  terminated: "was terminated",
  error: "hit an error",
  schedule_ok: "scheduled run succeeded",
  schedule_error: "scheduled run failed",
  schedule_skipped: "scheduled run was skipped (concurrency cap reached)",
  sandbox_provision_failed: "could not provision its sandbox",
  sandbox_unhealthy: "sandbox became unhealthy and was recreated",
};

/**
 * One-line, plain-text summary shared by every provider's notify.ts. Kept
 * deliberately platform-neutral (no markdown) — callers wrap it in their
 * own formatting.
 */
export function summarizeSessionNotifyEvent(event: SessionNotifyEvent): string {
  const who = event.agentName ? `Agent "${event.agentName}"` : "The agent";
  let line = `${who} session ${event.sessionId} ${STATUS_LABEL[event.status]}.`;
  if (event.sandboxProvider) line += ` [provider=${event.sandboxProvider}${event.sandboxPhase ? ` phase=${event.sandboxPhase}` : ""}]`;
  if (event.detail) line += ` ${event.detail}`;
  if (event.sessionUrl) line += ` (${event.sessionUrl})`;
  return line;
}

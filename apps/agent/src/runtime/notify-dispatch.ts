// Dispatches an outbound session-status notification (SessionNotifyEvent)
// to every NotificationTarget configured on an agent (agent.notify).
//
// Extracted from session-do.ts so the fan-out logic is unit-testable
// without spinning up a Durable Object — mirrors the injected-deps style
// of outcome-supervisor.ts. session-do.ts calls this fire-and-forget after
// a session.status_idle/error/terminated event is already committed; this
// module must never throw back into the caller.

import type { HttpClient, SessionNotifyEvent, WebhookEnvelope } from "@duyet/oma-integrations-core";
import type { NotificationTarget } from "@duyet/oma-api-types";
import { GitHubApiClient, postSessionStatusComment } from "@duyet/oma-github";
import { SlackApiClient, postSessionStatusMessage as postSlackStatusMessage } from "@duyet/oma-slack";
import { MatrixApiClient, postSessionStatusMessage as postMatrixStatusMessage } from "@duyet/oma-matrix";
import { TelegramClient, postTelegramMessage } from "@duyet/oma-telegram";

export interface NotifyDispatchDeps {
  /** Resolve a vault `credential_id` to a live bearer/bot/access token. */
  resolveCredentialToken: (credentialId?: string) => Promise<string | null>;
  /** Resolve a vault `secret_ref` id to the HMAC secret used to sign
   *  `webhook` deliveries. Never the same path as the inline agent config —
   *  the secret only ever lives in the vault, resolved at dispatch time. */
  resolveSecret: (secretRef?: string) => Promise<string | null>;
  httpClient: HttpClient;
  /** Optional error sink (logging) — called once per failed/skipped target. */
  onError?: (target: NotificationTarget, err: unknown) => void;
  /**
   * Tenant id used as the per-tenant rate-limit bucket key for `webhook`
   * deliveries. Outbound webhook volume is capped per tenant so a chatty
   * agent or a misconfigured loop can't flood a customer endpoint.
   */
  tenantId?: string;
  /**
   * Optional rate-limit gate. When provided, every `webhook` delivery first
   * consumes a token from the `webhook:${tenantId}` bucket; on exhaustion the
   * delivery is skipped (fail-open: we drop rather than block the session).
   */
  webhookRateLimitGate?: {
    consume(key: string): Promise<{ ok: boolean; retryAfter?: number }>;
  };
  /** Resolve the Telegram bot token (from env, e.g. TELEGRAM_BOT_TOKEN).
   *  Telegram uses a single bot token rather than a per-target vault
   *  credential, so telegram_message targets resolve auth here, not via
   *  resolveCredentialToken. */
  resolveTelegramBotToken?: () => string | null | Promise<string | null>;
}

/**
 * Fan out `event` to every target concurrently. Never throws — a target
 * with no resolvable token, or whose provider call fails, is reported via
 * `deps.onError` (if given) and otherwise skipped; it never affects the
 * other targets.
 */
export async function dispatchSessionNotifications(
  event: SessionNotifyEvent,
  targets: readonly NotificationTarget[],
  deps: NotifyDispatchDeps,
): Promise<void> {
  if (!targets.length) return;
  await Promise.allSettled(targets.map((target) => dispatchOne(event, target, deps)));
}

async function dispatchOne(
  event: SessionNotifyEvent,
  target: NotificationTarget,
  deps: NotifyDispatchDeps,
): Promise<void> {
  try {
    switch (target.type) {
      case "github_comment": {
        const token = await deps.resolveCredentialToken(target.credential_id);
        if (!token) {
          deps.onError?.(target, new Error(`no credential token resolved for credential_id=${target.credential_id}`));
          return;
        }
        const client = new GitHubApiClient(deps.httpClient);
        await postSessionStatusComment(
          client,
          token,
          { owner: target.owner, repo: target.repo, issueNumber: target.issue_number },
          event,
        );
        return;
      }
      case "slack_message": {
        const token = await deps.resolveCredentialToken(target.credential_id);
        if (!token) {
          deps.onError?.(target, new Error(`no credential token resolved for credential_id=${target.credential_id}`));
          return;
        }
        const client = new SlackApiClient(deps.httpClient);
        await postSlackStatusMessage(client, token, { channel: target.channel }, event);
        return;
      }
      case "matrix_message": {
        const token = await deps.resolveCredentialToken(target.credential_id);
        if (!token) {
          deps.onError?.(target, new Error(`no credential token resolved for credential_id=${target.credential_id}`));
          return;
        }
        const client = new MatrixApiClient(deps.httpClient);
        await postMatrixStatusMessage(
          client,
          token,
          { homeserverUrl: target.homeserver_url, roomId: target.room_id },
          event,
        );
        return;
      }
      case "telegram_message": {
        const token = await deps.resolveTelegramBotToken?.();
        if (!token) {
          deps.onError?.(target, new Error("no telegram bot token configured for telegram_message target"));
          return;
        }
        const client = new TelegramClient(token);
        await postTelegramMessage(client, { chatId: target.chat_id }, event);
        return;
      }
      case "webhook": {
        await dispatchWebhook(event, target, deps);
        return;
      }
    }
  } catch (err) {
    deps.onError?.(target, err);
  }
}

function isScheduleStatus(status: SessionNotifyEvent["status"]): boolean {
  return status === "schedule_ok" || status === "schedule_error" || status === "schedule_skipped";
}

/**
 * Build the JSON envelope POSTed to a `webhook` target. Field order is fixed
 * so the receiver can reproduce the exact signed payload (HMAC is computed
 * over the canonical JSON.stringify of this object).
 */
export function buildWebhookEnvelope(event: SessionNotifyEvent, target: Extract<NotificationTarget, { type: "webhook" }>): WebhookEnvelope {
  const envelope: WebhookEnvelope = {
    session_id: event.sessionId,
    status: event.status,
    ...(event.publicationId ? { publication_id: event.publicationId } : {}),
    ...(event.endUserId ? { end_user_id: event.endUserId } : {}),
    ...(event.agentName ? { agent_name: event.agentName } : {}),
    ...(event.detail ? { stop_reason: event.detail } : {}),
    ...(event.finalMessage ? { message: event.finalMessage } : {}),
    ...(event.sessionUrl ? { session_url: event.sessionUrl } : {}),
    // Appended last (issue #313) so the historical field order — and every
    // existing receiver's reproduced signing bytes — is untouched for
    // non-schedule deliveries.
    ...(event.scheduleId ? { schedule_id: event.scheduleId } : {}),
  };
  return envelope;
}

/** Hex-encoded HMAC-SHA256 over `body` keyed by `secret`, computed with
 *  Web Crypto so it runs unchanged on Cloudflare Workers and Node. */
export async function signWebhookBody(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function dispatchWebhook(
  event: SessionNotifyEvent,
  target: Extract<NotificationTarget, { type: "webhook" }>,
  deps: NotifyDispatchDeps,
): Promise<void> {
  // Honor the events filter: when set, only deliver for listed statuses.
  // Schedule alerts (`schedule_*`, issue #313) bypass it — their own
  // outcome filter is the schedule's `notify.on`, applied before dispatch,
  // and the `events` enum deliberately stays session-only.
  if (!isScheduleStatus(event.status) && target.events && !target.events.includes(event.status as "idle" | "error" | "terminated")) {
    return;
  }

  // Per-tenant rate limit on outbound webhook volume. Fail-open: when the
  // bucket is exhausted we skip the delivery (and report it) rather than
  // blocking the session, since notify is purely observational.
  if (deps.webhookRateLimitGate && deps.tenantId) {
    const r = await deps.webhookRateLimitGate.consume(`webhook:${deps.tenantId}`);
    if (!r.ok) {
      deps.onError?.(target, new Error(`webhook rate limit exceeded for tenant=${deps.tenantId}`));
      return;
    }
  }

  const envelope = buildWebhookEnvelope(event, target);
  const body = JSON.stringify(envelope);

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-oma-event": event.status,
  };

  // Sign with the vault-resolved secret; send unsigned + warn when no
  // secret_ref is configured (fail-open so a customer endpoint that accepts
  // unsigned deliveries still works).
  const secret = await deps.resolveSecret(target.secret_ref);
  if (secret) {
    const sig = await signWebhookBody(body, secret);
    headers["x-oma-signature"] = `sha256=${sig}`;
  } else if (target.secret_ref) {
    deps.onError?.(target, new Error(`webhook secret not resolved for secret_ref=${target.secret_ref}`));
    return;
  } else {
    deps.onError?.(target, new Error(`webhook target has no secret_ref — sending unsigned delivery to ${target.url}`));
  }

  const res = await deps.httpClient.fetch({ method: "POST", url: target.url, headers, body });
  if (res.status >= 400) {
    deps.onError?.(target, new Error(`webhook POST ${target.url} returned ${res.status}`));
  }
}

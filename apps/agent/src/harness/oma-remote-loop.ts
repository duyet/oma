/**
 * OmaRemoteHarness — cross-instance federation, proxied-session flavour
 * (issue #132, M1).
 *
 * An environment whose `config.sandbox_provider` is `"oma-remote"` runs no
 * agent loop locally at all. This harness forwards the turn to a session on
 * another registered OMA instance (`config.remote.instance_id` → a `fed_*`
 * registry row), waits for the remote to reach idle, and mirrors the remote's
 * `agent.*` events into THIS session's event log so `GET /v1/sessions/:id/
 * events` on the origin renders the remote turn. That's what unlocks
 * "Cloudflare origin → homelab k8s sandboxes": the console, event log, and
 * API surface stay on the origin; the compute stays on the remote.
 *
 * Shape mirrors AcpProxyHarness (the other "someone else owns the loop"
 * harness) — same optional-port no-ops, same fail-loud-on-missing-binding
 * behaviour.
 *
 * ── Event-log ownership (issue #132 open question) ────────────────────────
 * The origin persists a READ-THROUGH COPY of the remote's agent events; it
 * does not live-proxy reads. Reasons:
 *   1. Crash recovery on the origin is the platform's core guarantee — a
 *      session must be reconstructible from its own append-only log. A pure
 *      live proxy makes every origin read depend on the remote being up, and
 *      makes an origin restart mid-turn unrecoverable.
 *   2. It keeps the read path identical for federated and local sessions:
 *      no branch in SSE, pagination, or the console.
 * The trade-off is duplicated storage and a copy that stops at the last
 * poll — accepted, because the remote's log remains the source of truth for
 * anything the origin failed to mirror.
 *
 * Credential boundary: this harness never sees the remote's API key. It calls
 * `ctx.env.proxyRemoteTurn`, a SessionDO-owned port that resolves the key
 * (CF: `MAIN_MCP.resolveFederationTarget` RPC — the agent DO has no KV or
 * secret access of its own; Node: KV + crypto directly), uses it inside the
 * call, and hands back only the remote session id plus the response text.
 */

import type { HarnessInterface, HarnessContext, HarnessRuntime } from "./interface";
import type { SessionEvent, UserMessageEvent } from "@duyet/oma-shared";
import { log } from "@duyet/oma-shared";

/**
 * Remote event types worth copying into the origin's log. Deliberately a
 * allowlist of `agent.*` records: `session.*` lifecycle belongs to the origin
 * (SessionDO emits its own status events for this turn) and mirroring the
 * remote's would produce two interleaved lifecycles in one log.
 */
const MIRRORED_EVENT_TYPES = new Set([
  "agent.message",
  "agent.thinking",
  "agent.tool_use",
  "agent.tool_result",
  "agent.mcp_tool_use",
  "agent.mcp_tool_result",
  "agent.status",
]);

export class OmaRemoteHarness implements HarnessInterface {
  // The remote instance builds its own system prompt / skills / reminders
  // from ITS copy of the agent — pushing ours would cross the config
  // boundary described in EnvironmentConfig.config.remote.agent_id.
  async onSessionInit(): Promise<void> {
    /* no-op */
  }

  shouldCompact(): boolean {
    return false; // the remote instance owns its own context window
  }

  async compact(): Promise<void> {
    /* no-op */
  }

  deriveModelContext(): never[] {
    return []; // never called — this harness runs no generateText
  }

  async run(ctx: HarnessContext): Promise<void> {
    const runtime = ctx.runtime;
    const binding = ctx.environment?.config?.remote;
    if (!binding?.instance_id || !binding?.agent_id) {
      this.#emitError(
        runtime,
        'OmaRemoteHarness requires environment.config.remote.{instance_id,agent_id} (sandbox_provider: "oma-remote")',
      );
      return;
    }

    const proxy = ctx.env.proxyRemoteTurn;
    if (!proxy) {
      // Fail loud. Falling through to a local run would execute the agent on
      // the wrong instance, with the wrong vault and the wrong sandbox.
      this.#emitError(
        runtime,
        "federation not available on this deployment (env.proxyRemoteTurn unwired) — refusing to run an oma-remote session locally",
      );
      return;
    }

    const userText = extractUserText(ctx.userMessage);
    if (!userText) {
      this.#emitError(runtime, "Could not extract text from user message — empty turn");
      return;
    }

    try {
      const { remote_session_id } = await proxy({
        instanceId: binding.instance_id,
        remoteAgentId: binding.agent_id,
        remoteEnvironmentId: binding.environment_id,
        message: userText,
        onRemoteEvent: (event) => {
          if (!event?.type || !MIRRORED_EVENT_TYPES.has(event.type)) return;
          const { seq: _seq, ...rest } = event;
          runtime.broadcast({
            ...(rest as object),
            metadata: {
              ...((rest as { metadata?: Record<string, unknown> }).metadata ?? {}),
              remote_instance_id: binding.instance_id,
              remote_seq: event.seq,
            },
          } as unknown as SessionEvent);
        },
      });
      log(
        { op: "oma_remote.turn_complete", instance_id: binding.instance_id, remote_session_id },
        "federated turn complete",
      );
    } catch (err) {
      // Transport failure, unresolvable instance, unreachable remote, or the
      // loop-prevention refusal — all surface as a session.error. Never a
      // local fallback.
      this.#emitError(runtime, `Remote OMA session failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  #emitError(runtime: HarnessRuntime, message: string): void {
    runtime.broadcast({ type: "session.error", error: message } as SessionEvent);
  }
}

function extractUserText(msg: UserMessageEvent): string {
  const content = msg?.content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text!)
    .join("\n")
    .trim();
}

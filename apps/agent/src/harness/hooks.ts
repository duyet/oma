// Agent hooks (issue #76 Part B) — Claude-Code-style pre/post-tool hooks.
//
// A hook is DECLARATIVE: it never runs arbitrary code in the Worker/DO. Each
// `pre_tool` / `post_tool` hook POSTs a signed JSON envelope to a customer
// webhook (same transport + HMAC-SHA256 signing as the `webhook` notify
// target — reuses signWebhookBody from notify-dispatch) and reads a small
// decision back:
//
//   pre_tool  → { decision: "allow" | "deny" | "modify", tool_input?, reason? }
//   post_tool → { decision: "allow" | "modify", tool_result?, reason? }
//
// `wrapToolsWithHooks` wraps each tool's `execute` so a pre hook can
// gate/modify the call before it runs and a post hook can redact/transform
// the result after. Every hook is time-bounded; on timeout / transport error
// / malformed response the configured `on_error` policy applies —
// "open" (default) lets the tool proceed / keeps the result, "closed" denies.
// So a dead hook endpoint never bricks a session unless the creator opts in.
//
// Byte-cache safety: wrapping only replaces `execute` — tool names,
// descriptions, and input schemas are untouched, so `deriveModelContext`'s
// cached prefix is identical whether or not hooks are configured.

import type { AgentHook } from "@duyet/oma-api-types";
import type { HttpClient } from "@duyet/oma-integrations-core";
import { signWebhookBody } from "../runtime/notify-dispatch";

const DEFAULT_HOOK_TIMEOUT_MS = 5000;

export interface HookDispatchDeps {
  httpClient: HttpClient;
  /** Resolve a webhook target's `secret_ref` (vault credential id) to the
   *  HMAC secret. Same resolution path as the `webhook` notify target — the
   *  secret only ever lives in the vault, never inline on the config. */
  resolveSecret: (secretRef?: string) => Promise<string | null>;
  /** Session id stamped into every hook envelope (context for the receiver). */
  sessionId?: string;
  /** Tenant id used as the per-tenant rate-limit bucket key. */
  tenantId?: string;
  /** Optional rate-limit gate. When provided, every outbound hook delivery
   *  first consumes a token from the `hook:${tenantId}` bucket; on exhaustion
   *  the hook is skipped and the `on_error` policy applies (fail-open by
   *  default — the tool proceeds rather than blocking the session). */
  rateLimitGate?: { consume(key: string): Promise<{ ok: boolean; retryAfter?: number }> };
  /** Optional error/observability sink — called once per failed/skipped hook. */
  onError?: (hook: AgentHook, err: unknown) => void;
}

export interface PreToolDecision {
  decision: "allow" | "deny" | "modify";
  /** Replacement tool input when decision === "modify". */
  tool_input?: Record<string, unknown>;
  /** Human-readable reason surfaced to the model on deny. */
  reason?: string;
}

export interface PostToolDecision {
  decision: "allow" | "modify";
  /** Replacement tool result (string or structured) when decision === "modify". */
  tool_result?: unknown;
  reason?: string;
}

type ToolResultValue = string | Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolLike = { execute?: (args: any, opts: any) => Promise<ToolResultValue>; [k: string]: unknown };

/** Whether a pre/post hook applies to `toolName` given its `matcher`
 *  ("*" or unset = every tool; otherwise an exact tool-name match). */
function matches(hook: AgentHook, toolName: string): boolean {
  return !hook.matcher || hook.matcher === "*" || hook.matcher === toolName;
}

/** POST the envelope to a webhook target and parse the JSON decision back.
 *  Rejects on timeout, transport error, non-2xx, or malformed JSON so the
 *  caller can apply the hook's `on_error` policy. `mcp_tool` targets are not
 *  yet dispatched — they reject so the fail policy applies. */
async function callHook(
  hook: AgentHook,
  payload: Record<string, unknown>,
  deps: HookDispatchDeps,
): Promise<unknown> {
  if (hook.target.type !== "webhook") {
    throw new Error(`hook target type "${hook.target.type}" not supported`);
  }
  const target = hook.target;

  if (deps.rateLimitGate && deps.tenantId) {
    const r = await deps.rateLimitGate.consume(`hook:${deps.tenantId}`);
    if (!r.ok) throw new Error(`hook rate limit exceeded for tenant=${deps.tenantId}`);
  }

  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-oma-hook": String(payload.event ?? ""),
  };
  const secret = await deps.resolveSecret(target.secret_ref);
  if (secret) {
    headers["x-oma-signature"] = `sha256=${await signWebhookBody(body, secret)}`;
  } else if (target.secret_ref) {
    throw new Error(`hook secret not resolved for secret_ref=${target.secret_ref}`);
  }

  const timeoutMs = hook.timeout_ms ?? DEFAULT_HOOK_TIMEOUT_MS;
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`hook timed out after ${timeoutMs}ms`)), timeoutMs),
  );
  const res = await Promise.race([
    deps.httpClient.fetch({ method: "POST", url: target.url, headers, body }),
    timeout,
  ]);
  if (res.status >= 400) throw new Error(`hook POST ${target.url} returned ${res.status}`);
  if (!res.body) return {};
  return JSON.parse(res.body);
}

/**
 * Run every `pre_tool` hook matching `toolName` in order. Returns the
 * (possibly modified) tool input, or `{ denied: true, reason }` if any hook
 * denies. On hook error/timeout the hook's `on_error` policy decides: "closed"
 * denies the tool call, "open" (default) continues with the input unchanged.
 */
export async function runPreToolHooks(
  hooks: readonly AgentHook[],
  toolName: string,
  toolInput: Record<string, unknown>,
  deps: HookDispatchDeps,
): Promise<{ denied: true; reason: string } | { denied: false; input: Record<string, unknown> }> {
  let input = toolInput;
  for (const hook of hooks) {
    if (hook.event !== "pre_tool" || !matches(hook, toolName)) continue;
    let decision: PreToolDecision | null = null;
    try {
      decision = (await callHook(
        hook,
        { event: "pre_tool", tool_name: toolName, tool_input: input, session_id: deps.sessionId },
        deps,
      )) as PreToolDecision;
    } catch (err) {
      deps.onError?.(hook, err);
      if (hook.on_error === "closed") {
        return { denied: true, reason: `pre_tool hook failed (fail-closed): ${errText(err)}` };
      }
      continue; // fail-open
    }
    if (decision?.decision === "deny") {
      return { denied: true, reason: decision.reason || "blocked by pre_tool hook" };
    }
    if (decision?.decision === "modify" && decision.tool_input && typeof decision.tool_input === "object") {
      input = decision.tool_input;
    }
  }
  return { denied: false, input };
}

/**
 * Run every `post_tool` hook matching `toolName` in order over the tool
 * result, returning the (possibly transformed) result. On hook error/timeout
 * the `on_error` policy decides: "closed" replaces the result with an error
 * string, "open" (default) keeps the result unchanged.
 */
export async function runPostToolHooks(
  hooks: readonly AgentHook[],
  toolName: string,
  toolInput: Record<string, unknown>,
  result: ToolResultValue,
  deps: HookDispatchDeps,
): Promise<ToolResultValue> {
  let out = result;
  for (const hook of hooks) {
    if (hook.event !== "post_tool" || !matches(hook, toolName)) continue;
    let decision: PostToolDecision | null = null;
    try {
      decision = (await callHook(
        hook,
        {
          event: "post_tool",
          tool_name: toolName,
          tool_input: toolInput,
          tool_result: out,
          session_id: deps.sessionId,
        },
        deps,
      )) as PostToolDecision;
    } catch (err) {
      deps.onError?.(hook, err);
      if (hook.on_error === "closed") {
        return `post_tool hook failed (fail-closed): ${errText(err)}`;
      }
      continue; // fail-open
    }
    if (decision?.decision === "modify" && decision.tool_result !== undefined) {
      out =
        typeof decision.tool_result === "string"
          ? decision.tool_result
          : (decision.tool_result as Record<string, unknown>);
    }
  }
  return out;
}

/**
 * Return a shallow copy of `tools` whose `execute` functions are wrapped with
 * pre/post-tool hook dispatch. Tools without an `execute` (e.g. always_ask
 * pending stubs) are passed through untouched. When no pre/post hooks are
 * configured the original object is returned unchanged (zero overhead).
 */
export function wrapToolsWithHooks<T extends Record<string, ToolLike>>(
  tools: T,
  hooks: readonly AgentHook[] | undefined,
  deps: HookDispatchDeps,
): T {
  const active = (hooks ?? []).filter((h) => h.event === "pre_tool" || h.event === "post_tool");
  if (active.length === 0) return tools;

  const wrapped: Record<string, ToolLike> = {};
  for (const [name, t] of Object.entries(tools)) {
    const orig = t?.execute;
    if (typeof orig !== "function") {
      wrapped[name] = t;
      continue;
    }
    wrapped[name] = {
      ...t,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      execute: async (args: any, opts: any): Promise<ToolResultValue> => {
        const input = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
        const pre = await runPreToolHooks(active, name, input, deps);
        if (pre.denied) return `Tool call blocked by hook: ${pre.reason}`;
        const result = await orig(pre.input, opts);
        return runPostToolHooks(active, name, pre.input, result, deps);
      },
    };
  }
  return wrapped as T;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

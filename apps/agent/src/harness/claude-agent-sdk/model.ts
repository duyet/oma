/**
 * Per-agent model/provider selection for ClaudeAgentSdkHarness's CLI
 * subprocess (issue #316).
 *
 * Like `./auth.ts`, this module is deliberately pure and free of any
 * `@anthropic-ai/claude-agent-sdk` import so it can be unit tested without
 * the SDK's Node-only subprocess machinery.
 *
 * ── Why a binding, not a DB lookup here ────────────────────────────────
 * The harness runs inside the agent package and has no control-plane DB
 * access. The self-host Node shell (apps/main-node) is the layer that owns
 * model cards, so it resolves the agent's card (or the AnyRouter/env
 * fallback) into a `ClaudeSdkModelBinding` and threads it through
 * `HarnessContext.env.modelProvider`. This module then maps that binding
 * onto the CLI subprocess environment. When no binding is present the
 * result is byte-identical to the pre-#316 global-env behavior.
 */

import { resolveClaudeSdkAuth } from "./auth";

/** Anthropic-wire-compatible API compat tags — the only ones Claude Code's
 *  CLI can talk to (it speaks the Anthropic `/v1/messages` protocol). */
const ANT_COMPAT = new Set(["ant", "ant-compatible"]);
/** OpenAI-wire compat tags — cannot drive the CLI at all. */
const OAI_COMPAT = new Set(["oai", "oai-compatible"]);

/**
 * A resolved per-agent model + provider for the CLI subprocess. Produced by
 * the shell (apps/main-node) from a model card / connected provider.
 */
export interface ClaudeSdkModelBinding {
  /** Wire-level model id sent upstream (a card's `model` column, not its
   *  tenant-facing `model_id` handle). */
  model: string;
  /** Plaintext upstream API key. Empty/absent → fall back to the global
   *  env auth (ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN). */
  apiKey?: string;
  /** Upstream base URL override. Absent → the global ANTHROPIC_BASE_URL (or
   *  the CLI's own default). */
  baseUrl?: string;
  /** `ant` | `ant-compatible` | `oai` | `oai-compatible`. */
  apiCompat: string;
  /** Where the binding came from (a model card id) — logs/errors only. */
  source?: string;
}

export type ClaudeSdkProviderResolution =
  | {
      ok: true;
      /** Model id to pass as the SDK's `model` query option. */
      model: string;
      /** Extra environment exported into the CLI subprocess. */
      env: Record<string, string>;
    }
  | { ok: false; error: string };

/**
 * Map an optional per-agent binding + the global env onto the CLI
 * subprocess's model + environment.
 *
 *  - binding on an Anthropic-wire provider → per-turn ANTHROPIC_API_KEY /
 *    ANTHROPIC_BASE_URL / ANTHROPIC_MODEL + the card's wire model id.
 *  - binding on an OpenAI-wire provider → a hard failure. The Claude Code
 *    CLI has no OpenAI transport, so silently falling back to the global
 *    key would run the turn on a completely different model than the agent
 *    is configured for.
 *  - no binding → exactly the pre-#316 global-env behavior.
 */
export function resolveClaudeSdkProvider(input: {
  binding?: ClaudeSdkModelBinding | null;
  env: {
    ANTHROPIC_API_KEY?: string;
    ANTHROPIC_BASE_URL?: string;
    ANTHROPIC_MODEL?: string;
    CLAUDE_CODE_OAUTH_TOKEN?: string;
  };
  /** `agent.model`, used when nothing more specific resolves. */
  agentModel?: string | { id?: string } | null;
}): ClaudeSdkProviderResolution {
  const env = input.env ?? {};
  const fallbackModel = env.ANTHROPIC_MODEL || agentModelId(input.agentModel);
  const binding = input.binding ?? null;

  if (binding) {
    if (OAI_COMPAT.has(binding.apiCompat)) {
      return { ok: false, error: oaiCompatError(binding) };
    }
    // Any other tag (including an unknown one) is treated as Anthropic-wire,
    // mirroring resolveModelCardCredentials' `apiCompat = "ant"` default.
    const model = binding.model || fallbackModel;
    if (!model) {
      return { ok: false, error: "ClaudeAgentSdkHarness could not resolve a model id from the agent config" };
    }
    const auth = resolveClaudeSdkAuth({
      ANTHROPIC_API_KEY: binding.apiKey || env.ANTHROPIC_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
    });
    if (!auth) {
      return {
        ok: false,
        error: "ClaudeAgentSdkHarness needs env.ANTHROPIC_API_KEY or env.CLAUDE_CODE_OAUTH_TOKEN",
      };
    }
    const baseUrl = binding.baseUrl || env.ANTHROPIC_BASE_URL;
    return {
      ok: true,
      model,
      env: {
        ...auth,
        ...(baseUrl ? { ANTHROPIC_BASE_URL: baseUrl } : {}),
        // The SDK accepts `model` as a query option (used by the caller);
        // ANTHROPIC_MODEL is exported too so any CLI code path that reads
        // the environment agrees with the option.
        ANTHROPIC_MODEL: model,
      },
    };
  }

  // ── No per-agent binding: unchanged global-env path ──────────────────
  const auth = resolveClaudeSdkAuth(env);
  if (!auth) {
    return {
      ok: false,
      error: "ClaudeAgentSdkHarness needs env.ANTHROPIC_API_KEY or env.CLAUDE_CODE_OAUTH_TOKEN",
    };
  }
  if (!fallbackModel) {
    return { ok: false, error: "ClaudeAgentSdkHarness could not resolve a model id from the agent config" };
  }
  return {
    ok: true,
    model: fallbackModel,
    env: {
      ...auth,
      ...(env.ANTHROPIC_BASE_URL ? { ANTHROPIC_BASE_URL: env.ANTHROPIC_BASE_URL } : {}),
    },
  };
}

/** Normalize a model-card `provider` column onto an ApiCompat tag. Mirrors
 *  resolveModelCardCredentials in session-do.ts: the four wire tags pass
 *  through, `anthropic`/`openai` map onto their wire format, and anything
 *  else (e.g. "custom") defaults to Anthropic-wire. */
// One place owns the OpenAI-wire rejection message — it's long, and tests
// assert on its pieces.
export function oaiCompatError(binding: { apiCompat: string; source?: string }): string {
  const where = binding.source ? ` (model card ${binding.source})` : "";
  return (
    `ClaudeAgentSdkHarness cannot use the OpenAI-compatible provider ` +
    `"${binding.apiCompat}"${where}: the Claude Code CLI speaks the Anthropic ` +
    `/v1/messages wire format only. Point this agent at a model card whose ` +
    `provider is anthropic ("ant") or Anthropic-compatible ("ant-compatible"), ` +
    `or switch the agent to the "default" harness.`
  );
}

export function providerToApiCompat(provider: string | null | undefined): string {
  const p = (provider ?? "").toLowerCase();
  if (ANT_COMPAT.has(p) || OAI_COMPAT.has(p)) return p;
  if (p === "anthropic") return "ant";
  if (p === "openai") return "oai";
  return "ant";
}

function agentModelId(model: string | { id?: string } | null | undefined): string {
  if (typeof model === "string") return model;
  return model?.id ?? "";
}

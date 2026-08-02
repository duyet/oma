/**
 * PoolsideHarness — drives a turn against a [poolside.ai](https://poolside.ai)
 * model (the `laguna` / `malibu` agentic-coding family) instead of the
 * platform-resolved default provider.
 *
 * ── Why this is a thin harness, not a meta-harness ──────────────────────
 * Unlike `ClaudeAgentSdkHarness` / `AcpProxyHarness` (which hand the whole
 * turn to an external agent runtime that owns its own model loop), poolside
 * exposes plain **OpenAI-compatible** `/chat/completions` inference:
 *
 *   - Poolside Platform:   https://inference.poolside.ai/v1
 *   - Self-hosted deploy:  https://<api-domain>/openai/v1
 *   - Via OpenRouter:      https://openrouter.ai/api/v1  (poolside/… ids)
 *
 * Auth is `Authorization: Bearer <api-key>` in every case. That is exactly
 * the contract `resolveModel(..., "oai-compatible")` already speaks (it
 * targets `/chat/completions`, never the Responses API — see provider.ts),
 * so there is nothing bespoke to implement on the wire. This harness
 * therefore does the minimum honest thing: resolve poolside credentials +
 * model id from env/agent config, build the `oai-compatible` model, and
 * delegate the *entire* tool loop, compaction, event emission, and context
 * engineering to `DefaultHarness` by calling `super.run()` with the model
 * swapped. No loop machinery is duplicated.
 *
 * Because everything here is plain `fetch` (no `child_process`, no node
 * builtins), this harness is runtime-agnostic and is registered on BOTH the
 * Cloudflare Worker registry (`apps/agent/src/index.ts`) and the self-host
 * Node runtime.
 *
 * ── Configuration ───────────────────────────────────────────────────────
 * `POOLSIDE_API_KEY` is required (mint one at https://platform.poolside.ai).
 * `POOLSIDE_BASE_URL` overrides the default platform endpoint — set it to
 * `https://<api-domain>/openai/v1` when pointing at a poolside deployment
 * (e.g. an in-VPC / Bedrock-hosted malibu). `agent.model` selects the model
 * id verbatim; the `oai-compatible` path preserves a `provider/model`
 * string as-is, so `poolside/laguna-s-2.1` is passed through unstripped.
 *
 * Note: poolside also ships `pool`, an ACP-compatible terminal coding agent
 * (github.com/poolsideai/pool). Driving *that* is a different integration —
 * it belongs behind the existing `acp-proxy` harness + a local runtime
 * binding, not here.
 */

import type { LanguageModel } from "ai";
import { DefaultHarness } from "./default-loop";
import type { HarnessContext } from "./interface";
import { resolveModel } from "./provider";
import type { ApiCompat } from "./provider";

/** Poolside Platform's hosted OpenAI-compatible inference endpoint. */
export const POOLSIDE_DEFAULT_BASE_URL = "https://inference.poolside.ai/v1";

/** Model used when the agent config doesn't name one. */
export const POOLSIDE_DEFAULT_MODEL = "poolside/laguna-s-2.1";

/** Poolside speaks OpenAI's /chat/completions contract, not Anthropic's. */
export const POOLSIDE_API_COMPAT: ApiCompat = "oai-compatible";

export interface PoolsideConfig {
  apiKey: string;
  baseURL: string;
  modelId: string;
}

/** Env slice this harness reads. Mirrors the optional fields on
 *  `HarnessContext["env"]`, kept structural so tests can pass a bare object. */
export interface PoolsideEnv {
  POOLSIDE_API_KEY?: string;
  POOLSIDE_BASE_URL?: string;
}

/**
 * Read a poolside setting from the CF Worker binding first, falling back to
 * `process.env` on self-host Node. `process` is not defined in Workers
 * without nodejs_compat, so the `typeof` guard is load-bearing — same
 * pattern DefaultHarness uses for OMA_MAX_OUTPUT_TOKENS.
 */
function readEnv(env: PoolsideEnv, key: keyof PoolsideEnv): string | undefined {
  const fromBinding = env[key];
  if (fromBinding) return fromBinding;
  if (typeof process !== "undefined") return process.env?.[key] || undefined;
  return undefined;
}

/**
 * Resolve poolside credentials + model id. Pure and env-injected so it can
 * be unit-tested without a session/DO. Throws a descriptive Error when no
 * API key is configured — SessionDO catches it, emits `session.error`, and
 * returns the session to idle (see the crash-recovery contract in
 * AGENTS.md), which is strictly better than silently falling back to a
 * different provider than the operator asked for.
 */
export function resolvePoolsideConfig(
  env: PoolsideEnv,
  agentModel?: string | { id: string; speed?: "standard" | "fast" },
): PoolsideConfig {
  const apiKey = readEnv(env, "POOLSIDE_API_KEY");
  if (!apiKey) {
    throw new Error(
      'Harness "poolside" requires POOLSIDE_API_KEY. Mint a key at ' +
        "https://platform.poolside.ai (API Keys → New key) and set it on the " +
        "deployment (wrangler secret put POOLSIDE_API_KEY, or the env var on " +
        "self-host Node).",
    );
  }

  const rawBaseURL = readEnv(env, "POOLSIDE_BASE_URL") || POOLSIDE_DEFAULT_BASE_URL;
  // Trailing slash would produce `//chat/completions` against strict gateways.
  const baseURL = rawBaseURL.replace(/\/+$/, "");

  const requested = typeof agentModel === "string" ? agentModel : agentModel?.id;
  const modelId = requested && requested.trim() ? requested.trim() : POOLSIDE_DEFAULT_MODEL;

  return { apiKey, baseURL, modelId };
}

/** Build the AI-SDK model handle for a resolved poolside config. */
export function buildPoolsideModel(config: PoolsideConfig): LanguageModel {
  return resolveModel(config.modelId, config.apiKey, config.baseURL, POOLSIDE_API_COMPAT);
}

export class PoolsideHarness extends DefaultHarness {
  async run(ctx: HarnessContext): Promise<void> {
    const config = resolvePoolsideConfig(ctx.env as PoolsideEnv, ctx.agent.model);
    // Swap ONLY the model. Tools, system prompt, history, compaction, and
    // every event emission stay exactly as DefaultHarness computed them —
    // that's the whole point of extending rather than reimplementing.
    await super.run({ ...ctx, model: buildPoolsideModel(config) });
  }
}

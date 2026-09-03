import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import { ANYROUTER_API_BASE, ANYROUTER_API_COMPAT, toAnyRouterCallableModelId, toGatewayModelId } from "@duyet/oma-anyrouter";
import { attributionHeadersFor, isAnyRouterBaseUrl } from "./attribution";

/**
 * API compatibility types:
 * - "ant"            — Anthropic official API
 * - "ant-compatible" — Third-party Anthropic-compatible API
 * - "oai"            — OpenAI official API
 * - "oai-compatible" — Third-party OpenAI-compatible API (DeepSeek, Groq, etc.)
 */
export type ApiCompat = "ant" | "ant-compatible" | "oai" | "oai-compatible";

export interface DefaultProviderCreds {
  apiKey: string;
  baseURL?: string;
  apiCompat: ApiCompat;
}

/**
 * Static-env-var default provider fallback for when an agent's `model`
 * handle matches no D1 model card (see resolveModelCardCredentials in
 * session-do.ts). Precedence:
 *
 *   1. ANTHROPIC_API_KEY — the existing default; wins whenever set, even
 *      alongside ANYROUTER_API_KEY, since a deploy that has explicitly
 *      configured Anthropic is treated as more deliberate than a
 *      platform-wide AnyRouter fallback.
 *   2. ANYROUTER_API_KEY — routes to AnyRouter (https://anyrouter.dev), an
 *      OpenAI-compatible LLM gateway. Base URL + wire compat come from
 *      @duyet/oma-anyrouter's constants so every OMA surface pointed at
 *      AnyRouter agrees on both (same pairing apps/main-node's
 *      OAuth-connected AnyRouter provider uses — see
 *      apps/main-node/src/lib/anyrouter-provider.ts). Bare `claude-*`
 *      handles become `anthropic/claude-*` on generic OpenAI-compat
 *      gateways (`toGatewayModelId`). When the request goes to AnyRouter,
 *      `resolveModel` maps BYOK-only sonnet handles to `anyrouter/free`
 *      because AnyRouter aliases hyphenated `anthropic/claude-sonnet-4-6`
 *      to dotted `anthropic/claude-sonnet-4.6`. That mapping is the HTTP
 *      `model` field on **both** `openai.chat` (`/chat/completions`) and
 *      `anthropic()` (`/messages`) — an `ANTHROPIC_API_KEY` + AnyRouter
 *      `ANTHROPIC_BASE_URL` deploy never hits the OpenAI branch.
 *
 * Returns null when neither is configured — callers fall through to their
 * existing "no credentials" behavior unchanged.
 */
export function resolveDefaultProviderCreds(env: {
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_BASE_URL?: string;
  ANYROUTER_API_KEY?: string;
}): DefaultProviderCreds | null {
  if (env.ANTHROPIC_API_KEY) {
    return { apiKey: env.ANTHROPIC_API_KEY, baseURL: env.ANTHROPIC_BASE_URL, apiCompat: "ant" };
  }
  if (env.ANYROUTER_API_KEY) {
    return { apiKey: env.ANYROUTER_API_KEY, baseURL: ANYROUTER_API_BASE, apiCompat: ANYROUTER_API_COMPAT };
  }
  return null;
}

const KNOWN_CLAUDE_PREFIX = "claude-";

// Cap for non-Claude models on the Anthropic-compat path. The SDK hard-codes
// max_tokens=4096 for unknown models, which truncates extended thinking
// (MiniMax-M2 thinking alone exceeds that). Earlier code deleted the field
// entirely, but the Anthropic spec marks it required — DeepSeek's strict
// (Rust serde) implementation rejects with `missing field max_tokens` and a
// generic 400 that surfaces as `Bad Request` upstream. Setting a high value
// satisfies the spec and gives every provider room for thinking + tool_use.
const NON_CLAUDE_MAX_TOKENS = 32768;

/**
 * Fetch wrapper that overrides @ai-sdk/anthropic's hard-coded max_tokens=4096
 * with NON_CLAUDE_MAX_TOKENS for non-Claude models on the Anthropic-compat
 * path.
 */
async function setMaxTokensFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const finalInit = (() => {
    if (init?.body && typeof init.body === "string") {
      try {
        const body = JSON.parse(init.body);
        body.max_tokens = NON_CLAUDE_MAX_TOKENS;
        return { ...init, body: JSON.stringify(body) };
      } catch {
        return init;
      }
    }
    return init;
  })();
  return observingFetch(url, finalInit);
}

/**
 * Wraps globalThis.fetch with always-on observability for provider rate
 * limiting. Logs (via console) + surfaces:
 *  - HTTP status code (so 429 is visible immediately)
 *  - retry-after header (if present)
 *  - x-ratelimit-* headers (any provider that exposes them)
 *  - response body preview when status >= 400 (truncated)
 *
 * Without this we only see indirect signals (model_first_token + no
 * model_request_end → "stalled stream"), which conflates rate limiting
 * with real model slowness, network issues, or provider hangs.
 */
async function observingFetch(url: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const startedAt = Date.now();
  const method = init?.method ?? "GET";
  const urlStr = typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url;
  // 5min hard timeout on the whole HTTP exchange (including streaming body).
  // Without it a silent provider stream hangs the SessionDO indefinitely.
  const TIMEOUT_MS = 5 * 60_000;
  const signal = init?.signal
    ? AbortSignal.any([init.signal, AbortSignal.timeout(TIMEOUT_MS)])
    : AbortSignal.timeout(TIMEOUT_MS);
  let res: Response;
  try {
    res = await globalThis.fetch(url, { ...init, signal });
  } catch (err) {
    const elapsed = Date.now() - startedAt;
    console.warn(`[provider.fetch] ${method} ${urlStr} → THROW after ${elapsed}ms: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }
  const elapsed = Date.now() - startedAt;
  const status = res.status;
  // Collect rate-limit signals from common header names across providers.
  const retryAfter = res.headers.get("retry-after");
  const limitRemaining =
    res.headers.get("x-ratelimit-remaining-requests") ??
    res.headers.get("x-ratelimit-remaining-tokens") ??
    res.headers.get("x-ratelimit-remaining");
  const limitReset =
    res.headers.get("x-ratelimit-reset-requests") ??
    res.headers.get("x-ratelimit-reset-tokens") ??
    res.headers.get("x-ratelimit-reset");
  const interesting = status >= 400 || retryAfter || (limitRemaining && parseInt(limitRemaining, 10) < 5);
  const requestModel = peekRequestModel(init);
  if (interesting) {
    let bodyPreview = "";
    if (status >= 400) {
      try {
        bodyPreview = (await res.clone().text()).slice(0, 500);
      } catch {}
    }
    console.warn(
      `[provider.fetch] ${method} ${urlStr} → ${status} (${elapsed}ms)` +
        (requestModel ? ` request_model=${requestModel}` : "") +
        (retryAfter ? ` retry-after=${retryAfter}` : "") +
        (limitRemaining ? ` remaining=${limitRemaining}` : "") +
        (limitReset ? ` reset=${limitReset}` : "") +
        (bodyPreview ? ` body=${JSON.stringify(bodyPreview)}` : ""),
    );
  } else if (status >= 200 && status < 300 && elapsed > 5000) {
    // Slow OK response — useful for diagnosing per-call latency
    console.log(`[provider.fetch] ${method} ${urlStr} → ${status} (${elapsed}ms slow)`);
  }
  return res;
}

function useOpenAI(compat: ApiCompat): boolean {
  return compat === "oai" || compat === "oai-compatible";
}

/** Anthropic `/messages` wants a bare Claude id; strip a `provider/` prefix. */
function anthropicModelId(modelString: string): string {
  return modelString.includes("/")
    ? modelString.split("/").slice(1).join("/")
    : modelString;
}

/**
 * JSON `model` field for the outbound HTTP body.
 *
 * AnyRouter aliases hyphenated sonnet onto dotted BYOK-only
 * `anthropic/claude-sonnet-4.6`. That alias is independent of wire
 * format — `#455` remapped `openai.chat(...)` only, so
 * `return anthropic(modelId)` still sent the stripped agent handle on
 * `POST …/messages` (live recert after worker 33803740383). Both
 * branches go through this helper so they cannot drift.
 */
function wireModelIdFor(
  modelString: string,
  baseURL: string | undefined,
  compat: ApiCompat,
): string {
  if (isAnyRouterBaseUrl(baseURL)) return toAnyRouterCallableModelId(modelString);
  if (useOpenAI(compat)) return toGatewayModelId(modelString);
  return anthropicModelId(modelString);
}

function peekRequestModel(init?: RequestInit): string | undefined {
  if (typeof init?.body !== "string") return undefined;
  try {
    const parsed = JSON.parse(init.body) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : undefined;
  } catch {
    return undefined;
  }
}

export function resolveModel(
  model: string | { id: string; speed?: "standard" | "fast" },
  apiKey: string,
  baseURL?: string,
  compat?: ApiCompat,
  customHeaders?: Record<string, string>,
): LanguageModel {
  const modelString = typeof model === "string" ? model : model.id;
  const effectiveCompat = compat || "ant";
  const wireId = wireModelIdFor(modelString, baseURL, effectiveCompat);

  // Identify OMA to a gateway's dashboard (AnyRouter / OpenRouter) instead of
  // landing in its raw user-agent bucket. Caller-supplied headers still win,
  // so a deployment can re-attribute its own traffic.
  const attribution = attributionHeadersFor(baseURL);

  if (useOpenAI(effectiveCompat)) {
    const openaiHeaders = attribution ? { ...attribution, ...customHeaders } : customHeaders;
    const openai = createOpenAI({
      apiKey,
      baseURL: baseURL || undefined,
      headers: openaiHeaders,
      fetch: observingFetch,
    });
    // Use chat/completions endpoint, not Responses API.
    // Reasons:
    //   - Third-party OpenAI-compat gateways (CF AI Gateway, Groq, DeepSeek,
    //     xAI Grok, etc.) only support /v1/chat/completions
    //   - Responses API requires server-side persistence of function call IDs;
    //     orgs with Zero Data Retention enabled get "Item with id 'fc_...' not
    //     found" errors mid-loop
    //   - chat/completions is the de-facto standard contract for OpenAI-compat
    // Keep the FULL model string (e.g. "google/gemini-2.5-flash") for
    // OpenAI-compatible gateways — AnyRouter/OpenRouter address models as
    // "provider/model", so stripping the prefix yields "model_unavailable".
    // Bare `claude-*` handles become `anthropic/claude-*` on generic
    // gateways. AnyRouter aliases hyphenated sonnet-4-6 onto dotted
    // BYOK-only `anthropic/claude-sonnet-4.6`, so this call site (the
    // JSON `model` field SessionDO and Node both go through) sends
    // `anyrouter/free` instead. OpenRouter and other hosts keep
    // toGatewayModelId.
    return openai.chat(wireId);
  }

  // ant / ant-compatible. Known-Claude max_tokens defaults follow the
  // *wire* id so a remapped `anyrouter/free` is not treated as Claude.
  const isKnownClaude = anthropicModelId(wireId).startsWith(KNOWN_CLAUDE_PREFIX);

  const headers: Record<string, string> = {};
  if (baseURL) headers["X-Sub-Module"] = "managed-agents";
  if (attribution) Object.assign(headers, attribution);
  if (customHeaders) Object.assign(headers, customHeaders);

  // @ai-sdk/anthropic appends `/messages` directly to baseURL — no `/v1`
  // segment is added. Real api.anthropic.com endpoints include `/v1` in the
  // SDK default, so deployments pointing at proxies must too. Auto-append
  // `/v1` if the user supplied a bare host so common env values work.
  const normalizedBaseURL = baseURL
    ? /\/v\d+(\/)?$/.test(baseURL)
      ? baseURL.replace(/\/$/, "")
      : `${baseURL.replace(/\/$/, "")}/v1`
    : undefined;

  const anthropic = createAnthropic({
    apiKey,
    baseURL: normalizedBaseURL,
    headers: Object.keys(headers).length > 0 ? headers : undefined,
    // setMaxTokensFetch composes observingFetch internally for non-Claude;
    // Claude path uses observingFetch directly so 429/rate-limit logging
    // applies regardless of which provider/model we're talking to.
    fetch: isKnownClaude ? observingFetch : setMaxTokensFetch,
  });

  return anthropic(wireId);
}

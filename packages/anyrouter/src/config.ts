// AnyRouter (https://anyrouter.dev) — shared constants for the upstream
// provider integration + OAuth (PKCE) connect flow.
//
// AnyRouter is an OpenAI-compatible LLM gateway: `POST /chat/completions`
// (OpenAI wire format) and `POST /messages` (Anthropic wire format), model
// ids shaped "provider/model" (e.g. "anthropic/claude-sonnet-4-6"), and
// inference API keys prefixed "sk-ar-".

export const ANYROUTER_ORIGIN = "https://anyrouter.dev";

/** Base URL for AnyRouter's REST API — set as the agent's ANTHROPIC_BASE_URL
 *  (or model-card base_url) once connected. */
export const ANYROUTER_API_BASE = `${ANYROUTER_ORIGIN}/api/v1`;

/** MCP OAuth 2.1 + PKCE + Dynamic Client Registration endpoints
 *  (packages/api-app/src/api/v1/mcp/oauth/* in the anyrouter repo). Open DCR
 *  means no pre-shared client secret is required — any app can register a
 *  client_id at connect time and run a standard authorization_code + PKCE
 *  dance to mint a scoped `sk-ar-…` key for the signed-in AnyRouter user.
 */
export const ANYROUTER_OAUTH_REGISTER_URL = `${ANYROUTER_API_BASE}/mcp/oauth/register`;
export const ANYROUTER_OAUTH_AUTHORIZE_URL = `${ANYROUTER_API_BASE}/mcp/oauth/authorize`;
export const ANYROUTER_OAUTH_TOKEN_URL = `${ANYROUTER_API_BASE}/mcp/oauth/token`;

/** Model catalog — structured JSON, requires the minted key as bearer. */
export const ANYROUTER_MODELS_URL = `${ANYROUTER_API_BASE}/models`;

/** Every AnyRouter inference key starts with this prefix. */
export const ANYROUTER_KEY_PREFIX = "sk-ar-";

/** Wire format AnyRouter speaks on `/chat/completions` — matches OMA's
 *  ApiCompat union in apps/agent/src/harness/provider.ts. */
export const ANYROUTER_API_COMPAT = "oai" as const;

/**
 * Map an agent model handle onto the `provider/model` id AnyRouter and
 * OpenRouter expect on the OpenAI-compat path.
 *
 * Bare `claude-*` handles (the seeded General agent, AGENTS.md examples)
 * become `anthropic/claude-*`. Ids that already contain `/` are returned
 * unchanged. Hyphens are kept — rewriting them to dots produces
 * `anthropic/claude-sonnet-4.6`, which those catalogs treat as BYOK-only
 * and 404 with `model_unavailable`.
 */
export function toGatewayModelId(handle: string): string {
  const trimmed = handle.trim();
  if (trimmed.includes("/")) return trimmed;
  if (trimmed.startsWith("claude-")) return `anthropic/${trimmed}`;
  return trimmed;
}

/** OAuth scope bundle to request. AnyRouter's consent screen lets the user
 *  downgrade to a narrower bundle regardless of what's requested; "standard"
 *  covers inference + key/preset management, which is what an agent runtime
 *  needs (no BYOK / management-key admin surface). The extra `read:presets`
 *  and `read:credits` scopes let the connected key read the account's saved
 *  presets (surfaced by GET /models) and credit balance (GET /credits).
 *  Space-separated per RFC 6749 §3.3. */
export const ANYROUTER_OAUTH_SCOPE = "standard read:presets read:credits";

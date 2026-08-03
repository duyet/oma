// App-attribution headers for the LLM gateways OMA can route through:
//   - AnyRouter  https://docs.anyrouter.dev/features/app-attribution
//   - OpenRouter https://openrouter.ai/docs/app-attribution
//
// Without them a gateway buckets OMA's traffic under a raw user-agent
// ("ua-raw-…") instead of naming the app in its rankings/analytics. Both
// gateways key off `HTTP-Referer` as the primary identifier and take a
// vendor-prefixed title + categories alongside it.
//
// Values are compile-time constants — never per-request or time-derived —
// so a request's header set is byte-identical across a process's lifetime.

export const OMA_APP_URL = "https://oma.duyet.net";
export const OMA_APP_TITLE = "OMA";

/** AnyRouter-only: platform/channel identifier for dashboard filtering. */
const ANYROUTER_SOURCE = "managed-agents";

/** Marketplace category. OpenRouter publishes a closed vocabulary and
 *  silently ignores anything outside it; "cloud-agent" is the entry that
 *  matches a hosted agent platform. AnyRouter mirrors the same convention. */
const APP_CATEGORY = "cloud-agent";

const ANYROUTER_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "HTTP-Referer": OMA_APP_URL,
  "X-AnyRouter-Title": OMA_APP_TITLE,
  "X-AnyRouter-Source": ANYROUTER_SOURCE,
  "X-AnyRouter-Categories": APP_CATEGORY,
});

const OPENROUTER_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "HTTP-Referer": OMA_APP_URL,
  "X-OpenRouter-Title": OMA_APP_TITLE,
  "X-OpenRouter-Categories": APP_CATEGORY,
});

/** Host matched exactly or as a parent domain — not a substring of the whole
 *  URL, so a path or query mentioning the gateway on someone else's host
 *  never gets OMA's identity attached. */
function hostMatches(baseURL: string | undefined, domain: string): boolean {
  if (!baseURL) return false;
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return false;
  }
}

export function isAnyRouterBaseUrl(baseURL: string | undefined): boolean {
  return hostMatches(baseURL, "anyrouter.dev");
}

export function isOpenRouterBaseUrl(baseURL: string | undefined): boolean {
  return hostMatches(baseURL, "openrouter.ai");
}

/**
 * Attribution headers for `baseURL`, or undefined when it points at a
 * provider that has no attribution contract (direct Anthropic/OpenAI, a
 * self-hosted proxy, …).
 */
export function attributionHeadersFor(
  baseURL: string | undefined,
): Readonly<Record<string, string>> | undefined {
  if (isAnyRouterBaseUrl(baseURL)) return ANYROUTER_HEADERS;
  if (isOpenRouterBaseUrl(baseURL)) return OPENROUTER_HEADERS;
  return undefined;
}

# Configuration

The variables that gate boot and at-rest safety:

| Variable | Required | Description |
|---|---|---|
| `PLATFORM_ROOT_SECRET` | **Yes** | AES-GCM key for `credentials.auth`, `model_cards.api_key_cipher`, and integration tokens. Workers refuse to start without it. **Back this up** — losing it makes every encrypted row unreadable. Generate with `openssl rand -base64 32`. |
| `BETTER_AUTH_SECRET` | **Yes** (prod) | better-auth session signing key. Sessions don't survive restart if missing. Generate with `openssl rand -hex 32`. |
| `API_KEY` | Yes | Bootstrap key for the REST API in dev / first-run. `.env.example` and `.dev.vars.example` ship `dev-test-key-change-me`. Once the Console is up, prefer per-tenant API keys minted from there. |
| `INTEGRATIONS_INTERNAL_SECRET` | Yes (if `apps/integrations` runs) | Shared secret between `apps/main` and `apps/integrations`. |
| `ANTHROPIC_API_KEY` | No | Fallback LLM credential used when a tenant has not added a Model Card. **In production, add a Model Card per tenant from the Console** — the key is encrypted at rest under `PLATFORM_ROOT_SECRET`, scoped to the tenant, and rotatable without redeploy. |
| `ANTHROPIC_BASE_URL` | No | Override for Anthropic-compatible proxies. |
| `PUBLIC_BASE_URL` | No (dev) / Yes (prod) | Cookie domain + OAuth redirect base. Defaults to `*` trusted-origins — only safe for local dev. |
| `SANDBOX_PROVIDER` | No | Fallback default when an environment has no explicit provider selection. See multi-provider docs below for per-environment `config.sandbox_provider` and BYOK registration. |
| `TAVILY_API_KEY` | No | Only needed for the `web_search_tavily` tool-type variant — `web_search` defaults to free DuckDuckGo with no key required. |
| `DAYTONA_API_KEY` | No | Enables Daytona sandbox provider (seeded at startup). |
| `E2B_API_KEY` | No | Enables E2B sandbox provider (seeded at startup). |
| `BOXRUN_URL` | No | Enables BoxRun sandbox provider (seeded at startup). |
| `OMA_TELEMETRY_DISABLED` | No | Set to `1` to fully opt out of anonymous install telemetry (see [Telemetry](telemetry.md)). `OMA_TELEMETRY=0` and `DO_NOT_TRACK=1` are honored too. |
| `OMA_DEPLOYMENT_KIND` | No | Overrides the reported deployment kind (`cloudflare` / `node-docker` / `k8s`). |
| `OMA_TELEMETRY_ENDPOINT` | No | Override the collector URL (default `https://app.oma.duyet.net`). Point at your own instance to keep telemetry private. |

Multi-provider sandbox: providers can be seeded from env vars (system) or added
via `POST /v1/sandbox_providers` (BYOK). Environments select a provider by ID
via `config.sandbox_provider` — fallback chain: per-environment ID → legacy
`config.type` → `SANDBOX_PROVIDER` env → `subprocess`.

Full list (integrations OAuth credentials, Postgres URL, sandbox tunables, memory-bucket config, Google sign-in, etc.) — see **[docs.oma.duyet.net/reference/configuration](https://docs.oma.duyet.net/reference/configuration/)** and `.env.example` / `.dev.vars.example`.

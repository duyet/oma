// Cloudflare bindings for the integrations gateway worker.
//
// Keep this file small. It is the single typed surface for env access; every
// other file should consume Env via the composition root, not directly from
// `c.env`.

export interface Env {
  // Control-plane DB — user / tenant / vault / session metadata. Shared
  // with apps/main.
  MAIN_DB: D1Database;

  // Integration subsystem DB — linear_* / github_* / slack_* tables.
  // Separate D1 database from MAIN_DB. Schema in
  // apps/main/migrations-integrations/.
  INTEGRATIONS_DB: D1Database;

  // Service binding to the main worker for session creation / resume.
  MAIN: Fetcher;

  // Public origin where this gateway worker is reachable. Used to build
  // OAuth callback and webhook URLs surfaced to Linear / Slack / etc.
  // No trailing slash. e.g. "https://integrations.example.com".
  GATEWAY_ORIGIN: string;

  // Public origin of the Console (e.g. "https://app.example.com"). No
  // trailing slash. Optional — used only to absolutize the fallback console
  // path when an install callback's state carried no returnUrl (expired
  // state, or an install started from the App's own github.com page). This
  // gateway runs on its own origin and serves no Console, so without it the
  // browser resolves the fallback path here and hits a 404 instead of
  // landing back in OMA.
  CONSOLE_ORIGIN?: string;

  // Signs short-lived JWTs handed to agent sessions for MCP tool calls.
  // Also used as the seed for AES-GCM token-at-rest encryption (with a
  // distinct label per use, so JWT signing keys ≠ token encryption keys).
  PLATFORM_ROOT_SECRET: string;

  // Shared secret with apps/main, gating /v1/internal/* endpoints. Must match
  // INTEGRATIONS_INTERNAL_SECRET on the main worker.
  INTEGRATIONS_INTERNAL_SECRET: string;

  // Healthchecks.io ping URL for cron job monitoring.
  // UUID: https://hc-ping.com/<uuid>  —or—  slug: https://hc-ping.com/<ping-key>/<slug>
  // When set, OMA sends start/success/failure pings for each cron tick.
  HEALTHCHECKS_IO_URL?: string;

  // Optional override for the GitHub MCP server URL. Defaults to the
  // GitHub-hosted MCP at https://api.githubcopilot.com/mcp/. Set to a
  // self-hosted endpoint (e.g. https://github-mcp.internal/) to point
  // agents at a relay you control.
  GITHUB_MCP_URL?: string;

  // Per-IP and per-tenant rate limit on webhook receivers. Optional —
  // middleware soft-passes when absent so dev / OSS deployments without
  // CF Rate Limiting configured still work. Tuned in wrangler.jsonc.
  RL_WEBHOOK_IP?: RateLimit;
  RL_WEBHOOK_TENANT?: RateLimit;

  // Optional shared secret gating the /admin/* debug endpoints. When set
  // (staging only — see apps/integrations/src/index.ts), the request must
  // present a matching `x-debug-token` header. Prod deployments leave it
  // unset and /admin/* always returns 404.
  TEMP_DEBUG_TOKEN?: string;

  // Telegram bot token for incoming webhook processing. When set, the
  // Telegram webhook route at /telegram/webhook is operational.
  TELEGRAM_BOT_TOKEN?: string;

  // Agent this bot's sessions run against, and the vault/environment they
  // bind to. All required for the webhook route to actually create/resume
  // sessions (TELEGRAM_BOT_TOKEN alone only gets you past the "not
  // configured" 503).
  TELEGRAM_AGENT_ID?: string;
  // Comma-separated vault ids.
  TELEGRAM_VAULT_IDS?: string;
  TELEGRAM_ENVIRONMENT_ID?: string;
  // Auto-idle threshold in milliseconds before a chat's session sandbox is
  // paused. Defaults to 5 minutes (DEFAULT_IDLE_TIMEOUT_MS in
  // @duyet/oma-telegram) when unset.
  TELEGRAM_IDLE_TIMEOUT_MS?: string;
  // Secret configured on Telegram's setWebhook call (secret_token param).
  // When set, incoming webhook requests must present a matching
  // `X-Telegram-Bot-Api-Secret-Token` header (constant-time compare) or the
  // request is rejected with 401. Unset — passthrough (no verification).
  TELEGRAM_WEBHOOK_SECRET?: string;
  // ─── Unified OAuth "Connect" flow (OMA-hosted OAuth apps) ──────────────
  // Per-provider OAuth app credentials backing the unified /oauth/:provider/*
  // install surface (apps/integrations/src/oauth-unified.ts). A provider whose
  // id/secret pair is unset is simply absent from the flow (routes 501). These
  // are the OMA developer-account OAuth apps described in issue #92 — set them
  // via `wrangler secret put` to enable one-click Connect for that provider.
  LINEAR_OAUTH_CLIENT_ID?: string;
  LINEAR_OAUTH_CLIENT_SECRET?: string;
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  SLACK_OAUTH_CLIENT_ID?: string;
  SLACK_OAUTH_CLIENT_SECRET?: string;

  // OMA-hosted managed Slack App credentials — powers the "Add to Slack"
  // one-click install (POST /slack/publications/start-managed). All three
  // must be set together; when any is missing the managed flow 503s and
  // callers fall back to the manifest/BYOA wizard. From api.slack.com →
  // your App → Basic Information (Client ID / Client Secret / Signing
  // Secret).
  SLACK_MANAGED_CLIENT_ID?: string;
  SLACK_MANAGED_CLIENT_SECRET?: string;
  SLACK_MANAGED_SIGNING_SECRET?: string;

  // OMA-hosted managed Linear OAuth App credentials — powers the "Add to
  // Linear" one-click install (POST /linear/publications/start-managed). All
  // three must be set together; when any is missing the managed flow 503s
  // and callers fall back to the OAuth/PAT wizard. From Linear's OAuth
  // Applications settings page (Client ID / Client Secret) plus the
  // webhook's Signing Secret ("lin_wh_…" value) shown on the same app's
  // webhook config.
  LINEAR_MANAGED_CLIENT_ID?: string;
  LINEAR_MANAGED_CLIENT_SECRET?: string;
  LINEAR_MANAGED_WEBHOOK_SECRET?: string;

  // OMA-hosted managed GitHub App identity — powers the "Add to GitHub"
  // one-click install (POST /github/publications/start-managed). All five
  // must be set together; when any is missing the managed flow 503s and
  // callers fall back to the App Manifest wizard. From
  // github.com/settings/apps/<slug> → General (App ID / App slug / bot
  // login are the app's own identity) and Private keys / Webhook secret
  // (the PEM and secret you generate there).
  //
  // IMPORTANT: configure this App's webhook URL on github.com as
  // `<gateway-origin>/github/webhook/managed` — NOT the per-App
  // `/github/webhook/app/<appOmaId>` path BYOA Apps use. A managed App has
  // one shared identity but many publications install it, each minting its
  // own appOmaId; the per-App path only delivers events to whichever
  // publication's id happens to be baked into the URL, leaving the rest
  // deaf. The `/managed` route resolves the publication from the payload's
  // `installation.id` instead, so it works for every managed install.
  GITHUB_MANAGED_APP_ID?: string;
  GITHUB_MANAGED_APP_SLUG?: string;
  GITHUB_MANAGED_BOT_LOGIN?: string;
  GITHUB_MANAGED_PRIVATE_KEY?: string;
  GITHUB_MANAGED_WEBHOOK_SECRET?: string;
  /** Managed App's OAuth client credentials. Only the "link existing
   *  installation" reconcile flow needs them — it identifies the human via
   *  GitHub's user-authorization flow so we can read back `GET
   *  /user/installations`. Unset ⇒ that flow reports itself unavailable;
   *  every other managed path keeps working. */
  GITHUB_MANAGED_CLIENT_ID?: string;
  GITHUB_MANAGED_CLIENT_SECRET?: string;
}

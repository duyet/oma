/** Config object returned to `WorkerLoader.get()`'s callback — describes the
 *  ephemeral Worker to spin up (Cloudflare Dynamic Workers). Typed locally
 *  rather than pulled from @cloudflare/workers-types so the shape is stable
 *  across type versions and Workers-pool tests can pass a fake binding. */
export interface DynamicWorkerCode {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, string>;
  /** `null` blocks all egress; a WorkerEntrypoint gateway intercepts+injects.
   *  Omit to inherit the parent worker's default (un-injected) egress. */
  globalOutbound?: unknown | null;
  compatibilityFlags?: string[];
  limits?: { cpuMs?: number; subRequests?: number };
}

/** Loaded ephemeral Worker handle returned by `WorkerLoader.get()`. */
export interface LoadedDynamicWorker {
  getEntrypoint(): { fetch(request: Request): Promise<Response> };
}

/** Cloudflare Worker Loader binding (Dynamic Workers). Bound only on the CF
 *  agent worker when `worker_loaders` is declared in wrangler.jsonc. Powers
 *  the opt-in `run_dynamic_worker` ("Code Mode") tool. */
export interface WorkerLoader {
  get(
    id: string,
    callback: () => DynamicWorkerCode | Promise<DynamicWorkerCode>,
  ): LoadedDynamicWorker;
}

export interface Env {
  CONFIG_KV: KVNamespace;
  /** Cloudflare Worker Loader binding (Dynamic Workers) — only bound on the
   *  agent worker when `worker_loaders` is declared in wrangler.jsonc. Absent
   *  on Node self-host and on CF deployments without the binding, in which
   *  case the opt-in `run_dynamic_worker` tool is omitted from buildTools(). */
  LOADER?: WorkerLoader;
  /** @deprecated Pre-shard binding. Equivalent to AUTH_DB_00 (the original
   *  openma-auth database) for back-compat during the shard rollout. New
   *  code MUST use `getShardForTenant(env, tenantId)` from
   *  @duyet/oma-sql-client to route to the correct shard. */
  MAIN_DB: D1Database;
  /** Tenant→shard routing table. Holds tenant_shard + shard_pool tables.
   *  Every per-tenant query reads this first (cached in SHARD_CACHE_KV
   *  with 1hr TTL). See packages/sql-client/src/shard.ts. */
  ROUTER_DB?: D1Database;
  /** Tenant data shard 0 — the original openma-auth, holds all
   *  pre-shard tenants. */
  AUTH_DB_00?: D1Database;
  AUTH_DB_01?: D1Database;
  AUTH_DB_02?: D1Database;
  AUTH_DB_03?: D1Database;
  /** Integration subsystem D1 (linear_* / github_* / slack_* tables).
   *  Separate database from MAIN_DB to isolate webhook write traffic and
   *  let the integration subsystem evolve schema independently.
   *  Optional on workers that don't touch integration tables (sandbox /
   *  agent workers). Required on apps/main and apps/integrations. */
  INTEGRATIONS_DB?: D1Database;
  /** Healthchecks.io ping URL for cron job monitoring.
   *  UUID format: https://hc-ping.com/<uuid>
   *  Slug format: https://hc-ping.com/<ping-key>/<slug>
   *  When set, OMA sends start/success/failure pings to healthchecks.io
   *  for each cron job tick. See https://healthchecks.io */
  HEALTHCHECKS_IO_URL?: string;
  /** Turn-level watchdog ceiling in ms (issue #135) — a harness/tool call
   *  that never resolves gets force-aborted (session.error + back to
   *  idle) once its turn has run this long. Default 15 min when unset;
   *  see DEFAULT_TURN_TIMEOUT_MS in apps/agent/src/runtime/session-do.ts
   *  for why that default is safe against the 10-min bash tool ceiling
   *  and long-running-harness heartbeats. */
  OMA_TURN_TIMEOUT_MS?: string;
  SEND_EMAIL?: SendEmail;
  // SESSION_DO and SANDBOX are only in sandbox workers
  SESSION_DO?: DurableObjectNamespace;
  SANDBOX?: DurableObjectNamespace;
  WORKSPACE_BUCKET?: R2Bucket;
  FILES_BUCKET?: R2Bucket;
  /** Memory store content bucket (Anthropic Managed Agents Memory model).
   *  Each memory keyed `<store_id>/<memory_path>`. R2 Event Notifications
   *  on this bucket route to the memory-events queue (see MEMORY_QUEUE).
   *  Mounted into agent sandboxes per attached store via
   *  sandbox.mountBucket(..., { prefix: "/<store_id>/", readOnly?: true }). */
  MEMORY_BUCKET?: R2Bucket;
  /** Optional producer binding for the memory-events queue. The queue is
   *  primarily fed by R2 Event Notifications (configured out-of-band via
   *  `wrangler r2 bucket notification create`); this binding only exists
   *  if some code path needs to enqueue messages directly (none today). */
  MEMORY_QUEUE?: Queue<R2EventMessage>;
  // Cloudflare Browser Rendering — only bound on agent worker (sandbox-default)
  BROWSER?: Fetcher;
  AI?: Ai;
  ASSETS?: { fetch: (req: Request) => Promise<Response> };
  /** Analytics Engine binding for structured error/event metrics. Optional —
   *  observability writes degrade to no-op when absent (dev / tests). See
   *  packages/shared/src/metrics.ts for the schema convention. */
  ANALYTICS?: AnalyticsEngineDataset;
  /** CF Workers Rate Limiting bindings — declared in wrangler.jsonc.
   *  Each one is a fixed-window counter keyed by .limit({ key }). Period
   *  must be 10 or 60 seconds; tune limits in wrangler config. */
  RL_AUTH_IP?: RateLimit;
  RL_AUTH_SEND_IP?: RateLimit;
  RL_AUTH_SEND_EMAIL?: RateLimit;
  RL_API_USER_WRITE?: RateLimit;
  RL_API_USER_READ?: RateLimit;
  RL_SESSIONS_TENANT?: RateLimit;
  /** Per-tenant cap on R2-writing endpoints (POST /v1/files,
   *  POST /v1/skills/:id/versions). Soft-passes when absent. */
  RL_UPLOAD_TENANT?: RateLimit;
  /** Per-email throttle on consumer magic-link requests (issue #162) —
   *  anti-spam-the-victim, mirrors RL_AUTH_SEND_EMAIL's threat model but
   *  scoped to the separate /v1/public/auth/* consumer realm. Soft-passes
   *  when absent. */
  RL_MAGICLINK_EMAIL?: RateLimit;
  /** Per-tenant cap on the MCP proxy forward path (issue #200) — the
   *  credential proxy (apps/main/src/routes/mcp-proxy.ts) is the only
   *  layer holding the plaintext upstream MCP bearer token, and every
   *  session on a tenant shares the same vault credential, so this bucket
   *  is keyed by tenant rather than session. Checked inside
   *  forwardWithRefresh so it covers all three callers (HTTP endpoint,
   *  RPC mcpForward/fetch, RPC outboundForward) from one chokepoint; also
   *  reused by the `_health` route's optional `?probe=1` connectivity
   *  check (issue #201) so probing can't bypass the same budget. Soft-passes
   *  when absent. */
  RL_MCP_PROXY_TENANT?: RateLimit;
  /** Daily session-creation budget per tenant. KV-backed counter — see
   *  apps/main/src/quotas.ts. The number is the cap; absent or "0" =
   *  feature off (OSS-friendly). Counter key auto-expires next day. */
  SESSION_DAILY_CAP_PER_TENANT?: number;
  /** Per-slug daily cap on public (/p/:slug) session creation. KV-backed
   *  counter in publicSessionCaps (apps/main/src/routes/publications.ts).
   *  Absent / "0" → feature off; parsed with a default of 50 at read site. */
  PUBLIC_SESSION_CAP_PER_SLUG?: string;
  /** Per-IP daily cap on public (/p/:slug) session creation. Same KV
   *  counter family as PUBLIC_SESSION_CAP_PER_SLUG; default 20. */
  PUBLIC_SESSION_CAP_PER_IP?: string;
  /** Single-upload body size cap in bytes for POST /v1/files and
   *  POST /v1/skills/:id/versions. Default 25MB if unset. */
  UPLOAD_MAX_BYTES?: number;
  /** Cloudflare Turnstile public site key. Surfaced to the Console via
   *  /auth-info; the Login page renders the widget when this is present
   *  and skips it (insecure!) when absent. Per CF, this is public —
   *  domain-bound, no secret. */
  TURNSTILE_SITE_KEY?: string;
  /** Cloudflare Turnstile secret key (wrangler secret put). The /auth/*
   *  middleware verifies tokens against CF's siteverify with this. When
   *  absent the middleware soft-passes — used during the brief window
   *  between deploying the code and provisioning the secret. */
  TURNSTILE_SECRET_KEY?: string;
  API_KEY: string;
  BETTER_AUTH_SECRET: string;
  /** Absolute base URL of the public auth origin, e.g.
   *  "https://app.oma.duyet.net". better-auth cannot infer the request
   *  origin reliably inside the Cloudflare Workers runtime (no HOST header
   *  it trusts), so without this it logs "Base URL could not be determined"
   *  and social-OAuth redirect URIs (the `redirect_uri` it sends to GitHub)
   *  are generated incorrectly — surfacing as 500s on /auth/sign-in/social.
   *  Set it on hosted deploys; self-host may leave unset (better-auth falls
   *  back to deriving from the request when possible). */
  BETTER_AUTH_URL?: string;
  /** When set, the better-auth session cookie is scoped to this domain
   *  (leading dot for cross-subdomain). Typical value on hosted:
   *  ".oma.duyet.net" so app.oma.duyet.net's auth cookie is also visible from
   *  the apex landing site. Self-hosters can leave unset for default
   *  per-host scoping. */
  AUTH_COOKIE_DOMAIN?: string;
  AUTH_COOKIE_NAME?: string;
  /**
   * Single-user local trial. `AUTH_DISABLED=1` makes every request
   * `tenant_id="default"` and `/auth-info` returns `providers: []` so the
   * Console skips login. Self-host Node and CF wrangler local. Do not use
   * in production.
   */
  AUTH_DISABLED?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  /** E2B API key. When set, /v1/hosting_types advertises the E2B external
   *  sandbox provider so environments can opt into it. Provisioning logic
   *  for E2B sessions is not yet wired — the flag only gates the option. */
  E2B_API_KEY?: string;
  /** BoxRun (boxlite serve) base URL, e.g. "http://boxrun:8100/v1/default".
   *  When set, an environment with `config.sandbox_provider: "boxrun"` (or
   *  legacy `config.type: "boxrun"`) resolves to a real BoxRunSandbox on
   *  the Cloudflare deployment instead of CloudflareSandbox — see
   *  apps/agent/src/runtime/sandbox.ts's `resolveCfSandbox`. Absent →
   *  selecting boxrun fails clearly with a session.error rather than
   *  silently falling back. */
  BOXRUN_URL?: string;
  /** Optional bearer token for the BoxRun control plane above. */
  BOXRUN_TOKEN?: string;
  BOXRUN_CPUS?: string;
  BOXRUN_MEMORY_MIB?: string;
  /** Container image passed to remote sandbox adapters (BoxRun / Daytona /
   *  E2B) that accept one. Default per-adapter (`ghcr.io/duyet/oma-runtime-base:latest`) when unset. */
  SANDBOX_IMAGE?: string;
  /** Kubernetes agent-sandbox namespace. When set, /v1/hosting_types
   *  advertises Kubernetes as a sandbox provider. The agent-sandbox
   *  controller CRD is used to provision pods. */
  OMA_K8S_NAMESPACE?: string;
  /** Modal API key (https://modal.com). When set, /v1/hosting_types
   *  advertises Modal as an external sandbox provider. Modal offers
   *  gVisor-isolated containers with optional GPU access (L4–B200),
   *  sub-second cold starts, filesystem/memory snapshots, and support
   *  for 50,000+ concurrent sessions. See https://modal.com/solutions/coding-agents
   *  and the official Modal Sandbox SDK docs. */
  MODAL_API_KEY?: string;
  // Console "Sign in with GitHub" — distinct from GITHUB_OAUTH_CLIENT_ID
  // below (that pair is for MCP-server / integration OAuth, not Console
  // login). Both set → better-auth registers github as a social provider.
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  // Pre-registered OAuth client_id/secret per provider, for MCP servers
  // whose authorization server doesn't expose a working DCR endpoint.
  // Operator workflow: register an OAuth App with the provider, set
  // callback URL to ${baseUrl}/v1/oauth/callback, copy the credentials
  // here. Without these, /v1/oauth/authorize returns 501 with a remediation.
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  FEISHU_OAUTH_CLIENT_ID?: string;
  FEISHU_OAUTH_CLIENT_SECRET?: string;
  LARK_OAUTH_CLIENT_ID?: string;
  LARK_OAUTH_CLIENT_SECRET?: string;
  ASANA_OAUTH_CLIENT_ID?: string;
  ASANA_OAUTH_CLIENT_SECRET?: string;
  CLICKUP_OAUTH_CLIENT_ID?: string;
  CLICKUP_OAUTH_CLIENT_SECRET?: string;
  SLACK_OAUTH_CLIENT_ID?: string;
  SLACK_OAUTH_CLIENT_SECRET?: string;
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_BASE_URL?: string;
  ANTHROPIC_MODEL?: string;
  /** Long-lived, non-interactive Claude Code auth token minted via
   *  `claude setup-token` — the CI/CD alternative to ANTHROPIC_API_KEY for
   *  `@anthropic-ai/claude-agent-sdk`'s CLI subprocess (ClaudeAgentSdkHarness,
   *  apps/main-node only; the SDK can't spawn a subprocess inside a CF
   *  Workers isolate). Used only when ANTHROPIC_API_KEY is unset. */
  CLAUDE_CODE_OAUTH_TOKEN?: string;
  /** Static-env-var fallback upstream provider (https://anyrouter.dev, an
   *  OpenAI-compatible LLM gateway — see @duyet/oma-anyrouter). Used by
   *  apps/agent's resolveModelCardCredentials when an agent's `model` handle
   *  matches no D1 model card AND ANTHROPIC_API_KEY is unset. Never
   *  overrides an explicit model card or a set ANTHROPIC_API_KEY. */
  ANYROUTER_API_KEY?: string;
  /** Dream pipeline curator mode override. `"dedup"` uses a deterministic
   *  no-network curator for tests and offline development. */
  DREAM_CURATOR_MODE?: string;
  /** Killswitch for the LLM full-body logging middleware (Part B of the
   *  dual-table refactor). When set to "1", apps/agent skips the
   *  per-step R2 PUT entirely AND drops `body_r2_key` from
   *  span.model_request_end events. Any other value (including unset)
   *  enables capture. Tenant-scoped opt-out is a future
   *  (TODO(llm-logging): add per-tenant flag in tenant config). */
  LLM_LOGS_DISABLED?: string;
  TAVILY_API_KEY?: string;
  /** Escape hatch for web_fetch's SSRF guard (./ssrf.ts). "1" or "true"
   *  lets web_fetch reach private/loopback/link-local/localhost targets —
   *  the http(s)-only scheme check still always applies. Off by default;
   *  only set this if the deployment intentionally wants web_fetch to
   *  reach internal services. */
  WEB_FETCH_ALLOW_PRIVATE?: string;
  CLOUDFLARE_API_TOKEN?: string;
  CLOUDFLARE_ACCOUNT_ID?: string;
  GITHUB_TOKEN?: string;
  GITHUB_REPO?: string;
  KV_NAMESPACE_ID?: string;
  RATE_LIMIT_WRITE?: number;
  RATE_LIMIT_READ?: number;
  // Shared with apps/integrations gateway. Gates /v1/internal/* endpoints.
  // Must match INTEGRATIONS_INTERNAL_SECRET on the integrations worker.
  INTEGRATIONS_INTERNAL_SECRET?: string;
  // Shared with packages/billing/ in openma-hosted. Gates the
  // /v1/internal/usage_events read+ack endpoints used by the hosted
  // billing reconcile cron. Self-host deployments leave it unset and
  // the endpoint returns 503; the OSS billing path is unreachable
  // without an out-of-band billing worker anyway.
  BILLING_INTERNAL_SECRET?: string;
  // Service binding to apps/integrations for proxying install initiation
  // calls from the Console (single-origin, no CORS).
  INTEGRATIONS?: Fetcher;
  // WorkerEntrypoint RPC binding from the agent worker to the main worker's
  // McpProxyRpc class — see apps/main/src/index.ts. Cloud agents call
  // `env.MAIN_MCP.mcpForward({tenantId, sessionId, serverName, ...})` so
  // vault credential lookup + token injection happen in main where the
  // secrets already live, never in the agent's DO. Optional because main
  // worker doesn't have this binding (it's the target, not a caller).
  //
  // `outboundForward` is the sandbox-side equivalent: any HTTPS request
  // the cloud agent's container makes is intercepted by oma-sandbox.ts
  // and routed through here for vault-credential injection by hostname
  // match. Same "credentials only ever live in main" property.
  MAIN_MCP?: {
    mcpForward(opts: {
      tenantId: string;
      sessionId: string;
      serverName: string;
      method: string;
      headers: Record<string, string>;
      body: string | null;
    }): Promise<{ status: number; headers: Record<string, string>; body: string }>;
    outboundForward(opts: {
      tenantId: string;
      sessionId: string;
      url: string;
      method: string;
      headers: Record<string, string>;
      body: ArrayBuffer | null;
    }): Promise<{ status: number; headers: Record<string, string>; body: ArrayBuffer }>;
    /**
     * Lightweight credential lookup for the transparent outbound proxy.
     * Returns the bearer token to inject for `hostname`, or null if no
     * vault credential matches. Used by oma-sandbox.ts inject_vault_creds
     * to keep body + response off the RPC wire (preserves HEAD,
     * streaming, SigV4 signed headers, etc).
     */
    lookupOutboundCredential(opts: {
      tenantId: string;
      sessionId: string;
      hostname: string;
    }): Promise<{ type: "bearer"; token: string } | null>;
    /**
     * Per-repo GitHub credential lookup for the network-layer proxy
     * (oma-sandbox.ts githubAuthHandler). Returns the picked token +
     * scheme for the request URL, or null when no github_repository
     * resource is attached to the session. See lib/github-creds.ts in
     * apps/main for the picking rule.
     */
    lookupGithubCredential(opts: {
      tenantId: string;
      sessionId: string;
      hostname: string;
      pathname: string;
    }): Promise<{ scheme: "Basic" | "Bearer"; token: string; slug: string } | null>;
    /**
     * Transparent HTTP proxy for the cloud agent's MCP traffic. Agent
     * worker hands AI SDK's MCP HTTP transport a custom fetch that calls
     * `env.MAIN_MCP.fetch(req)` with three metadata headers
     * (`x-oma-tenant`, `x-oma-session`, `x-oma-mcp-server`); main worker
     * resolves the vault credential, replaces the Authorization header,
     * strips the metadata, and forwards to the upstream. Body / headers
     * / status / Mcp-Session-Id stream through both ways unchanged, so
     * the SDK owns the protocol details (Streamable-HTTP session ids,
     * SSE responses, retries) and a server-side spec change can't break
     * us. Vault credentials still only live in main.
     */
    fetch(request: Request): Promise<Response>;
    /**
     * Resolve a registered remote OMA instance for cross-instance federation
     * (issue #132). Returns the remote base URL + decrypted API key so the
     * agent DO can drive a session on the remote instance, or null when no
     * such instance is registered for the tenant. The agent DO has no KV /
     * PLATFORM_ROOT_SECRET access, so this resolution happens main-side —
     * mirroring the vault-credential lookups above.
     */
    resolveFederationTarget?(opts: {
      tenantId: string;
      instanceId: string;
    }): Promise<{ base_url: string; api_key?: string } | null>;
  };
  // Public URL of the integrations gateway (used to build redirect URLs to
  // OAuth callbacks etc. when the gateway is on a different host).
  INTEGRATIONS_PUBLIC_URL?: string;
  // Used by integrations subsystem to sign tokens at rest. Gateway's value.
  PLATFORM_ROOT_SECRET?: string;
  // Killswitch for per-tenant D1 routing. Unset / "true" / anything else =
  // routing enabled (the default — uses tenant_shard meta table). Set to
  // "false" or "0" to roll back to the shared-MAIN_DB provider without
  // redeploying code. Implemented in
  // packages/services/src/index.ts buildCfTenantDbProvider.
  PER_TENANT_DB_ENABLED?: string;
  // Per-store backend selection. JSON object mapping store key (e.g.
  // "agents", "sessions") to backend name ("cf" | "pg" | "memory"). Missing
  // entries default to "cf". Lets a deployment route a single store to a
  // self-hosted Postgres without touching service or route code — the
  // adapter layer is the only thing that changes.
  // Example: STORE_BACKENDS={"agents":"pg","sessions":"cf"}
  STORE_BACKENDS?: string;
  // Postgres connection string used by any pg-backed store. On Cloudflare
  // Workers, point this at a Hyperdrive connection string for production;
  // direct DSN works in local dev / Node deployments.
  DATABASE_URL?: string;
  /** Local-ACP-runtime control plane DO. Pairs the user's `oma bridge daemon`
   *  WebSocket with the ACP-proxy harness inside SessionDO so a session can
   *  delegate its agent loop to a Claude Code (or other ACP) child running
   *  on the user's machine. Bound only on apps/main. */
  RUNTIME_ROOM?: DurableObjectNamespace;
  /** Service binding from per-env sandbox workers back to the main worker.
   *  AcpProxyHarness uses this to call /v1/internal/runtime-turn — going
   *  through HTTP keeps the auth surface narrow (one internal-secret-gated
   *  endpoint) and avoids a cross-script DO binding. Bound on apps/agent. */
  MAIN?: Fetcher;
  /**
   * R2 S3 API credentials for sandbox containers to mount R2 buckets via
   * S3FS-FUSE (sandbox SDK's `RemoteMountBucketOptions`). When all three
   * are present, the sandbox uses FUSE mode (writes flow synchronously
   * over the S3 API and trigger R2 Event Notifications). When absent,
   * mountBucket falls back to `localBucket: true` — fine for `wrangler
   * dev`, but writes silently don't persist to R2 in production.
   *
   * R2 binding (e.g. `MEMORY_BUCKET`) is Worker-only; it can't be reached
   * from inside the sandbox container. These keys give the container
   * direct S3 access. Mint via CF Dashboard → R2 → Manage R2 API Tokens.
   */
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_ENDPOINT?: string;
  /**
   * Resolved bucket NAMES per environment — needed when mounting via FUSE
   * because the S3 API takes the actual bucket name (not the binding name).
   * Set via `vars` in wrangler.jsonc; overridden in env.staging.
 *   prod:    "oma-managed-agents-memory"
 *   staging: "oma-managed-agents-memory-staging"
   */
  MEMORY_BUCKET_NAME?: string;
  WORKSPACE_BUCKET_NAME?: string;
  /**
   * BACKUP_BUCKET_NAME (also CLOUDFLARE_ACCOUNT_ID above) are required by
   * @cloudflare/sandbox createBackup() in production mode — the SDK
   * mints R2 presigned URLs to upload the squashfs and needs both to
   * construct the URL. Without them createBackup throws
   * InvalidBackupConfigError. See sandbox.ts createWorkspaceBackup.
   */
  BACKUP_BUCKET_NAME?: string;
}

/**
 * Cloudflare R2 Event Notification message body. R2 publishes one of these
 * per object mutation when the bucket is wired to a Queue via
 * `wrangler r2 bucket notification create <bucket> --event-type ... --queue ...`.
 * The shape mirrors the public R2 events spec; if/when @cloudflare/workers-types
 * exports an official type for this, switch to it.
 */
export interface R2EventMessage {
  account: string;
  action:
    | "PutObject"
    | "CopyObject"
    | "CompleteMultipartUpload"
    | "DeleteObject"
    | "LifecycleDeletion";
  bucket: string;
  object: {
    key: string;
    size?: number;
    eTag?: string;
    version?: string;
  };
  eventTime: string;
  copySource?: { bucket: string; object: string };
}

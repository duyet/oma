import { Hono } from "hono";
import { WorkerEntrypoint } from "cloudflare:workers";
import type { Env } from "@duyet/oma-shared";
import { servicesMiddleware, tenantDbMiddleware, getCfServicesForTenant, buildCfTenantDbProvider, type Services } from "@duyet/oma-services";
import {
  buildAgentRoutes,
  buildVaultRoutes,
  buildSessionRoutes,
  buildApiKeyRoutes,
  buildMeRoutes,
  buildTenantRoutes,
  buildTenantMemberRoutes,
  buildInviteAcceptRoutes,
  type InviteRoutesDeps,
  buildPublicationRoutes,
  buildAgentPublicationRoutes,
  buildDeviceRoutes,
  buildMcpServerRoutes,
  buildFederationRoutes,
  buildOmaMcpRoutes,
  buildAnalyticsRoutes,
  buildTelemetryRoutes,
  buildScheduleRoutes,
  buildTenantScheduleRoutes,
  buildModelCardRoutes,
  buildStatsRoutes,
  buildUsageRoutes,
  buildSkillRoutes,
  mintApiKeyOnStorage,
  type RouteServices,
} from "@duyet/oma-http-routes";
import { DefaultQuotaService } from "@duyet/oma-quotas";
import {
  buildPublicPublicationRoutes,
  publicSessionCaps,
  gatePublicationState,
} from "./routes/publications";
import {
  createCfShardPoolService,
  createCfTenantShardDirectoryService,
} from "@duyet/oma-tenant-dbs-store";
import {
  buildLabeledCrypto,
  FEDERATION_CRYPTO_LABEL,
  resolveFederationInstance,
} from "@duyet/oma-shared";
import { toEnvironmentConfig } from "@duyet/oma-environments-store";
import { authMiddleware } from "./auth";
import { rateLimitMiddleware, authRateLimitMiddleware } from "./rate-limit";
import { cfRouteServices, cfRouteServicesForTenant } from "./lib/cf-route-services";
import { cfApiKeyStorage } from "./lib/cf-api-key-storage";
import { CfSessionRouter } from "./lib/cf-session-router";
import {
  cfSessionLifecycle,
  cfOutputsAdapter,
  fetchVaultCredentials,
} from "./lib/cf-session-lifecycle";
import { validateAgentLimits } from "./lib/limits";
import { listMemberships, hasMembership, sendEmail } from "./auth-config";
import environmentsRoutes from "./routes/environments";
import oauthRoutes from "./routes/oauth";
import capCliOauthRoutes from "./routes/cap-cli-oauth";
import memoryRoutes from "./routes/memory";
import dreamsRoutes from "./routes/dreams";
import filesRoutes from "./routes/files";
import modelsRoutes from "./routes/models";
import clawhubRoutes from "./routes/clawhub";
import evalsRoutes from "./routes/evals";
import costReportRoutes from "./routes/cost-report";
import internalRoutes from "./routes/internal";
import integrationsRoutes from "./routes/integrations";
import { runtimesRoutes, runtimeDaemonRoutes, authenticateRuntimeToken } from "./routes/runtimes";
import browserVmHostRoutes from "./routes/browser-vm-host";
import agentStatsRoutes from "./routes/agent-stats";
import providersRoutes from "./routes/providers";
import sandboxProvidersRoutes from "./routes/sandbox-providers";
import webhookRoutes from "./routes/webhooks";
import consumerAuthRoutes, {
  resolveConsumerSession,
  verifyMagicLinkToken,
} from "./routes/consumer-auth";
import consumerMeteringRoutes from "./routes/consumer-metering";
import consumerAdminRoutes from "./routes/consumer-admin";
import paymentsWebhookRoutes, {
  buildConsumerPaymentsRoutes,
  buildPublicationPricingRoutes,
  enforcePaywall as enforcePaywallImpl,
  createD1PaymentsStore,
} from "./routes/payments";
import { CfD1SqlClient } from "@duyet/oma-sql-client/adapters/cf-d1";
import deploymentsRoutes, { deploymentHooksRoutes } from "./routes/deployments";
import mcpProxyRoutes, {
  resolveProxyTargetByTenant,
  resolveOutboundCredentialByHost,
  forwardWithRefresh,
} from "./routes/mcp-proxy";
import { resolveGithubCredentials } from "./lib/github-creds";
import { buildCfScheduler } from "./lib/cf-scheduler-jobs";
import { buildCfMemoryQueue, dispatchCfMemoryQueueBatch } from "./lib/cf-queue-handlers";
import {
  SandboxProviderRegistry,
  seedSystemProviders,
  SYSTEM_PROVIDERS,
  buildUnseededHostingTypes,
  describeProviderAvailability,
} from "@duyet/oma-sandbox";
import { logError, recordEvent, errFields } from "@duyet/oma-shared";
import { globalErrorHandler, requestMetricsMiddleware } from "./lib/observability";
import { errorEnvelopeMiddleware } from "./lib/error-envelope";
import { createBootSecretGate } from "./lib/boot-secrets";
import type { R2EventMessage } from "@duyet/oma-shared";

// Main worker: CRUD + routing layer.
// SessionDO and Sandbox are in per-environment sandbox workers.
// Environment builds are triggered via GitHub Actions.

// --- HTTP app ---
const app = new Hono<{ Bindings: Env }>();

// Request-level observability — must be the FIRST middleware so it
// captures every request including auth failures, rate-limit rejects,
// and unhandled exceptions. Pairs with globalErrorHandler below.
app.use("*", requestMetricsMiddleware);

// Normalize all 4xx/5xx JSON bodies into the Anthropic-compatible error
// envelope (`{type:"error", error:{type,message}, request_id}`) so callers
// of the official @anthropic-ai/sdk can `catch (e) { if (e.error?.error?.type
// === 'authentication_error') ... }`. Runs second so it sees the response
// body produced by every downstream middleware/handler. See lib/error-envelope.ts.
app.use("*", errorEnvelopeMiddleware);

// Fail closed on missing/leaked boot secrets (oma#220) — runs before any
// route, including /health, so a bad deploy can't serve anything. Computed
// once per isolate on the first request (Workers have no boot phase to
// hook) and memoized inside the gate; safe because secrets are static for
// an isolate's lifetime. See lib/boot-secrets.ts.
app.use("*", createBootSecretGate());

// Catch-all for anything that escapes per-route try/catch. Logs +
// records to AE before returning a clean 500 (no internal leak in body).
app.onError(globalErrorHandler);

// Hono's default notFound is a plain "404 Not Found" body — wrap it in the
// Anthropic envelope so SDK callers can `if (e.error?.error?.type ===
// 'not_found_error')` instead of relying on raw status codes. Returning a
// JSON body here makes errorEnvelopeMiddleware's already-canonical short
// path kick in.
app.notFound((c) =>
  c.json(
    {
      type: "error" as const,
      error: {
        type: "not_found_error",
        message: `No route matched ${c.req.method} ${c.req.path}`,
      },
    },
    404,
  ),
);

app.get("/health", (c) => c.json({ status: "ok" }));

// GET /v1/hosting_types — sandbox providers this host can run (public).
// Mirrors the SandboxProviderRegistry's getHostingTypes() on the Node build
// so the Console UI shows the same provider list across both deployments.
//
// `health.status` is one of "healthy" | "unhealthy" | "not_configured":
//   - "not_configured" — provider is seeded but has no credentials/env
//     wired up yet (e.g. Local subprocess before the daemon is connected).
//     The Console shows a "Set up" affordance for these.
// `health.reason` carries a human-readable explanation for unhealthy /
// not_configured states so the UI can tell the user *why*.
// True when at least one bridge runtime of the given kind has heartbeated
// within the online window. Used to flip the public `subprocess` health to
// "healthy" once a paired `oma bridge daemon` is connected (kind "daemon"),
// and `browser-vm` once a sandbox tab is open (kind "browser-vm").
// Best-effort — any error → false.
async function hasOnlineRuntime(env: { MAIN_DB?: D1Database }, kind: string): Promise<boolean> {
  if (!env.MAIN_DB) return false;
  const row = await env.MAIN_DB
    .prepare(
      `SELECT 1 AS one FROM "runtimes"
       WHERE status = 'online' AND last_heartbeat IS NOT NULL
         AND last_heartbeat > (unixepoch() - 120)
         AND kind = ?
       LIMIT 1`,
    )
    .bind(kind)
    .first<{ one: number }>();
  return !!row;
}

app.get("/v1/hosting_types", async (c) => {
  const registry = new SandboxProviderRegistry();
  registry.seedFromEnv(c.env as unknown as Record<string, string | undefined>);
  const providers = registry.list();

  const env = c.env as unknown as Record<string, string | undefined>;

  const healthResults = new Map<string, {
    status: "healthy" | "unhealthy" | "not_configured";
    latency_ms: number;
    last_checked: string;
    reason?: string;
    capacity?: import("@duyet/oma-sandbox").SandboxCapacity;
  }>();

  for (const p of providers) {
    try {
      const desc = SYSTEM_PROVIDERS.find((d) => d.type === p.type);
      // Local subprocess is always seeded but only "healthy" once a daemon
      // is connected. With no daemon it reports not_configured so the UI
      // can offer a connect dialog instead of a confusing "unhealthy".
      if ((p.type === "subprocess" || p.type === "browser-vm") && !desc?.envKeys.some((k) => env[k])) {
        // On the Cloudflare deployment a "local" (subprocess) environment runs
        // by relaying its sandbox ops to a paired `oma bridge daemon`, and a
        // "browser-vm" environment relays to a user's open sandbox tab (see
        // apps/agent/src/runtime/bridge-relay.ts + browser-vm-relay.ts).
        // Report "healthy" once any runtime of the matching kind is online —
        // this route is public/un-tenant-scoped, so it can only check global
        // online-runtime presence, not per-tenant.
        const kind = p.type === "browser-vm" ? "browser-vm" : "daemon";
        const online = await hasOnlineRuntime(c.env as unknown as { MAIN_DB?: D1Database }, kind).catch(() => false);
        healthResults.set(p.id, online
          ? {
              status: "healthy",
              latency_ms: 0,
              last_checked: new Date().toISOString(),
              reason: undefined,
            }
          : {
              status: "not_configured",
              latency_ms: 0,
              last_checked: new Date().toISOString(),
              reason: p.type === "browser-vm"
                ? "No sandbox tab connected. Open a browser sandbox tab from the Runtimes page to enable it."
                : "No local runtime connected. Run `npx @getoma/cli bridge setup` and start the oma bridge daemon on this machine to enable it.",
            });
        continue;
      }
      const h = await registry.checkHealth(p.id).catch(() => null);
      if (h) {
        healthResults.set(p.id, {
          status: h.status === "ok" ? "healthy" : "unhealthy",
          latency_ms: h.latencyMs,
          last_checked: h.lastChecked,
          reason: h.status === "ok" ? undefined : (h.details ?? "Health check failed."),
          capacity: h.capacity,
        });
      }
    } catch {}
  }

  const sysCap = (type: string): string[] =>
    SYSTEM_PROVIDERS.find((d) => d.type === type)?.capabilities ?? [];

  // `dynamic-workers` availability hangs off a *binding*, not an env var —
  // there is no secret that stands in for it, so probe the binding directly.
  const hasWorkerLoader = !!(c.env as unknown as { LOADER?: unknown }).LOADER;

  const types = providers.map((p) => {
    const health = healthResults.get(p.id);
    return {
      id: p.id,
      label: p.label,
      description: p.description ?? "",
      type: p.isSystem ? "system" : "byok",
      provider: p.type,
      external: !p.isSystem || !["subprocess", "cloud", "browser-vm"].includes(p.type),
      capabilities: sysCap(p.type),
      health: health ?? null,
      availability: describeProviderAvailability({
        providerId: p.type,
        runtime: "cloudflare",
        env,
        hasWorkerLoader,
      }),
    };
  });

  // Every provider this build ships that wasn't seeded still gets a row, so
  // the Console can say *why* it isn't usable here instead of omitting it.
  const seeded = new Set(providers.map((p) => p.type));
  const unseeded = buildUnseededHostingTypes(seeded, "cloudflare", env, { hasWorkerLoader });

  return c.json({ runtime: "cloudflare", data: [...types, ...unseeded] });
});

// Public consumer endpoints — no authMiddleware, use their own consumer
// token auth. Mounted before /v1/* auth so they bypass the standard gate.
app.route("/v1/public", consumerAuthRoutes);
app.route("/v1/public", consumerMeteringRoutes);
app.route("/v1/public", buildConsumerPaymentsRoutes());

// Stripe webhook (issue #74) — bypasses tenant auth (see auth.ts); trust is
// the Stripe signature verified inside the route.
app.route("/webhooks", paymentsWebhookRoutes);

// Auth routes (public — no authMiddleware, but rate-limited per-IP and
// per-email so a stranger can't spam OTP sends and burn the mail budget).
// Lazy import to avoid crashing workerd in test environments
app.use("/auth/*", authRateLimitMiddleware);
app.on(["GET", "POST"], "/auth/*", async (c) => {
  if (!c.env.MAIN_DB) return c.json({ error: "Auth not configured" }, 503);
  const { createAuth } = await import("./auth-config");
  return createAuth(c.env).handler(c.req.raw);
});

// Auth info endpoint (public — tells the frontend which providers are enabled
// and surfaces the Turnstile site key so the Login page can render the widget).
app.get("/auth-info", (c) => {
  const providers: string[] = ["email", "email-otp"];
  if (c.env.GOOGLE_CLIENT_ID && c.env.GOOGLE_CLIENT_SECRET) {
    providers.push("google");
  }
  if (c.env.GITHUB_CLIENT_ID && c.env.GITHUB_CLIENT_SECRET) {
    providers.push("github");
  }
  return c.json({
    providers,
    turnstile_site_key: c.env.TURNSTILE_SITE_KEY ?? null,
  });
});

// API routes (require authentication)
app.use("/v1/*", authMiddleware);
app.use("/v1/*", rateLimitMiddleware);
// Resolve the per-tenant D1 database for this request. Phase 1: returns the
// shared MAIN_DB for every tenant (zero behaviour change). Phase 4: routes
// to per-tenant bindings published by the CICD sync script.
app.use("/v1/*", tenantDbMiddleware);
// Build the platform-agnostic service container once per request and stash it
// on c.var.services. Wiring (CF / Postgres / SQLite) lives in
// packages/services — routes only see the abstract Services interface.
app.use("/v1/*", servicesMiddleware);

// Build agent / vault / api-keys / me / tenants from
// `@duyet/oma-http-routes`. Per-request `RouteServices` is
// resolved off `c.var.services` so the per-tenant D1 binding flows
// through; CF-only callbacks (model card validation, field-size limits,
// shard assignment, KV-backed api-key storage, MAIN_DB membership reads)
// get plumbed in here. Each mount is a Hono sub-app whose handler builds
// a one-shot package app per request — cheap (~µs of route registration)
// and keeps the per-tenant + per-request callbacks correctly scoped
// without leaking globals.

// Build agent / vault / api-keys / me / tenants / sessions from
// `@duyet/oma-http-routes`. Per-request `RouteServices` is
// resolved off `c.var.services` so the per-tenant D1 binding flows
// through; CF-only callbacks (model card validation, field-size limits,
// shard assignment, KV-backed api-key storage, MAIN_DB membership reads,
// USAGE_METER + refresh + GitHub fast-path lifecycle hooks) get plumbed
// in via closures over `c` so they always see the per-request services
// container without leaking globals.

type AppCtx = import("hono").Context<{
  Bindings: Env;
  Variables: {
    tenant_id: string;
    user_id?: string;
    services: import("@duyet/oma-services").Services;
    tenantDb: D1Database;
  };
}>;

const cfRouteServicesFromCtx = (c: AppCtx) =>
  cfRouteServices(c as never);

/** Build the RouteServices bundle for the publication's tenant (public
 *  /p/:slug surface) from an already-resolved Services container + DB. */
const cfRouteServicesFromCtxForTenant = (
  services: Services,
  tenantDb: D1Database,
): RouteServices => {
  return cfRouteServicesForTenant(services, tenantDb);
};

const agentsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const services = ctx.var.services;
  const app = buildAgentRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    federationCrypto: cfFederationCrypto(ctx.env),
    validateModel: async (tenantId, model) => {
      const cards = await services.modelCards.list({ tenantId });
      const active = cards.filter((card) => card.archived_at === null);
      if (active.length === 0) return { valid: true };
      const modelId = typeof model === "string" ? model : model.id;
      const match = active.find((card) => card.model_id === modelId);
      if (!match) {
        return {
          valid: false,
          error: `No model card with model_id "${modelId}". Create a card with that handle, or set agent.model to an existing card's model_id.`,
        };
      }
      return { valid: true };
    },
    validateAgentLimits: (body) =>
      validateAgentLimits(body as Parameters<typeof validateAgentLimits>[0]),
    hasActiveSessionsByAgent: (tenantId, agentId) =>
      services.sessions.hasActiveByAgent({ tenantId, agentId }),
    hasActiveEvalsByAgent: (tenantId, agentId) =>
      services.evals.hasActiveByAgent({ tenantId, agentId }),
  });
  return invokePackage(c, app);
});

const vaultsRoutes = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const app = buildVaultRoutes({ services: () => cfRouteServicesFromCtx(ctx) });
  return invokePackage(c, app);
});

const mcpServersRoutes = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const app = buildMcpServerRoutes({ services: () => cfRouteServicesFromCtx(ctx) });
  return invokePackage(c, app);
});

const analyticsRoutes = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const app = buildAnalyticsRoutes({ services: () => cfRouteServicesFromCtx(ctx) });
  return invokePackage(c, app);
});

const modelCardsRoutes = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const app = buildModelCardRoutes({ services: () => cfRouteServicesFromCtx(ctx) });
  return invokePackage(c, app);
});

const statsRoutes = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const app = buildStatsRoutes({ services: () => cfRouteServicesFromCtx(ctx) });
  return invokePackage(c, app);
});

const usageRoutes = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const app = buildUsageRoutes({ services: () => cfRouteServicesFromCtx(ctx) });
  return invokePackage(c, app);
});

// Skill upload abuse gates — same RL_UPLOAD_TENANT binding + UPLOAD_MAX_BYTES
// env var the legacy apps/main/src/quotas.ts used, now behind the portable
// QuotaService interface so packages/http-routes/src/skills stays runtime-
// agnostic. Soft-passes (uploadGate consume → {ok:true}) when the binding
// is unconfigured, matching the historical CF behavior.
const skillsRoutes = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const env = ctx.env;
  const quota = new DefaultQuotaService({
    kv: cfRouteServicesFromCtx(ctx).kv,
    uploadGate: {
      consume: async (key: string) => {
        if (!env.RL_UPLOAD_TENANT) return { ok: true };
        try {
          const r = await env.RL_UPLOAD_TENANT.limit({ key });
          return { ok: r.success };
        } catch {
          return { ok: true };
        }
      },
    },
    uploadMaxBytes: Number(env.UPLOAD_MAX_BYTES ?? 25 * 1024 * 1024),
  });
  const app = buildSkillRoutes({ services: () => cfRouteServicesFromCtx(ctx), quota });
  return invokePackage(c, app);
});

// Federation at-rest crypto for a request's env — shared by the registry
// routes and the federated-listing fan-out on /agents + /sessions
// (issue #132 M3). Absent PLATFORM_ROOT_SECRET ⇒ undefined, and fan-out
// degrades to a per-instance error marker instead of silently listing local
// rows only.
function cfFederationCrypto(env: unknown) {
  const secret = (env as { PLATFORM_ROOT_SECRET?: string }).PLATFORM_ROOT_SECRET;
  return secret ? buildLabeledCrypto(secret, FEDERATION_CRYPTO_LABEL) : undefined;
}

// Cross-instance federation registry (issue #132). The remote API key is
// encrypted at rest under FEDERATION_CRYPTO_LABEL off PLATFORM_ROOT_SECRET.
const federationRoutes = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const app = buildFederationRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    crypto: cfFederationCrypto(c.env),
  });
  return invokePackage(c, app);
});

// Public, unauthenticated CLI telemetry (POST /events, GET /stats). No
// `rateLimit` dep needed — /v1/* already runs rateLimitMiddleware (see the
// app.use("/v1/*", ...) below).
const telemetryRoutes = new Hono<{ Bindings: Env; Variables: { tenant_id: string } }>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const app = buildTelemetryRoutes({ services: () => cfRouteServicesFromCtx(ctx) });
  return invokePackage(c, app);
});

const apiKeysRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const services = ctx.var.services;
  const app = buildApiKeyRoutes({ storage: cfApiKeyStorage(services.kv) });
  return invokePackage(c, app);
});

const meRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const env = ctx.env;
  const services = ctx.var.services;
  const app = buildMeRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    authDisabled: false,
    loadUser: async (userId) => {
      if (!env.MAIN_DB) return null;
      const r = await env.MAIN_DB
        .prepare(`SELECT id, email, name FROM "user" WHERE id = ?`)
        .bind(userId)
        .first<{ id: string; email: string; name: string | null }>();
      return r ?? null;
    },
    loadTenant: async (tenantId) => {
      if (!env.MAIN_DB) return null;
      const r = await env.MAIN_DB
        .prepare(`SELECT id, name FROM tenant WHERE id = ?`)
        .bind(tenantId)
        .first<{ id: string; name: string }>();
      return r ?? null;
    },
    listMemberships: (userId) => listMemberships(env.MAIN_DB, userId),
    hasMembership: (userId, tenantId) => hasMembership(env.MAIN_DB, userId, tenantId),
    mintApiKey: (input) =>
      mintApiKeyOnStorage(cfApiKeyStorage(services.kv), input),
  });
  return invokePackage(c, app);
});

// Device Authorization Grant (RFC 8628) for `oma auth login --device`.
// /code + /token are public (auth bypassed in auth.ts); /approve requires
// a cookie session (c.var.user_id populated by authMiddleware on the
// protected /v1/device/approve path only — see auth.ts skip list).
const deviceRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const env = ctx.env;
  const services = ctx.var.services;
  const app = buildDeviceRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    mintApiKey: (input) => mintApiKeyOnStorage(cfApiKeyStorage(services.kv), input),
    hasMembership: (userId, tenantId) => hasMembership(env.MAIN_DB, userId, tenantId),
    loadTenant: async (tenantId) => {
      if (!env.MAIN_DB) return null;
      const r = await env.MAIN_DB
        .prepare(`SELECT id, name FROM tenant WHERE id = ?`)
        .bind(tenantId)
        .first<{ id: string; name: string }>();
      return r ?? null;
    },
  });
  return invokePackage(c, app);
});

const tenantsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const env = ctx.env;
  const app = buildTenantRoutes({
    services: () => cfRouteServicesFromCtx(ctx),
    createTenantAndMembership: async ({ tenantId, name, userId }) => {
      const now = Math.floor(Date.now() / 1000);
      await env.MAIN_DB.batch([
        env.MAIN_DB
          .prepare("INSERT INTO tenant (id, name, createdAt, updatedAt) VALUES (?, ?, ?, ?)")
          .bind(tenantId, name, now, now),
        env.MAIN_DB
          .prepare(
            "INSERT INTO membership (user_id, tenant_id, role, created_at) VALUES (?, ?, 'owner', ?)",
          )
          .bind(userId, tenantId, now),
      ]);
    },
    assignShard: async (tenantId) => {
      const controlPlaneDb = env.ROUTER_DB ?? env.MAIN_DB;
      const shardPool = createCfShardPoolService({ controlPlaneDb });
      const tenantShardDirectory = createCfTenantShardDirectoryService({ controlPlaneDb });
      const pick = await shardPool.pickShardForNewTenant();
      const bindingName = pick?.bindingName ?? "AUTH_DB_00";
      await tenantShardDirectory.assign({ tenantId, bindingName });
      await shardPool.incrementTenantCount(bindingName);
    },
  });
  return invokePackage(c, app);
});

// ─── Tenant teammate invites (issue #175) ─────────────────────────────────
// Members + invite management (/v1/tenant) and token-keyed accept
// (/v1/invites). Invites live in MAIN_DB next to tenant/membership so accept
// writes a membership row in the same store. Membership timestamps stay
// unix-seconds to match the legacy createTenantAndMembership rows; invite
// timestamps are ms (the pagination cursor convention).
function cfInviteDeps(env: Env): InviteRoutesDeps {
  const db = env.MAIN_DB;
  const invEmail = (to: string, tenantName: string | null, role: string, url: string) => {
    const ws = tenantName || "a workspace";
    return {
      subject: `You've been invited to join ${ws} on OMA`,
      html: `<p>You've been invited to join <strong>${ws}</strong> as <strong>${role}</strong>.</p>` +
        `<p><a href="${url}">Accept the invitation</a></p>` +
        `<p>Or paste this link into your browser:<br>${url}</p>`,
      text: `You've been invited to join ${ws} as ${role}.\n\nAccept: ${url}\n`,
    };
  };
  return {
    authDisabled: false,
    getRole: async (userId, tenantId) => {
      const r = await db
        .prepare("SELECT role FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1")
        .bind(userId, tenantId)
        .first<{ role: string }>();
      return r?.role ?? null;
    },
    getUserEmail: async (userId) => {
      const r = await db
        .prepare('SELECT email FROM "user" WHERE id = ? LIMIT 1')
        .bind(userId)
        .first<{ email: string }>();
      return r?.email ?? null;
    },
    listMembers: async (tenantId) => {
      const { results } = await db
        .prepare(
          `SELECT m.user_id AS user_id, u.email AS email, u.name AS name,
                  m.role AS role, m.created_at AS created_at
             FROM membership m LEFT JOIN "user" u ON u.id = m.user_id
            WHERE m.tenant_id = ?
            ORDER BY m.created_at ASC, m.user_id ASC`,
        )
        .bind(tenantId)
        .all<{ user_id: string; email: string | null; name: string | null; role: string; created_at: number }>();
      return results ?? [];
    },
    createInvite: async (rec) => {
      await db
        .prepare(
          `INSERT INTO tenant_invites
             (id, tenant_id, email, role, status, token, invited_by, created_at, expires_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
        )
        .bind(rec.id, rec.tenant_id, rec.email, rec.role, rec.token, rec.invited_by, rec.created_at, rec.expires_at)
        .run();
    },
    listInvites: async (tenantId, opts) => {
      const rows = opts.after
        ? await db
            .prepare(
              `SELECT * FROM tenant_invites
                WHERE tenant_id = ? AND status = 'pending'
                  AND (created_at < ? OR (created_at = ? AND id < ?))
                ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .bind(tenantId, opts.after.createdAt, opts.after.createdAt, opts.after.id, opts.limit + 1)
            .all()
        : await db
            .prepare(
              `SELECT * FROM tenant_invites
                WHERE tenant_id = ? AND status = 'pending'
                ORDER BY created_at DESC, id DESC LIMIT ?`,
            )
            .bind(tenantId, opts.limit + 1)
            .all();
      const items = (rows.results ?? []) as unknown as import("@duyet/oma-http-routes").InviteRecord[];
      const hasMore = items.length > opts.limit;
      return { items: items.slice(0, opts.limit), hasMore };
    },
    findPendingByEmail: async (tenantId, email) => {
      const r = await db
        .prepare(
          `SELECT * FROM tenant_invites
            WHERE tenant_id = ? AND email = ? AND status = 'pending' AND expires_at > ?
            LIMIT 1`,
        )
        .bind(tenantId, email, Date.now())
        .first();
      return (r as unknown as import("@duyet/oma-http-routes").InviteRecord) ?? null;
    },
    revokeInvite: async (tenantId, id) => {
      const res = await db
        .prepare(
          "UPDATE tenant_invites SET status = 'revoked' WHERE id = ? AND tenant_id = ? AND status = 'pending'",
        )
        .bind(id, tenantId)
        .run();
      return (res.meta.changes ?? 0) > 0;
    },
    getByToken: async (token) => {
      const r = await db
        .prepare(
          `SELECT i.*, t.name AS tenant_name
             FROM tenant_invites i LEFT JOIN tenant t ON t.id = i.tenant_id
            WHERE i.token = ? LIMIT 1`,
        )
        .bind(token)
        .first();
      return (r as unknown as import("@duyet/oma-http-routes").InviteWithToken) ?? null;
    },
    markAccepted: async (id, userId, at) => {
      await db
        .prepare(
          "UPDATE tenant_invites SET status = 'accepted', accepted_by = ?, accepted_at = ? WHERE id = ?",
        )
        .bind(userId, at, id)
        .run();
    },
    addMembership: async (userId, tenantId, role) => {
      await db
        .prepare(
          `INSERT INTO membership (user_id, tenant_id, role, created_at)
             VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = excluded.role`,
        )
        .bind(userId, tenantId, role, Math.floor(Date.now() / 1000))
        .run();
    },
    sendEmail: async (_c, msg) => {
      const built = invEmail(msg.to, msg.tenantName, msg.role, msg.acceptUrl);
      await sendEmail(env, msg.to, built.subject, built.html, built.text);
    },
    publicBaseUrl: (c) =>
      (c.env as unknown as { PUBLIC_BASE_URL?: string }).PUBLIC_BASE_URL || undefined,
  };
}

const tenantMemberRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  return invokePackage(c, buildTenantMemberRoutes(cfInviteDeps(ctx.env)));
});

const inviteAcceptRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  return invokePackage(c, buildInviteAcceptRoutes(cfInviteDeps(ctx.env)));
});

/**
 * Build the per-request session app. For the authenticated /v1/sessions
 * mount, `services` is the auth-resolved Services container and `tenantId`
 * is the auth-resolved tenant. The public /p/:slug surface reuses this same
 * builder with the publication's tenant + services so public sessions
 * inherit the exact same create/message/SSE behavior without a logic fork.
 */
function buildSessionsApp(services: Services, env: Env, tenantDb: D1Database, ctx: AppCtx | null, tenantId: string) {
  const router = new CfSessionRouter({ env, services, tenantId });
  return buildSessionRoutes({
    services: () => cfRouteServicesFromCtxForTenant(services, tenantDb),
    router,
    federationCrypto: cfFederationCrypto(env),
    // environment_id is always required now (harness-to-environment
    // migration) — no more synthetic LOCAL_RUNTIME_ENV_ID sentinel; a
    // missing/bogus environment_id 404s via the normal lookup below.
    loadEnvironment: async ({ tenantId, environmentId }) => {
      const row = await services.environments.get({ tenantId, environmentId });
      return row ? toEnvironmentConfig(row) : null;
    },
    fetchVaultCredentials: ({ tenantId, vaultIds }) =>
      fetchVaultCredentials(services, tenantId, vaultIds),
    outputs: cfOutputsAdapter(env),
    debugRecoveryToken: (env as { DEBUG_TOKEN?: string }).DEBUG_TOKEN,
    lifecycle: ctx ? cfSessionLifecycle(ctx as never) : undefined,
  });
}

const sessionsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const app = buildSessionsApp(ctx.var.services, ctx.env, ctx.var.tenantDb, ctx, ctx.var.tenant_id);
  return invokePackage(c, app);
});

/**
 * Forward the outer Hono request into a freshly-built package app while
 * preserving (a) auth/tenant vars set by middleware (passed via per-call
 * middleware injected on the inner app), and (b) the relative URL the
 * package routes expect (`/`, `/:id`, etc.) — Hono's `app.route` only
 * strips the prefix when matching, not from `req.url`.
 */
function invokePackage(
  c: import("hono").Context,
  packageApp: { fetch: (req: Request, env?: unknown, ctx?: ExecutionContext) => Response | Promise<Response> },
): Promise<Response> | Response {
  const url = new URL(c.req.url);
  // Strip the outer mount prefix so e.g. `/v1/agents/abc` becomes `/abc`
  // before the package's `app.get("/:id")` sees it.
  const knownPrefixes = ["/v1/oma/", "/v1/"];
  let stripped = url.pathname;
  for (const p of knownPrefixes) {
    if (stripped.startsWith(p)) {
      // Drop the next path segment (resource name like "agents", "sessions").
      const rest = stripped.slice(p.length);
      const slashIdx = rest.indexOf("/");
      stripped = slashIdx === -1 ? "/" : rest.slice(slashIdx);
      break;
    }
  }
  url.pathname = stripped || "/";

  // Carry the outer auth vars (tenant_id, user_id) over the request via
  // headers so the inner app's middleware can re-hydrate them. Header
  // names are namespaced so they can't collide with user-controlled
  // headers; a stray client-supplied `x-oma-tenant-id` is overwritten.
  const headers = new Headers(c.req.raw.headers);
  const tenantId = (c.var as { tenant_id?: string }).tenant_id;
  const userId = (c.var as { user_id?: string }).user_id;
  if (tenantId) headers.set("x-oma-internal-tenant-id", tenantId);
  if (userId) headers.set("x-oma-internal-user-id", userId);

  // One-shot middleware: re-hydrate vars on the inner context.
  const wrapped = new Hono();
  wrapped.use("*", async (innerC, next) => {
    const t = headers.get("x-oma-internal-tenant-id");
    const u = headers.get("x-oma-internal-user-id");
    if (t) innerC.set("tenant_id" as never, t as never);
    if (u) innerC.set("user_id" as never, u as never);
    await next();
  });
  wrapped.route("/", packageApp as Parameters<typeof wrapped.route>[1]);

  return wrapped.fetch(
    new Request(url, {
      method: c.req.method,
      headers,
      body: ["GET", "HEAD"].includes(c.req.method) ? null : c.req.raw.body,
    }),
    c.env,
    c.executionCtx,
  );
}
// OMA's own MCP server (issue #199) — /v1/mcp. Bypasses authMiddleware
// (Bearer-token auth, see auth.ts); tool calls re-enter the platform API via
// an in-process app.fetch dispatch that forwards the tenant key.
app.route(
  "/v1/mcp",
  buildOmaMcpRoutes({
    dispatch: (req, c) => app.fetch(req, c.env, c.executionCtx),
  }),
);

// Per-agent usage analytics — registered BEFORE the catch-all agentsRoutes
// mount so GET /v1/agents/:id/stats matches here deterministically instead
// of falling into buildAgentRoutes' GET /:id.
app.route("/v1/agents", agentStatsRoutes);
app.route("/v1/agents", agentsRoutes);

// Published-agent management API (issue #72) — tenant-authed. Mounted
// beside /v1/agents; reuses authMiddleware + servicesMiddleware above.
const agentPublicationsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const app = buildAgentPublicationRoutes(
    { services: () => cfRouteServicesFromCtx(ctx) },
    "id",
  );
  return invokePackage(c, app);
});
app.route("/v1/agents/:id/publications", agentPublicationsRoutes);

const publicationsRoutes = new Hono<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>().all("*", (c) => {
  const ctx = c as unknown as AppCtx;
  const app = buildPublicationRoutes({ services: () => cfRouteServicesFromCtx(ctx) });
  return invokePackage(c, app);
});
// Creator visibility into a publication's end-users (issue #73). Mounted
// before the catch-all publicationsRoutes so GET /:id/users matches first.
app.route("/v1/publications", consumerAdminRoutes);
// Creator revenue view (issue #74) — aggregates consumer spend for a
// publication. Registered before the catch-all /v1/publications mount so it
// takes precedence. Tenant-scoped via the auth-resolved tenant_id.
app.get("/v1/publications/:id/revenue", async (c) => {
  if (!c.env.MAIN_DB) return c.json({ error: "Payments not configured" }, 503);
  const tenantId = (c as unknown as AppCtx).var.tenant_id;
  const publicationId = c.req.param("id");
  const store = createD1PaymentsStore(c.env.MAIN_DB);
  const totalSpend = await store.totalSpendForPublication(tenantId, publicationId);
  return c.json({
    publication_id: publicationId,
    total_spend_credits: totalSpend,
    // TODO(#74): platform take-rate + creator payout (Stripe Connect) — see
    // packages/payments/src/index.ts. Until Connect onboarding ships, this is
    // an informational revenue view only.
  });
});
// Publication pricing config (issue #163) — the tenant-authed write surface for
// the metered paywall (previously the paywall was unconfigurable via the API).
// Its two specific routes (:id/pricing GET/PUT) are registered before the
// catch-all /v1/publications mount so they match first; every other publications
// path falls through. Tenant-scoped via the auth-resolved tenant_id; publication
// ownership verified before any read/write.
app.route(
  "/v1/publications",
  buildPublicationPricingRoutes({
    getOwnedPublication: async (c, tenantId, id) => {
      const services = cfRouteServicesFromCtx(c as unknown as AppCtx);
      const pub = await services.publications.get({ tenantId, id });
      return pub ? { id: pub.id } : null;
    },
  }),
);
app.route("/v1/publications", publicationsRoutes);
app.route("/v1/environments", environmentsRoutes);
app.route("/v1/sessions", sessionsRoutes);
app.route("/v1/vaults", vaultsRoutes);
app.route("/v1/oauth", oauthRoutes);
app.route("/v1/cap-cli/oauth", capCliOauthRoutes);
app.route("/v1/memory_stores", memoryRoutes);
app.route("/v1/dreams", dreamsRoutes);
app.route("/v1/files", filesRoutes);
app.route("/v1/skills", skillsRoutes);
app.route("/v1/model_cards", modelCardsRoutes);
app.route("/v1/mcp_servers", mcpServersRoutes);
app.route("/v1/federation", federationRoutes);
app.route("/v1/analytics", analyticsRoutes);
app.route("/v1/telemetry", telemetryRoutes);
app.route("/v1/models", modelsRoutes);
app.route("/v1/clawhub", clawhubRoutes);
app.route("/v1/api_keys", apiKeysRoutes);
app.route("/v1/me", meRoutes);
app.route("/v1/tenants", tenantsRoutes);
app.route("/v1/tenant", tenantMemberRoutes);
app.route("/v1/invites", inviteAcceptRoutes);
app.route("/v1/evals", evalsRoutes);
app.route("/v1/cost_report", costReportRoutes);
app.route("/v1/integrations", integrationsRoutes);
app.route("/v1/runtimes", runtimesRoutes);
app.route("/v1/sandbox_providers", sandboxProvidersRoutes);
app.route("/v1/webhooks", webhookRoutes);
app.route("/v1/stats", statsRoutes);
app.route("/v1/usage", usageRoutes);
app.route(
  "/v1/agents",
  buildScheduleRoutes({ db: (c) => new CfD1SqlClient((c.env as Env).MAIN_DB) }),
);
// Tenant-wide schedule list — cross-agent read for the Kanban board.
app.route(
  "/v1/schedules",
  buildTenantScheduleRoutes({ db: (c) => new CfD1SqlClient((c.env as Env).MAIN_DB) }),
);
app.route("/v1/deployments", deploymentsRoutes);
// Webhook trigger for deployments — bypasses x-api-key auth (see auth.ts);
// the opaque hook_token authorizes the run.
app.route("/v1/deployment_hooks", deploymentHooksRoutes);
app.route("/v1/providers/anyrouter", providersRoutes);

// Billing-API proxy needs the session-resolved tenant_id, so it must
// run authMiddleware first. The proxy handler below short-circuits
// before tenantDb/services middlewares (it doesn't need them).
app.use("/billing-api/*", authMiddleware);
app.use("/billing-api/*", rateLimitMiddleware);

// Billing-API proxy — same-origin escape hatch for hosted plugins.
//
// Hosted Console (apps/console plugins/billing/) lives on app.oma.duyet.net
// while the billing worker lives on billing.oma.duyet.net. Direct browser
// → billing-worker calls would need CORS + a spoofable tenant header,
// since better-auth cookies don't cross subdomain boundaries by default
// and the billing worker has no auth middleware.
//
// Solution: proxy /billing-api/* through here. authMiddleware above has
// already resolved c.var.tenant_id from the session cookie; we forward
// to the USAGE_METER_HTTP service binding and inject x-oma-tenant-id
// server-side so the header is no longer client-controlled.
//
// In self-host (OSS-only) USAGE_METER_HTTP is unbound and this returns
// 404 — the hosted billing plugin isn't loaded there anyway, so no
// browser code reaches this route.
app.all("/billing-api/*", async (c) => {
  const meter = (c.env as { USAGE_METER_HTTP?: Fetcher }).USAGE_METER_HTTP;
  if (!meter) return c.json({ error: "billing not configured" }, 404);
  const tenantId = c.get("tenant_id" as never) as string | undefined;
  if (!tenantId) return c.json({ error: "unauthorized" }, 401);

  const url = new URL(c.req.url);
  url.pathname = url.pathname.replace(/^\/billing-api/, "");

  const headers = new Headers(c.req.raw.headers);
  headers.set("x-oma-tenant-id", tenantId);
  headers.delete("cookie"); // billing worker doesn't need it; reduces leak surface

  const init: RequestInit = {
    method: c.req.method,
    headers,
    body: c.req.method === "GET" || c.req.method === "HEAD"
      ? null
      : await c.req.raw.clone().arrayBuffer(),
  };
  return meter.fetch(url.toString(), init);
});
// MCP proxy bypasses /v1/* authMiddleware (declared in auth.ts as a
// path-prefix skip) — auth is the Bearer oma_* the ACP child sends.
app.route("/v1/mcp-proxy", mcpProxyRoutes);

// /v1/oma/* aliases — OMA-only namespaces re-mounted under an `oma/` prefix
// so the public surface can grow into a clean two-tier API:
//   /v1/<resource>      — Anthropic-compatible (agents, sessions, vaults, ...)
//   /v1/oma/<resource>  — OMA-specific extensions (oauth, tenants, evals, ...)
//
// New code (and external callers) should prefer the /v1/oma/* paths.
// Internal Console/CLI keep using the bare paths until follow-up cleanup
// (the bare mounts above stay live for now). New OMA-only endpoints should
// be added here only, not above.
app.route("/v1/oma/clawhub", clawhubRoutes);
app.route("/v1/oma/api_keys", apiKeysRoutes);
app.route("/v1/oma/me", meRoutes);
app.route("/v1/oma/device", deviceRoutes);
app.route("/v1/oma/tenants", tenantsRoutes);
app.route("/v1/oma/evals", evalsRoutes);
app.route("/v1/oma/cost_report", costReportRoutes);
app.route("/v1/oma/integrations", integrationsRoutes);
app.route("/v1/oma/runtimes", runtimesRoutes);
app.route("/v1/oma/oauth", oauthRoutes);
app.route("/v1/oma/model_cards", modelCardsRoutes);
app.route("/v1/oma/mcp_servers", mcpServersRoutes);
app.route("/v1/oma/sandbox_providers", sandboxProvidersRoutes);
app.route("/v1/oma/webhooks", webhookRoutes);
// /v1/mcp-proxy is intentionally NOT aliased: auth.ts path-prefix skip is
// scoped to that exact prefix, and the proxy does its own session-ownership
// check downstream. Re-mounting under /v1/oma/mcp-proxy would route through
// the standard authMiddleware and break the ACP child's transport.
// Daemon-facing routes — outside /v1/* so authMiddleware doesn't run.
// Apply tenantDbMiddleware + servicesMiddleware so daemon endpoints (like
// /agents/runtime/sessions/:sid/bundle) can use c.get("services").
app.use("/agents/runtime/*", tenantDbMiddleware);
app.use("/agents/runtime/*", servicesMiddleware);
app.route("/agents/runtime", runtimeDaemonRoutes);

// /sandbox-tab — the browser-vm sandbox host page (the browser-tab twin of
// `oma bridge daemon`). Outside /v1 (no authMiddleware): the page is inert
// without a one-time pairing code or a previously stored runtime token.
// Served with COOP/COEP inside the route so WASM engines can use
// SharedArrayBuffer. See docs/browser-vm-sandbox.md.
app.route("/sandbox-tab", browserVmHostRoutes);

// /agents/runtime/_attach — WebSocket upgrade for `oma bridge daemon` and
// the browser-vm sandbox tab. We validate the runtime bearer token here,
// then forward to the RuntimeRoom DO with x-runtime-id / x-runtime-user
// headers it trusts. Browser WebSocket clients cannot set an Authorization
// header, so the token is also accepted as `?access_token=` (transport is
// wss; the token never appears in a Referer since the WS URL isn't a page).
app.get("/agents/runtime/_attach", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("WebSocket only", 400);
  }
  if (!c.env.RUNTIME_ROOM) return c.text("RUNTIME_ROOM binding missing", 503);
  const auth = c.req.header("authorization") ?? c.req.query("access_token") ?? "";
  const ok = await authenticateRuntimeToken(c.env, auth);
  if (!ok) return c.text("unauthorized", 401);
  const stub = c.env.RUNTIME_ROOM.get(c.env.RUNTIME_ROOM.idFromName(ok.runtime_id));
  const fwd = new Request(c.req.raw);
  fwd.headers.set("x-attach-role", "daemon");
  fwd.headers.set("x-runtime-id", ok.runtime_id);
  fwd.headers.set("x-runtime-user", ok.user_id);
  return stub.fetch(fwd);
});

// Internal endpoints (NOT auth-middleware'd; secured by header secret inside
// the route file). Called only by the integrations gateway worker via service
// binding.
app.route("/v1/internal", internalRoutes);

// ── Public chat surface for published agents (issue #72) ───────────────
//
// /p/:slug/* BYPASSES x-api-key (see auth.ts). Each request resolves the
// owning tenant from the publication row, applies visibility/status
// guardrails + per-slug/per-IP caps + ownership scoping, then forwards into
// the shared session routes. No tenant auth middleware runs here.
app.use("/p/*", rateLimitMiddleware);

{
  const resolvePublication = async (slug: string, env: Env) => {
    const services = await getCfServicesForTenant(env, "");
    const pub = await services.publications.getBySlug({ slug });
    if (!pub) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    }
    // Guardrails: private/draft hidden (404); paused forbidden (403).
    // Shared with the consumer credits surface — see gatePublicationState.
    const gate = gatePublicationState(pub);
    if (gate) return gate;
    return pub;
  };

  const guardSessionCreate = async (opts: {
    publication: import("@duyet/oma-publications-store").PublicationRow;
    ip: string;
    env: Env;
  }) => {
    const services = await getCfServicesForTenant(opts.env, opts.publication.tenant_id);
    const today = new Date().toISOString().slice(0, 10);
    return publicSessionCaps(services.kv, opts.env, {
      slug: opts.publication.slug,
      ip: opts.ip,
      today,
    });
  };

  const assertSessionOwnedByPublication = async (
    publication: import("@duyet/oma-publications-store").PublicationRow,
    sessionId: string,
    env: Env,
  ): Promise<boolean> => {
    const services = await getCfServicesForTenant(env, publication.tenant_id);
    const sess = await services.sessions.get({
      tenantId: publication.tenant_id,
      sessionId,
    });
    if (!sess) return false;
    const pubId = (sess.metadata as Record<string, unknown> | null)?.publication_id;
    return pubId === publication.id;
  };

  // Build the session app bound to a publication tenant. Reuses the exact
  // Builder/session app the /v1/sessions mount uses, just with the tenant
  // captured from the publication row instead of the auth middleware.
  const buildSessionsAppForTenant = async (tenantId: string, env: Env) => {
    const services = await getCfServicesForTenant(env, tenantId);
    const provider = buildCfTenantDbProvider(env);
    const tenantDb = await provider.resolve(tenantId);
    return buildSessionsApp(services, env, tenantDb, null, tenantId);
  };

  const pubRoutes = buildPublicPublicationRoutes({
    env: {} as never,
    servicesForTenant: (tenantId) => getCfServicesForTenant({} as never, tenantId) as never,
    buildSessionsApp: buildSessionsAppForTenant as never,
    resolvePublication: resolvePublication as never,
    guardSessionCreate: guardSessionCreate as never,
    assertSessionOwnedByPublication: assertSessionOwnedByPublication as never,
    enforcePaywall: (async (opts: {
      publication: import("@duyet/oma-publications-store").PublicationRow;
      endUserId: string;
      sessionId: string;
      env: Env;
    }) => {
      if (!opts.env.MAIN_DB) return null;
      return enforcePaywallImpl({
        env: opts.env as never,
        db: opts.env.MAIN_DB,
        tenantId: opts.publication.tenant_id,
        publicationId: opts.publication.id,
        endUserId: opts.endUserId,
        sessionId: opts.sessionId,
      });
    }) as never,
    // Clickable magic-link landing page (issue #215): GET /p/auth/verify
    // shares the exact query/expiry/issue-session logic POST
    // /v1/public/auth/verify uses, via consumer-auth.ts's verifyMagicLinkToken.
    verifyMagicLink: (async (token: string, env: Env) => {
      if (!env.MAIN_DB) {
        return { ok: false, error: "Service unavailable", status: 503 } as const;
      }
      return verifyMagicLinkToken(env.MAIN_DB, token);
    }) as never,
    // Stable wallet identity (issue #73): map a consumer bearer token to
    // `eu:<consumer_id>` so the paywall wallet survives token refresh and the
    // guest -> email upgrade. Falls back to the built-in tok:/ip: scheme.
    resolveEndUserId: (async (req: Request, env: Env) => {
      const auth = req.headers.get("authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (token && env.MAIN_DB) {
        const session = await resolveConsumerSession(env.MAIN_DB, token);
        if (session) return `eu:${session.consumer_id}`;
      }
      if (token) return `tok:${token}`;
      const ip =
        req.headers.get("cf-connecting-ip") ||
        req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
        "anonymous";
      return `ip:${ip}`;
    }) as never,
  });
  app.route("/p", pubRoutes);
}

// Proxy public integrations gateway paths to the INTEGRATIONS service binding

// Proxy public integrations gateway paths to the INTEGRATIONS service binding
// so Linear/GitHub can hit the OAuth callback / webhook URLs at this worker's
// host. (Local dev convenience: avoids running integrations on a separate port.)
app.all("/linear/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});
app.all("/linear-setup/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});
app.all("/github/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});
app.all("/github-setup/*", async (c) => {
  if (!c.env.INTEGRATIONS) return c.json({ error: "INTEGRATIONS binding missing" }, 503);
  return c.env.INTEGRATIONS.fetch(c.req.raw);
});

export default {
  fetch: app.fetch,
  // Cron entry — wrangler `triggers.crons` ticks every minute (`* * * * *`).
  // We rebuild the scheduler per tick (CF isolates are short-lived; the
  // builder is cheap), then dispatch by matching `controller.cron`.
  // Each registered handler runs under ctx.waitUntil so a slow tick
  // doesn't block the runtime.
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const scheduler = buildCfScheduler(env);
    for (const job of scheduler.list()) {
      if (job.cron !== controller.cron) continue;
      ctx.waitUntil(
        Promise.resolve(job.handler()).catch((err) => {
          logError({ op: `cron.${job.name}`, err }, `cron job ${job.name} failed`);
          recordEvent(env.ANALYTICS, {
            op: `cron.${job.name}.failed`,
            ...errFields(err),
          });
        }),
      );
    }
  },
  // Cloudflare Queue consumer for R2 Event Notifications on MEMORY_BUCKET.
  // The runtime-agnostic dispatcher routes to the main consumer or the
  // DLQ subscriber based on `batch.queue`. Handler bodies live in
  // packages/queue/handlers/* (main) and lib/cf-queue-handlers.ts (DLQ
  // notification + AE recording, which is CF-specific plumbing).
  async queue(batch: MessageBatch<R2EventMessage>, env: Env, _ctx: ExecutionContext): Promise<void> {
    const q = buildCfMemoryQueue(env);
    await dispatchCfMemoryQueueBatch(batch, q);
  },
};

// DO classes must be re-exported from the worker entry so wrangler can find
// them by class_name in durable_objects.bindings + migrations.
export { RuntimeRoom } from "./runtime-room";

/**
 * RPC entrypoint for the agent worker (cloud agent path) to forward MCP
 * requests through main's credential-injection layer without exposing the
 * vault to the agent's DO.
 *
 * Mirrors Anthropic Managed Agents' "credential proxy outside the harness"
 * design: the agent worker (the harness) only knows session_id +
 * server_name; the actual vault lookup, token injection, and upstream call
 * happen here in main, where the secrets already live. This means a
 * cloud-side prompt-injection attack against the agent's DO cannot read
 * any vault credential because the DO doesn't hold one.
 *
 * Auth model: this class is reachable only via wrangler service-binding
 * declarations — Workers without an explicit `services[].entrypoint` block
 * pointing at "McpProxyRpc" cannot invoke `mcpForward`. The binding itself
 * is the authentication primitive; no shared secret needed. The agent
 * worker passes `tenantId` because it has it from the SessionDO context;
 * we trust it the same way we'd trust any in-process function call from
 * sibling code, since the binding scope establishes that the caller is
 * our own deployment.
 *
 * Local-runtime path (claude-agent-acp daemon) keeps using the public
 * /v1/mcp-proxy/<sid>/<server> HTTP endpoint with apiKey auth — the
 * daemon doesn't have a service binding, so it has to authenticate the
 * old way. Both paths converge on the same `resolveProxyTargetByTenant` +
 * `forwardToUpstream` helpers in routes/mcp-proxy.ts.
 */
export class McpProxyRpc extends WorkerEntrypoint<Env> {
  async mcpForward(opts: {
    tenantId: string;
    sessionId: string;
    serverName: string;
    method: string;
    /** Inbound headers from the MCP client. The Authorization header here is
     *  the agent worker's own token (or empty); we always overwrite it with
     *  the upstream credential before forwarding. */
    headers: Record<string, string>;
    /** Stringified JSON-RPC body for POST. Empty / null for GET. */
    body: string | null;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }> {
    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    const target = await resolveProxyTargetByTenant(
      this.env,
      services,
      opts.tenantId,
      opts.sessionId,
      opts.serverName,
    );
    if (!target) {
      return {
        status: 403,
        headers: { "content-type": "application/json" },
        body: '{"error":"forbidden"}',
      };
    }
    const inboundHeaders = new Headers(opts.headers);
    const res = await forwardWithRefresh(
      this.env,
      services,
      opts.tenantId,
      target,
      opts.method,
      inboundHeaders,
      opts.body,
      { sessionId: opts.sessionId, serverName: opts.serverName, callerKind: "rpc-mcp" },
    );
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    return {
      status: res.status,
      headers: respHeaders,
      body: await res.text(),
    };
  }

  /**
   * Transparent HTTP proxy for cloud agent MCP traffic. Agent's tools.ts
   * gives AI SDK's MCP HTTP transport a custom fetch that calls
   * `env.MAIN_MCP.fetch(req)` after stamping three metadata headers:
   *   - `x-oma-tenant`
   *   - `x-oma-session`
   *   - `x-oma-mcp-server`
   * We resolve the vault credential by `serverName` (mirrors the legacy
   * `mcpForward` path so inline `authorization_token` still works),
   * strip the metadata, replace the `authorization` header with the
   * upstream bearer, and forward to the URL the agent's transport
   * already knew (request URL is the upstream URL). Body / response
   * status / response headers (including rotated `Mcp-Session-Id`)
   * stream through unchanged.
   *
   * Vault credentials remain main-only — agent worker only sees the
   * Response. The SDK's HTTP transport handles Streamable-HTTP session
   * id rotation, SSE response framing, retries — none of that lives
   * in this Worker anymore. The hand-rolled BindingMCPTransport that
   * preceded this dropped session ids and broke session-ful servers
   * (Notion's tools/list never returned, hanging the whole turn).
   *
   * 401-refresh-and-retry: handled by `forwardWithRefresh` (shared with
   * the legacy mcpForward + HTTP /v1/mcp-proxy paths). When the first
   * upstream response is 401 AND the resolved credential carries
   * `mcp_oauth` refresh metadata (refresh_token + token_endpoint), we
   * hit the token_endpoint, persist the rotated tokens back to D1, and
   * retry the upstream call once with the fresh bearer. Request body
   * is buffered up-front so the retry can replay it.
   */
  async fetch(request: Request): Promise<Response> {
    const tenantId = request.headers.get("x-oma-tenant");
    const sessionId = request.headers.get("x-oma-session");
    const serverName = request.headers.get("x-oma-mcp-server");
    if (!tenantId || !sessionId || !serverName) {
      return new Response(
        '{"error":"missing x-oma-tenant / x-oma-session / x-oma-mcp-server header"}',
        { status: 400, headers: { "content-type": "application/json" } },
      );
    }
    const services = await getCfServicesForTenant(this.env, tenantId);
    const target = await resolveProxyTargetByTenant(
      this.env,
      services,
      tenantId,
      sessionId,
      serverName,
    );
    if (!target) {
      return new Response('{"error":"forbidden"}', {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    }
    // Strip routing metadata before forwarding upstream. Everything else
    // (Mcp-Session-Id, content-type, accept, …) flows through.
    // forwardWithRefresh injects/replaces Authorization itself.
    const inboundHeaders = new Headers(request.headers);
    inboundHeaders.delete("x-oma-tenant");
    inboundHeaders.delete("x-oma-session");
    inboundHeaders.delete("x-oma-mcp-server");
    // Buffer body so forwardWithRefresh can replay on a 401-then-refresh
    // retry. MCP request bodies are JSON-RPC envelopes — sub-KB in
    // practice — so the buffering cost is negligible. Response body is
    // unaffected and still streams back.
    const body = ["GET", "HEAD"].includes(request.method)
      ? null
      : await request.arrayBuffer();
    return forwardWithRefresh(
      this.env,
      services,
      tenantId,
      target,
      request.method,
      inboundHeaders,
      body,
      { sessionId, serverName, callerKind: "rpc-mcp" },
    );
  }

  /**
   * Lightweight credential lookup for the transparent outbound proxy.
   * Returns just the auth token + type for the host, or null if no
   * credential matches. The agent worker injects the Authorization header
   * itself and forwards the request transparently — body and response
   * never cross the RPC boundary, preserving HEAD Content-Length, SigV4
   * signed headers, chunked encoding, streaming, etc.
   *
   * Replaces the body-buffered `outboundForward` for the common-case
   * Bearer-injection path. `outboundForward` remains for callers that
   * need 401-refresh-and-retry (mcp_oauth with refresh_token), since
   * that requires keeping the refresh token in main worker.
   *
   * Security model change: agent worker briefly holds the bearer token
   * in memory during a single request handler invocation. Container
   * still never sees plaintext (auth header is added on agent worker
   * side, the SDK's TLS-MITM re-encrypts back to container). Trade-off
   * vs the body-buffered path: agent worker compromise can leak tokens
   * observed during the brief window; in exchange, we get a working
   * transparent proxy.
   */
  async lookupOutboundCredential(opts: {
    tenantId: string;
    sessionId: string;
    hostname: string;
  }): Promise<{ type: "bearer"; token: string } | null> {
    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    const cred = await resolveOutboundCredentialByHost(
      this.env,
      services,
      opts.tenantId,
      opts.sessionId,
      opts.hostname,
    );
    if (!cred) return null;
    return { type: "bearer", token: cred.upstreamToken };
  }

  /**
   * Resolve a registered remote OMA instance for cross-instance federation
   * (issue #132). The cloud agent DO has no KV / PLATFORM_ROOT_SECRET access,
   * so it calls this RPC to get the remote base URL + decrypted API key, then
   * drives the remote session itself (see SessionDO#runRemoteAgent). Returns
   * null when the instance isn't registered for the tenant.
   */
  async resolveFederationTarget(opts: {
    tenantId: string;
    instanceId: string;
  }): Promise<{ base_url: string; api_key?: string } | null> {
    const secret = (this.env as unknown as { PLATFORM_ROOT_SECRET?: string }).PLATFORM_ROOT_SECRET;
    if (!secret) return null;
    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    const crypto = buildLabeledCrypto(secret, FEDERATION_CRYPTO_LABEL);
    return resolveFederationInstance(services.kv, crypto, opts.tenantId, opts.instanceId);
  }

  /**
   * Per-repo GitHub credential lookup for the network-layer proxy.
   *
   * Returns:
   *   - null  → no credential available (caller passes through unauth'd):
   *             host isn't a GitHub host we route, OR session is gone /
   *             archived, OR session has no github_repository resources
   *   - {...} → the chosen token + scheme + owner/repo slug. Slug is for
   *             log correlation; the token never lands in any log.
   *
   * Pick rule: path-matched resource if the request URL has owner/repo
   * AND it matches a resource; otherwise the first declared resource's
   * token. See `resolveGithubCredentials` for the trade-off rationale.
   */
  async lookupGithubCredential(opts: {
    tenantId: string;
    sessionId: string;
    hostname: string;
    pathname: string;
  }): Promise<{ scheme: "Basic" | "Bearer"; token: string; slug: string } | null> {
    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    return resolveGithubCredentials(
      services,
      opts.tenantId,
      opts.sessionId,
      opts.hostname,
      opts.pathname,
    );
  }


  /**
   * Outbound counterpart to `mcpForward` for sandbox-side HTTPS calls
   * (anything the cloud agent's container does via fetch / curl). The
   * agent worker's outbound interceptor (apps/agent/src/oma-sandbox.ts)
   * passes only `(tenantId, sessionId, hostname, request bytes)`; we
   * resolve the matching vault credential live, inject Authorization,
   * and fetch upstream. The agent's container never sees the credential
   * and the agent worker never even loads it into memory.
   *
   * Body is passed as a string for now (sandbox HTTPS calls in OMA are
   * typically JSON-shaped; binary uploads to upstream APIs are rare and
   * can be added by widening to ArrayBuffer when a real use case lands).
   * Pass-through when no credential matches: same behavior as the legacy
   * snapshot-based path — public APIs and pre-authenticated URLs work.
   */
  async outboundForward(opts: {
    tenantId: string;
    sessionId: string;
    /** Full upstream URL the sandbox is trying to reach. */
    url: string;
    method: string;
    headers: Record<string, string>;
    /**
     * Request body as raw bytes. ArrayBuffer over the RPC wire — preserves
     * binary content (wheels, tarballs, image layers) that string body
     * silently mangled via UTF-8 decode. CF Worker RPC supports
     * ArrayBuffer via structured-clone-like serialization. Per-call size
     * is capped (~32 MB) — multi-GB streaming uploads still need a
     * dedicated path.
     */
    body: ArrayBuffer | null;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: ArrayBuffer;
  }> {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(opts.url);
    } catch {
      return {
        status: 400,
        headers: { "content-type": "application/json" },
        body: new TextEncoder().encode('{"error":"invalid url"}').buffer as ArrayBuffer,
      };
    }

    const services = await getCfServicesForTenant(this.env, opts.tenantId);
    const cred = await resolveOutboundCredentialByHost(
      this.env,
      services,
      opts.tenantId,
      opts.sessionId,
      parsedUrl.hostname,
    );

    const inboundHeaders = new Headers(opts.headers);

    if (!cred) {
      // No matching credential — pass through without injection. Public
      // APIs and pre-authenticated URLs work this way; matches old
      // behavior of the snapshot interceptor (host miss → no header).
      // We still strip the CF-edge headers for cleanliness.
      inboundHeaders.delete("host");
      inboundHeaders.delete("cf-connecting-ip");
      inboundHeaders.delete("cf-ray");
      inboundHeaders.delete("x-forwarded-for");
      inboundHeaders.delete("x-forwarded-proto");
      inboundHeaders.delete("x-real-ip");
      const upstreamReq = new Request(opts.url, {
        method: opts.method,
        headers: inboundHeaders,
        body: ["GET", "HEAD"].includes(opts.method) ? undefined : opts.body,
      });
      const res = await fetch(upstreamReq);
      const respHeaders: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        respHeaders[k] = v;
      });
      return {
        status: res.status,
        headers: respHeaders,
        body: await res.arrayBuffer(),
      };
    }

    // Override target.upstreamUrl with the actual URL the sandbox wants
    // to hit (resolveOutboundCredentialByHost only knows the credential's
    // mcp_server_url, but for outbound the caller might be hitting any
    // path on that host). forwardWithRefresh injects token + auto-refreshes
    // on 401 if the credential is mcp_oauth.
    const target = { ...cred, upstreamUrl: opts.url };
    const res = await forwardWithRefresh(
      this.env,
      services,
      opts.tenantId,
      target,
      opts.method,
      inboundHeaders,
      opts.body,
      { sessionId: opts.sessionId, callerKind: "rpc-outbound" },
    );
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      respHeaders[k] = v;
    });
    return {
      status: res.status,
      headers: respHeaders,
      body: await res.arrayBuffer(),
    };
  }
}

import { Hono } from "hono";
import type { Env } from "./env";
import linearPublications from "./routes/linear/publications";
import githubPublications from "./routes/github/publications";
import githubManaged from "./routes/github/managed";
import slackPublications from "./routes/slack/publications";
import slackSetupPage from "./routes/slack/setup-page";
import githubManifest from "./routes/github/manifest";
import telegramWebhook from "./routes/telegram/webhook";
import { telegramChatStore, telegramIdleTimeoutMs } from "./routes/telegram/wire";
import { sweepIdleTelegramChats } from "@duyet/oma-telegram";
import { buildProviders } from "./providers";
import { buildContainer } from "./wire";
import { CfInstallBridge } from "./cf-install-bridge";
import { webhookRateLimitMiddleware, shouldDropForTenantRateLimit } from "./webhook-rate-limit";
import { linearDispatchTick } from "@duyet/oma-scheduler/jobs/linear-dispatch";
import { getLogger } from "@duyet/oma-observability";
import { pingHealthchecks } from "@duyet/oma-shared";
import { buildIntegrationsGatewayRoutes } from "@duyet/oma-http-routes";
import { buildUnifiedOAuthRoutes, buildUnifiedProvidersFromEnv } from "./oauth-unified";

const log = getLogger("apps.integrations");

// Integrations gateway worker: receives 3rd-party webhooks (Linear + GitHub +
// Slack), runs OAuth/install flows for installations, and hosts the MCP servers
// that expose external APIs to agent sessions.
//
// Most route bodies live in @duyet/oma-http-routes via
// `buildIntegrationsGatewayRoutes` — this file just wires the CF-flavored
// install bridge + provider webhook handlers + per-IP/per-tenant rate
// limiting onto that. The publications + manifest-start endpoints stay
// here because they're CF-specific (return-shape preserved verbatim).
// Slack setup-page also stays as its own file because it surfaces a
// manifest-launch URL that isn't yet plumbed through the package; the
// rest of the providers' setup pages run from the package.

// Hostname the vault's static_bearer credential is injected for. The
// outbound proxy matches this URL when the sandbox calls the provider API.
function providerApiUrl(provider: string): string {
  switch (provider) {
    case "linear":
      return "https://api.linear.app";
    case "github":
      return "https://api.github.com";
    case "slack":
      return "https://slack.com/api";
    default:
      return `https://api.${provider}.com`;
  }
}

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) => c.json({ status: "ok" }));

// Defense-in-depth: /admin/* endpoints never existed (or were intentionally
// removed). Prod env always 404. Staging env requires TEMP_DEBUG_TOKEN
// (`x-debug-token`) — wrong/missing token = 401. Correct token falls
// through; current routes resolve to 404 because no admin handler is
// mounted. Staging detection uses \bstaging\b word boundary so hosts like
// `stagecoach.oma.duyet.net` are NOT misclassified as staging. Mounted before
// the gateway middleware so the cheap reject runs first.
app.all("/admin/*", (c) => {
  const origin = c.env.GATEWAY_ORIGIN ?? "";
  const isStaging = /\bstaging\b/i.test(origin);
  if (!isStaging) return c.notFound();
  const token = c.req.header("x-debug-token");
  const expected = c.env.TEMP_DEBUG_TOKEN;
  if (!token || !expected || token !== expected) {
    return c.text("Unauthorized", 401);
  }
  return c.notFound();
});

// Per-IP rate limit on webhook receivers. Mounted before the package
// gateway so the cheap reject runs first.
app.use("/linear/webhook/*", webhookRateLimitMiddleware);
app.use("/github/webhook/*", webhookRateLimitMiddleware);
app.use("/slack/webhook/*", webhookRateLimitMiddleware);
app.use("/telegram/webhook/*", webhookRateLimitMiddleware);

// Publications/manifest-start CF-side wrappers (kept). These accept
// formToken POSTs from the browser and publish setup flows. Mounted
// before the gateway catch-all so they always win.
app.route("/linear/publications", linearPublications);
app.route("/github/publications", githubPublications);
app.route("/github/managed", githubManaged);
app.route("/github/manifest", githubManifest);
app.route("/slack/publications", slackPublications);
app.route("/slack-setup", slackSetupPage);
app.route("/telegram", telegramWebhook);

// Managed-app availability probe — powers the Console's "OMA managed app"
// vs "bring your own app" chooser. Reports whether this deployment has the
// managed-App secret trio/quintet configured for a given provider, without
// leaking any of the secret values themselves. Mounted before the gateway
// catch-all so it always wins.
app.get("/:provider/managed-availability", (c) => {
  const provider = c.req.param("provider");
  const env = c.env;
  const available =
    provider === "slack"
      ? Boolean(env.SLACK_MANAGED_CLIENT_ID && env.SLACK_MANAGED_CLIENT_SECRET && env.SLACK_MANAGED_SIGNING_SECRET)
      : provider === "linear"
        ? Boolean(env.LINEAR_MANAGED_CLIENT_ID && env.LINEAR_MANAGED_CLIENT_SECRET && env.LINEAR_MANAGED_WEBHOOK_SECRET)
        : provider === "github"
          ? Boolean(
              env.GITHUB_MANAGED_APP_ID &&
                env.GITHUB_MANAGED_APP_SLUG &&
                env.GITHUB_MANAGED_BOT_LOGIN &&
                env.GITHUB_MANAGED_PRIVATE_KEY &&
                env.GITHUB_MANAGED_WEBHOOK_SECRET,
            )
          : false;
  return c.json({ available });
});

// Unified OAuth "Connect" surface (issue #92). One consistent
// /oauth/:provider/start + /oauth/:provider/callback pair, backed by the
// shared CSRF-state helper (oauth-state.ts) and env-configured OMA OAuth
// apps. Providers that fit a plain OAuth-app handshake (Linear, GitHub,
// Slack, …) plug in via config alone. Mounted before the gateway catch-all
// so these paths always win.
//
// Identity is resolved from headers apps/main sets when it proxies an
// authenticated Console request, gated by INTEGRATIONS_INTERNAL_SECRET so
// the callback can't be spoofed from the open internet. storeToken persists
// the exchanged token into the user's vault as a static_bearer credential —
// the same backing store every other integration uses (issue #92: "Vault
// credentials are the backing store").
app.use("/oauth/*", async (c, next) => {
  const env = c.env;
  const container = buildContainer(env);
  const unified = buildUnifiedOAuthRoutes({
    secret: env.PLATFORM_ROOT_SECRET,
    gatewayOrigin: env.GATEWAY_ORIGIN,
    providers: buildUnifiedProvidersFromEnv(env),
    resolveIdentity: async (req) => {
      const secret = env.INTEGRATIONS_INTERNAL_SECRET;
      if (!secret || req.headers.get("x-internal-secret") !== secret) return null;
      const userId = req.headers.get("x-internal-user-id");
      const tenantId = req.headers.get("x-internal-tenant-id");
      if (!userId || !tenantId) return null;
      return { userId, tenantId };
    },
    storeToken: async ({ provider, userId, accessToken }) => {
      await container.vaults.createCredentialForUser({
        userId,
        vaultName: `${provider} (OAuth)`,
        displayName: `${provider} connection`,
        mcpServerUrl: providerApiUrl(provider),
        bearerToken: accessToken,
        provider: provider === "github" || provider === "linear" ? provider : undefined,
      });
    },
  });
  const res = await unified.fetch(c.req.raw, env, c.executionCtx);
  if (res.status !== 404) return res;
  return next();
});

// Package routes: OAuth callbacks, setup pages, Linear MCP, GitHub
// internal refresh, webhook receivers. The CfInstallBridge wraps the
// in-process providers (no service-binding hop).
app.use("*", async (c, next) => {
  const env = c.env;
  const bridge = new CfInstallBridge({ env });
  const providers = buildProviders(env);
  const container = buildContainer(env);
  const gateway = buildIntegrationsGatewayRoutes({
    installBridge: bridge,
    jwt: container.jwt,
    webhooks: {
      linear: (req) => providers.linear.handleWebhook(req),
      github: (req) => providers.github.handleWebhook(req),
      githubManaged: (req) => providers.github.handleManagedWebhook(req),
      slack: (req) => providers.slack.handleWebhook(req),
    },
    internalSecret: env.INTEGRATIONS_INTERNAL_SECRET ?? null,
    consoleOrigin: env.CONSOLE_ORIGIN ?? null,
    rateLimit: {
      shouldDropForTenant: (tenantId) => shouldDropForTenantRateLimit(env, tenantId),
    },
  });
  // Slack's deferredWork callback needs ctx.waitUntil on CF — we can't
  // hand the package routes raw access to executionCtx, so re-attach
  // here. The Slack route in the package fires deferredWork() in the
  // background; on CF we want it under waitUntil so the isolate stays
  // alive until it completes.
  const res = await gateway.fetch(c.req.raw, env, c.executionCtx);
  if (res.status !== 404) return res;
  return next();
});

/**
 * Cron entry point — same as before. Linear dispatch sweep.
 */
async function scheduled(
  controller: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  // Ping healthchecks.io start (fire-and-forget)
  pingHealthchecks(env, "start", "linear-dispatch tick started").catch(() => {});

  const tick = linearDispatchTick({
    resolveSweeper: async () => {
      const { linear } = buildProviders(env);
      return linear;
    },
  });
  ctx.waitUntil(
    tick()
      .then(() => {
        // Ping healthchecks.io success (fire-and-forget)
        pingHealthchecks(env, "success", "linear-dispatch tick completed").catch(() => {});
      })
      .catch((err) => {
        log.error(
          { err, op: "linear-dispatch-cron.fatal", cron: controller.cron },
          "linear-dispatch tick failed",
        );
        // Ping healthchecks.io failure (fire-and-forget)
        const msg = err instanceof Error ? err.message : String(err);
        pingHealthchecks(env, "fail", `linear-dispatch tick failed: ${msg}`).catch(() => {});
      }),
  );

  // Telegram auto-idle sweep — pauses chat sandboxes idle for
  // TELEGRAM_IDLE_TIMEOUT_MS (default 5min, see issue #103). No-op when the
  // bot isn't configured. Uses the same MAIN-service-binding SessionCreator
  // as session create/resume — no public HTTP hop.
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_AGENT_ID) {
    const container = buildContainer(env);
    ctx.waitUntil(
      sweepIdleTelegramChats({
        store: telegramChatStore,
        pause: (userId, sessionId) => container.sessions.pause(userId, sessionId),
        now: () => Date.now(),
        idleTimeoutMs: telegramIdleTimeoutMs(env),
      }).catch((err) => {
        log.error({ err, op: "telegram-idle-sweep.fatal", cron: controller.cron }, "telegram idle sweep failed");
      }),
    );
  }
}

export default {
  fetch: app.fetch,
  scheduled,
};

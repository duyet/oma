import { createMiddleware } from "hono/factory";
import type { Env } from "@duyet/oma-shared";
import { logWarn, logError, isAuthDisabled } from "@duyet/oma-shared";
import { CfKvStore } from "@duyet/oma-kv-store";

async function sha256(data: string): Promise<string> {
  const encoded = new TextEncoder().encode(data);
  const hash = await crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(hash)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export const authMiddleware = createMiddleware<{
  Bindings: Env;
  Variables: { tenant_id: string; user_id?: string };
}>(async (c, next) => {
  // Internal endpoints have their own header-secret auth (see routes/internal.ts)
  if (c.req.path.startsWith("/v1/internal/")) {
    return next();
  }
  // MCP proxy authenticates via Bearer oma_* on every request — its own
  // resolveProxyTarget validates token + session ownership in one shot.
  if (c.req.path.startsWith("/v1/mcp-proxy/")) {
    return next();
  }
  // OMA's own MCP server (issue #199): a single streamable-HTTP endpoint that
  // accepts the tenant API key as a Bearer token (what MCP clients send) as
  // well as x-api-key. It resolves the tenant itself by forwarding the key on
  // internal subrequests, so it must bypass this x-api-key-only gate.
  if (c.req.path === "/v1/mcp") {
    return next();
  }
  // Public chat surface for published agents (issue #72): /p/:slug/* and
  // /p/:slug resolve the owning tenant from the publication row itself, so
  // they must bypass x-api-key auth. Guardrails (visibility/status, per-slug
  // + per-IP caps, ownership scoping) live in routes/publications.ts.
  if (c.req.path === "/p" || c.req.path.startsWith("/p/")) {
    return next();
  }
  // Public routes use their own auth (magic-link consumer tokens, etc.).
  if (c.req.path.startsWith("/v1/public/")) {
    return next();
  }
  // Deployment webhook trigger: the opaque hook_token in the path both
  // identifies the deployment AND authorizes the run (resolved inside
  // routes/deployments.ts). Must bypass x-api-key — a tenant key is never
  // accepted here.
  if (c.req.path.startsWith("/v1/deployment_hooks/")) {
    return next();
  }
  // Stripe webhook (issue #74): authenticated by the Stripe signature, not an
  // x-api-key. Verified inside routes/payments.ts against STRIPE_WEBHOOK_SECRET.
  if (c.req.path.startsWith("/webhooks/")) {
    return next();
  }
  // Device Authorization Grant (RFC 8628) — /code (issue) + /token (poll)
  // are unauthenticated; /approve keeps the cookie-session guard below.
  if (
    c.req.path === "/v1/device/code" ||
    c.req.path === "/v1/device/token" ||
    c.req.path === "/v1/oma/device/code" ||
    c.req.path === "/v1/oma/device/token"
  ) {
    return next();
  }
  // CLI telemetry — public, unauthenticated, rate-limited (buildTelemetryRoutes).
  if (
    c.req.path === "/v1/telemetry/events" ||
    c.req.path === "/v1/telemetry/ingest" ||
    c.req.path === "/v1/telemetry/stats"
  ) {
    return next();
  }

  // AUTH_DISABLED=1 — same single-user trial as self-host Node. Every
  // request is tenant_id="default"; Console skips login via /auth-info
  // providers: []. Do not use in production.
  if (isAuthDisabled(c.env.AUTH_DISABLED)) {
    c.set("tenant_id", "default");
    return next();
  }

  // 1. Try API Key authentication (for CLI / SDK)
  const apiKey = c.req.header("x-api-key");
  if (apiKey) {
    // Legacy: check static API_KEY env var for backwards compat
    if (c.env.API_KEY && c.env.API_KEY !== "" && apiKey === c.env.API_KEY) {
      c.set("tenant_id", "default");
      return next();
    }
    // Lookup hashed API key in KV. authMiddleware runs before servicesMiddleware,
    // so c.var.services isn't populated yet — construct the kv adapter inline.
    const hash = await sha256(apiKey);
    const kv = new CfKvStore(c.env.CONFIG_KV);
    const keyData = await kv.get(`apikey:${hash}`);
    if (!keyData) {
      return c.json({ error: "Invalid API key" }, 401);
    }
    const { tenant_id, user_id } = JSON.parse(keyData) as {
      tenant_id: string;
      user_id?: string;
    };
    c.set("tenant_id", tenant_id);
    if (user_id) {
      c.set("user_id", user_id);
    } else if (c.env.MAIN_DB) {
      // Backwards compat: legacy keys minted before user_id was tracked.
      // If the tenant has exactly one user, attribute the request to them so
      // user-scoped endpoints (e.g. /v1/integrations/*) keep working without
      // requiring everyone to regenerate. Multi-user tenants must explicitly
      // regenerate; we don't guess.
      try {
        const r = await c.env.MAIN_DB
          .prepare(`SELECT id FROM "user" WHERE tenantId = ? LIMIT 2`)
          .bind(tenant_id)
          .all<{ id: string }>();
        if (r.results?.length === 1) {
          c.set("user_id", r.results[0].id);
        }
      } catch (err) {
        // MAIN_DB query failed — proceed without user_id; downstream
        // user-scoped routes will reject with their own clear message.
        logWarn(
          { op: "auth.tenant_user_lookup", tenant_id, err },
          "MAIN_DB user lookup failed; proceeding without user_id",
        );
      }
    }
    return next();
  }

  // 2. Try session cookie authentication (for Console)
  // Lazy import to avoid crashing workerd in test environments
  // where better-auth's Node.js deps aren't available
  if (c.env.MAIN_DB) {
    try {
      const { createAuth, getTenantId, ensureTenant, hasMembership } = await import("./auth-config");
      const auth = createAuth(c.env);
      const session = await auth.api.getSession({
        headers: c.req.raw.headers,
      });
      if (session?.user) {
        // Pattern A multi-tenant: cookie auth resolves tenant from
        //   1. x-active-tenant header (set by Console after user picks),
        //      validated against membership table — never trust the header
        //      blindly or a logged-in user could read any tenant's data.
        //   2. user.tenantId default (legacy / single-tenant users).
        //   3. ensureTenant on demand for never-onboarded users.
        const requested = c.req.header("x-active-tenant") || "";
        let tenantId: string | null = null;
        if (requested) {
          const ok = await hasMembership(c.env.MAIN_DB, session.user.id, requested);
          if (ok) {
            tenantId = requested;
          } else {
            return c.json(
              {
                type: "error",
                error: { type: "not_a_member", message: "Not a member of the requested tenant" },
              },
              403,
            );
          }
        }
        if (!tenantId) {
          tenantId = await getTenantId(c.env.MAIN_DB, session.user.id);
        }
        if (!tenantId) {
          // Self-heal: legacy users registered before the sign-up hook landed,
          // or hook silently failed at creation time, would otherwise be
          // permanently stuck. Mint a tenant on the fly.
          tenantId = await ensureTenant(c.env, session.user.id, session.user.name, session.user.email);
        }
        c.set("tenant_id", tenantId);
        c.set("user_id", session.user.id);
        return next();
      }
    } catch (err) {
      // fall through to 401 — but log first so we can tell "no session" from
      // "session check threw" in prod (better-auth import / DB errors etc.).
      logError(
        { op: "auth.session_check", err },
        "session cookie auth threw; returning 401",
      );
    }
  }

  return c.json({ error: "Unauthorized" }, 401);
});

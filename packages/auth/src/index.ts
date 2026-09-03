// Runtime-agnostic auth Hono middleware.
//
// Resolution priority (matches both apps/main/src/auth.ts and
// apps/main-node/src/auth/middleware.ts pre-extract):
//
//   1. AUTH_DISABLED → tenant_id="default", user_id undefined.
//   2. x-api-key header → resolveApiKey() → {tenant_id, user_id?}.
//   3. Trusted reverse-proxy header (opt-in, deps.trustedProxy) → guard
//      check → resolve() → {user_id} → same tenant resolution as below.
//      No-op entirely unless the runtime passes deps.trustedProxy; see
//      ./trusted-proxy.ts for the guard + threat model.
//   4. Cookie session → resolveSession() → {user_id} → tenant via
//      x-active-tenant (validated against membership) or
//      defaultTenantForUser → ensureTenantForUser self-heal.
//   5. Otherwise 401.
//
// Resolvers are runtime-injected: CF passes resolvers backed by D1
// + better-auth + KV-hashed apikey lookup; Node passes the same shape
// backed by SqlClient + a new api_keys table + better-auth on PG/sqlite.

import { createMiddleware } from "hono/factory";
import {
  checkTrustedProxyGuard,
  extractTrustedProxyIdentity,
  isTrustedProxyAttempt,
  type TrustedProxyGuardConfig,
  type TrustedProxyIdentity,
} from "./trusted-proxy";

export {
  checkTrustedProxyGuard,
  extractTrustedProxyIdentity,
  isTrustedProxyAttempt,
  type TrustedProxyGuardConfig,
  type TrustedProxyIdentity,
} from "./trusted-proxy";

export { timingSafeEqualStr } from "./timing-safe-equal";

export interface AuthSession {
  userId: string;
  email?: string | null;
  name?: string | null;
}

export interface ApiKeyResolution {
  tenantId: string;
  userId?: string;
}

/**
 * Opt-in trusted reverse-proxy / SSO-gateway header auth. See
 * ./trusted-proxy.ts for the guard + threat model. Fully inert unless the
 * runtime constructs and passes this on AuthMiddlewareDeps — omitting it
 * (the default) is a true no-op: the middleware never inspects the
 * identity header at all when this is undefined.
 */
export interface TrustedProxyAuthDeps {
  /** Pure guard config — no I/O. */
  config: TrustedProxyGuardConfig;
  /** Resolve (typically find-or-create) a validated identity into an
   *  AuthSession. Only ever called after checkTrustedProxyGuard has
   *  passed for the current request. Runtime-specific (DB access) — see
   *  @duyet/oma-auth-config's resolveTrustedProxyUser for the
   *  Node/self-host implementation. */
  resolve(identity: TrustedProxyIdentity): Promise<AuthSession | null>;
}

export interface AuthMiddlewareDeps {
  /** True bypasses auth entirely; tenant_id="default". */
  disabled: boolean;
  /** Resolve a session cookie → user info. Return null on miss. */
  resolveSession(headers: Headers): Promise<AuthSession | null>;
  /** Resolve an x-api-key value → tenant + optional user. Null on miss. */
  resolveApiKey(apiKey: string): Promise<ApiKeyResolution | null>;
  /** Look up the user's default tenant (first membership by created_at). */
  defaultTenantForUser(userId: string): Promise<string | null>;
  /** Validate (user, tenant) membership — used for x-active-tenant. */
  hasMembership(userId: string, tenantId: string): Promise<boolean>;
  /** Self-heal: mint a tenant for a logged-in user with no memberships. */
  ensureTenantForUser(session: AuthSession): Promise<string>;
  /** Path-prefix predicate — request paths matching are allowed through
   *  without auth. Default: /health and /auth/*.  Used for /v1/internal
   *  (header-secret) and /v1/mcp-proxy (Bearer-on-every-request). */
  bypassPath?(path: string): boolean;
  /** Opt-in trusted reverse-proxy header auth. Omit for no behavior
   *  change (default) — see TrustedProxyAuthDeps + ./trusted-proxy.ts. */
  trustedProxy?: TrustedProxyAuthDeps;
  /** Static bootstrap API key (env var, e.g. API_KEY) checked against the
   *  x-api-key header BEFORE resolveApiKey's DB lookup — a match resolves
   *  to tenant_id="default" with no user_id. Mirrors the legacy env.API_KEY
   *  compat check in apps/main/src/auth.ts so first-run / CLI bootstrap
   *  works identically on self-host Node (see oma#168). Omit or leave
   *  empty for no behavior change — never treated as a match against an
   *  empty x-api-key header. */
  bootstrapApiKey?: string;
}

const DEFAULT_BYPASS = (path: string) =>
  path === "/health" || path.startsWith("/auth/");

export function createAuthMiddleware(deps: AuthMiddlewareDeps) {
  const bypassPath = deps.bypassPath ?? DEFAULT_BYPASS;
  return createMiddleware<{
    Variables: { tenant_id: string; user_id?: string };
  }>(async (c, next) => {
    if (bypassPath(c.req.path)) return next();

    if (deps.disabled) {
      c.set("tenant_id", "default");
      return next();
    }

    // 1. API key
    const apiKey = c.req.header("x-api-key");
    if (apiKey) {
      // Static bootstrap key (e.g. API_KEY env var) — checked before the DB
      // lookup so a fresh install with no api_keys rows yet can still call
      // the REST API. See bootstrapApiKey doc comment above.
      if (deps.bootstrapApiKey && apiKey === deps.bootstrapApiKey) {
        c.set("tenant_id", "default");
        return next();
      }
      const r = await deps.resolveApiKey(apiKey);
      if (!r) return c.json({ error: "Invalid API key" }, 401);
      c.set("tenant_id", r.tenantId);
      if (r.userId) c.set("user_id", r.userId);
      return next();
    }

    // Shared tail: given a resolved identity (from cookie session OR
    // trusted-proxy auth), resolve the tenant the same way for both paths.
    const finishWithSession = async (session: AuthSession) => {
      let tenantId: string | null = null;
      const requested = c.req.header("x-active-tenant") || "";
      if (requested) {
        const ok = await deps.hasMembership(session.userId, requested);
        if (!ok) {
          return c.json(
            {
              type: "error",
              error: { type: "not_a_member", message: "Not a member of the requested tenant" },
            },
            403,
          );
        }
        tenantId = requested;
      }
      if (!tenantId) tenantId = await deps.defaultTenantForUser(session.userId);
      if (!tenantId) tenantId = await deps.ensureTenantForUser(session);

      c.set("tenant_id", tenantId);
      c.set("user_id", session.userId);
      return next();
    };

    // 2. Trusted reverse-proxy header (opt-in — no-op unless deps.trustedProxy
    // is configured). When the configured identity header is present we
    // treat this as an *attempted* trusted-proxy login: the shared-secret
    // guard MUST pass or we reject outright (fail closed) rather than
    // falling through to cookie auth, which would silently swallow a
    // spoofing/misconfiguration signal behind an ordinary 401. See
    // ./trusted-proxy.ts for the full threat model.
    const tp = deps.trustedProxy;
    if (tp && isTrustedProxyAttempt(tp.config, c.req.raw.headers)) {
      if (!checkTrustedProxyGuard(tp.config, c.req.raw.headers)) {
        return c.json({ error: "Unauthorized" }, 401);
      }
      const identity = extractTrustedProxyIdentity(tp.config, c.req.raw.headers);
      if (!identity) return c.json({ error: "Unauthorized" }, 401);
      const tpSession = await tp.resolve(identity);
      if (!tpSession) return c.json({ error: "Unauthorized" }, 401);
      return finishWithSession(tpSession);
    }

    // 3. Cookie session
    let session: AuthSession | null = null;
    try {
      session = await deps.resolveSession(c.req.raw.headers);
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
    if (!session) return c.json({ error: "Unauthorized" }, 401);

    return finishWithSession(session);
  });
}

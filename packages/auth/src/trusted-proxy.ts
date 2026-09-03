// Trusted reverse-proxy / SSO-gateway header auth.
//
// Pure, runtime-agnostic guard + identity extraction — no I/O, no user
// creation. This module only answers "is this request allowed to claim
// the identity carried in its headers?". The runtime (main-node today —
// see apps/main-node/src/index.ts) supplies a `resolve()` callback via
// AuthMiddlewareDeps.trustedProxy that turns a validated
// TrustedProxyIdentity into an AuthSession, typically a find-or-create
// against the "user" table (see @duyet/oma-auth-config's
// resolveTrustedProxyUser).
//
// ─── Threat model ────────────────────────────────────────────────────────
//
// Deployment scenario: an operator puts this platform behind a reverse
// proxy / SSO gateway (nginx, oauth2-proxy, Envoy/Istio ingress, Cloudflare
// Access, etc.) that has ALREADY authenticated the caller and forwards
// that identity via a header (e.g. `X-Forwarded-User: alice@example.com`).
//
// A header is NEVER sufficient proof of anything on its own. Anyone who
// can reach this service directly — bypassing the gateway, which is a
// common misconfiguration in k8s (a Service reachable cluster-internally,
// or the gateway forgetting to strip client-supplied copies of the same
// header) — could set that header themselves and impersonate any user.
//
// Mitigation: a shared secret (`TRUSTED_PROXY_SHARED_SECRET`) known only
// to the operator, configured identically on the gateway and this app.
// The gateway injects it as a second header on every forwarded request;
// operators MUST configure the gateway to strip/overwrite any
// client-supplied copy of both the identity header and the secret header
// (documented in the PR / env var reference). We verify the secret with a
// constant-time comparison before trusting the identity header at all.
//
// Fail-closed rules (see checkTrustedProxyGuard):
//   - Disabled (default, `enabled: false`) → guard always false. The
//     calling middleware never even looks at the identity header in this
//     case — see AuthMiddlewareDeps.trustedProxy being unset entirely,
//     which is how main-node wires "feature flag off" to a true no-op.
//   - Enabled but no secret configured → guard always false. A
//     half-configured deploy must not silently start trusting bare
//     headers; main-node additionally fails fast at boot in this case
//     (see apps/main-node/src/index.ts) rather than running in a
//     permanently-rejecting state that invites someone to "fix" it by
//     turning the guard off.
//   - Enabled + secret configured but the request's secret header is
//     missing or doesn't match → guard false. The middleware
//     (createAuthMiddleware in ./index.ts) treats a *failed* guard on an
//     *attempted* trusted-proxy login as an outright 401, not a
//     fall-through to cookie auth: a mismatched secret means either a
//     misconfigured gateway or an active spoofing attempt, and both
//     deserve a loud, unambiguous rejection instead of silently trying
//     the next auth method (which could mask the attempt behind an
//     ordinary "no session cookie" 401).

import { timingSafeEqualStr } from "./timing-safe-equal";

export interface TrustedProxyGuardConfig {
  /** Master switch. Every function in this module is a no-op (returns
   *  false/null) when this is false — that is what makes the feature
   *  default-off and a true no-op when unconfigured. */
  enabled: boolean;
  /** Header carrying the trusted identity subject, e.g. "X-Forwarded-User". */
  userHeader: string;
  /** Optional header carrying a verified email, when it differs from
   *  userHeader (e.g. the gateway sends a login/subject in userHeader and
   *  the email separately via something like "X-Forwarded-Email"). Falls
   *  back to userHeader's value when unset or blank. */
  emailHeader?: string;
  /** Optional header carrying a display name. Falls back to the email's
   *  local-part when unset or blank. */
  nameHeader?: string;
  /** Header carrying the shared secret that proves the request transited
   *  the trusted proxy. */
  sharedSecretHeader: string;
  /** The shared secret itself. Required for the guard to ever pass — see
   *  the threat model above. Left undefined when the operator hasn't
   *  configured one, which keeps the guard permanently closed. */
  sharedSecret?: string;
}

export interface TrustedProxyIdentity {
  /** Raw value of userHeader. */
  subject: string;
  /** Resolved email (userHeader's value, or emailHeader's when configured). */
  email: string;
  /** Resolved display name (best-effort; never blank). */
  name: string;
}

/**
 * True when the request is *attempting* trusted-proxy auth — i.e. the
 * feature is enabled and the request carries the configured identity
 * header. Used by the middleware to decide whether a guard failure should
 * hard-reject (401) instead of silently falling through to cookie auth.
 */
export function isTrustedProxyAttempt(
  config: TrustedProxyGuardConfig,
  headers: Headers,
): boolean {
  if (!config.enabled) return false;
  return !!headers.get(config.userHeader)?.trim();
}

/**
 * Validate the shared-secret guard. See the module doc comment for the
 * full fail-closed rule set. Must return true before extractTrustedProxyIdentity's
 * output is ever trusted or passed to a resolve()/user-creation callback.
 */
export function checkTrustedProxyGuard(
  config: TrustedProxyGuardConfig,
  headers: Headers,
): boolean {
  if (!config.enabled) return false;
  if (!config.sharedSecret) return false;
  const provided = headers.get(config.sharedSecretHeader);
  if (!provided) return false;
  return timingSafeEqualStr(provided, config.sharedSecret);
}

/**
 * Extract identity fields from headers. Callers MUST call this only after
 * checkTrustedProxyGuard has returned true for the same request — this
 * function performs no validation of its own and trusts its input
 * completely. Returns null when the identity header is blank (defensive;
 * isTrustedProxyAttempt should already have filtered this case out).
 */
export function extractTrustedProxyIdentity(
  config: TrustedProxyGuardConfig,
  headers: Headers,
): TrustedProxyIdentity | null {
  const subject = headers.get(config.userHeader)?.trim();
  if (!subject) return null;
  const email =
    (config.emailHeader ? headers.get(config.emailHeader)?.trim() : "") || subject;
  const name =
    (config.nameHeader ? headers.get(config.nameHeader)?.trim() : "") ||
    email.split("@")[0] ||
    subject;
  return { subject, email, name };
}

import type { Context } from "hono";
import { timingSafeEqualStr } from "@duyet/oma-auth/timing-safe-equal";

/**
 * Shared internal-secret gate for service-to-service `x-internal-secret`
 * endpoints. Returns a `Response` to short-circuit with (503 when the secret
 * isn't configured, 401 when the caller's header is absent or wrong), or
 * `null` to proceed.
 *
 * Used by both the integrations gateway's `/github/internal/*` board routes
 * (packages/http-routes/src/integrations/gateway.ts) and apps/main's
 * `/v1/internal/*` middleware — the two had byte-identical inline checks.
 */
export function checkInternalSecret(
  c: Context,
  expected: string | null | undefined,
): Response | null {
  if (!expected) return c.json({ error: "internal endpoints not configured" }, 503);
  const provided = c.req.header("x-internal-secret");
  if (!provided || !timingSafeEqualStr(provided, expected)) return c.json({ error: "unauthorized" }, 401);
  return null;
}

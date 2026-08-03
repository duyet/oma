import { Hono } from "hono";

/**
 * Rewrites the outer request path into the path the mounted package app
 * expects, and returns the sub-path the package app should be mounted at.
 *
 * Two mount shapes exist on the worker:
 *
 *  - **Flat** (`/v1/agents`, `/v1/sessions`, …): the package's routes are
 *    written relative to the resource root (`/`, `/:id`), so the version
 *    prefix *and* the resource segment are both stripped and the app is
 *    mounted at `/`.
 *  - **Nested** (`/v1/agents/:id/publications`): the outer mount path itself
 *    carries a param the package reads (`c.req.param("id")`). Stripping the
 *    resource segment would hand the package `/agent_x/publications`, which
 *    matches none of its routes (→ 404) and leaves `id` unset. Instead only
 *    the version prefix is stripped and the package is mounted at the rest of
 *    the pattern, so Hono matches the param and the package still sees `/`.
 */
export function rewriteForPackage(
  pathname: string,
  mountPath?: string,
): { path: string; mountAt: string } {
  const versionPrefixes = ["/v1/oma/", "/v1/"];
  for (const p of versionPrefixes) {
    if (!pathname.startsWith(p)) continue;
    if (mountPath) {
      // Keep the resource segment — it's part of the mount pattern.
      return { path: `/${pathname.slice(p.length)}` || "/", mountAt: mountPath };
    }
    // Drop the next path segment (resource name like "agents", "sessions").
    const rest = pathname.slice(p.length);
    const slashIdx = rest.indexOf("/");
    return { path: slashIdx === -1 ? "/" : rest.slice(slashIdx), mountAt: "/" };
  }
  return { path: pathname || "/", mountAt: mountPath ?? "/" };
}

/**
 * Forward the outer Hono request into a freshly-built package app while
 * preserving (a) auth/tenant vars set by middleware (passed via per-call
 * middleware injected on the inner app), and (b) the relative URL the
 * package routes expect (`/`, `/:id`, etc.) — Hono's `app.route` only
 * strips the prefix when matching, not from `req.url`.
 *
 * `mountPath` is the outer mount pattern **below the version prefix** (e.g.
 * `/agents/:id/publications`). Pass it whenever the package's routes depend
 * on a param from that pattern; omit it for flat resource mounts.
 */
export function invokePackage(
  c: import("hono").Context,
  packageApp: { fetch: (req: Request, env?: unknown, ctx?: ExecutionContext) => Response | Promise<Response> },
  mountPath?: string,
): Promise<Response> | Response {
  const url = new URL(c.req.url);
  const { path, mountAt } = rewriteForPackage(url.pathname, mountPath);
  url.pathname = path;

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
  wrapped.route(mountAt, packageApp as Parameters<typeof wrapped.route>[1]);

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

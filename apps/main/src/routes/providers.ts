/**
 * AnyRouter upstream provider routes — OAuth (PKCE) connect for the CF Worker.
 *
 * Mirrors the Node mount in apps/main-node/src/index.ts. Built per request
 * because publicOrigin/returnUrl come from env. Dispatch uses invokePackage
 * with the two-segment mount `/providers/anyrouter` (same pattern as
 * `/integrations/telegram`). A nested `inner.fetch` of `c.req.path` 404s
 * (issue #434): Hono does not strip the mount prefix from `req.url`.
 */

import { Hono } from "hono";
import type { Env } from "@duyet/oma-shared";
import type { Services } from "@duyet/oma-services";
import { buildAnyRouterRoutes } from "@duyet/oma-http-routes";
import { invokePackage } from "../lib/invoke-package";
import { cfRouteServices } from "../lib/cf-route-services";

type Vars = {
  Bindings: Env;
  Variables: {
    tenant_id: string;
    user_id?: string;
    services: Services;
    tenantDb: D1Database;
  };
};

const app = new Hono<Vars>().all("*", (c) => {
  const env = c.env as Record<string, string | undefined>;
  const publicOrigin = (env.BETTER_AUTH_URL ?? `https://${c.req.header("host")}`).replace(/\/+$/, "");
  const inner = buildAnyRouterRoutes({
    services: () => cfRouteServices(c as never),
    publicOrigin,
    returnUrl: `${publicOrigin}/model-cards`,
  });
  return invokePackage(c, inner, "/providers/anyrouter");
});

export default app;

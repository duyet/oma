// Adapter that builds a per-request `RouteServices` bundle from the CF
// per-tenant Services container resolved by `servicesMiddleware`. Used by
// the http-routes package factories — they call this on every request via
// the `(c) => RouteServices` form so the per-tenant D1 binding flows
// through naturally.

import type { Context } from "hono";
import type { Env } from "@duyet/oma-shared";
import type { Services } from "@duyet/oma-services";
import type { RouteServices } from "@duyet/oma-http-routes";
import { CfD1SqlClient } from "@duyet/oma-sql-client/adapters/cf-d1";

interface AppContextLike {
  Bindings: Env;
  Variables: { tenant_id: string; services: Services; tenantDb: D1Database };
}

export function cfRouteServices(c: Context<AppContextLike>): RouteServices {
  const services = c.var.services;
  const sql = new CfD1SqlClient(c.var.tenantDb);
  return buildRouteServices(services, sql);
}

/**
 * Variant for the public /p/:slug surface: build the RouteServices bundle
 * from an explicitly-resolved Services container + per-tenant DB (the
 * publication's tenant), without needing a Hono context carrying them.
 */
export function cfRouteServicesForTenant(services: Services, tenantDb: D1Database): RouteServices {
  const sql = new CfD1SqlClient(tenantDb);
  return buildRouteServices(services, sql);
}

function buildRouteServices(services: Services, sql: CfD1SqlClient): RouteServices {
  return {
    sql,
    agents: services.agents,
    publications: services.publications,
    vaults: services.vaults,
    credentials: services.credentials,
    memory: services.memory,
    sessions: services.sessions,
    modelCards: services.modelCards,
    // Wired for the publications routes' environment_id validation (issue
    // #225) — apps/main's own /v1/environments route file still builds its
    // own wiring directly and doesn't read this field.
    environments: services.environments,
    kv: services.kv,
    filesBlob: services.filesBlob,
    sessionSecrets: services.sessionSecrets,
    newEventLog: () => ({
      appendAsync: async () => {},
      getEventsAsync: async () => [],
    }),
    hub: {
      publish: () => {},
      attach: () => () => {},
    },
    background: {
      run: (p) => {
        // No Hono executionCtx in this path — best-effort fire-and-forget.
        void p.catch(() => undefined);
      },
    },
    outputsRoot: null,
  };
}

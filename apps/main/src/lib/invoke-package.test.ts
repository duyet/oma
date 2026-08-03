// Regression tests for the outer-worker → package-app request forwarding
// (apps/main/src/index.ts mounts every /v1/* route group through
// invokePackage).
//
// The bug this pins: GET /v1/agents/:id/publications 404'd in production.
// invokePackage assumed every mount was flat (`/v1/<resource>`) and stripped
// the resource segment, so the publications package was handed
// `/agent_x/publications` — matching none of its routes — and never saw the
// `:id` param either. Auth was a red herring: the 401-on-anonymous proved
// only that the outer mount matched.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { invokePackage, rewriteForPackage } from "./invoke-package";
import { buildAgentPublicationRoutes } from "@duyet/oma-http-routes";

describe("rewriteForPackage", () => {
  it("strips version prefix + resource segment for flat mounts", () => {
    expect(rewriteForPackage("/v1/agents/agent_x")).toEqual({ path: "/agent_x", mountAt: "/" });
    expect(rewriteForPackage("/v1/agents")).toEqual({ path: "/", mountAt: "/" });
    expect(rewriteForPackage("/v1/oma/me")).toEqual({ path: "/", mountAt: "/" });
  });

  it("keeps the resource segment for nested mounts and mounts at the pattern", () => {
    expect(
      rewriteForPackage("/v1/agents/agent_x/publications", "/agents/:id/publications"),
    ).toEqual({ path: "/agents/agent_x/publications", mountAt: "/agents/:id/publications" });
  });
});

/** Mirrors the production wiring in apps/main/src/index.ts. */
function makeWorker(opts: { mountPath?: string; onList: (args: { tenantId: string; agentId: string }) => void }) {
  const services = () =>
    ({
      publications: {
        list: async ({ tenantId, agentId }: { tenantId: string; agentId: string }) => {
          opts.onList({ tenantId, agentId });
          return [];
        },
      },
    }) as never;

  const outer = new Hono();
  // Stand-in for authMiddleware: whatever auth scheme ran (api key or
  // console cookie + x-active-tenant), it lands as this var.
  outer.use("*", async (c, next) => {
    c.set("tenant_id" as never, "tenant-a" as never);
    await next();
  });
  const group = new Hono().all("*", (c) =>
    invokePackage(c, buildAgentPublicationRoutes({ services }, "id"), opts.mountPath),
  );
  outer.route("/v1/agents/:id/publications", group);
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  return {
    request: (path: string) =>
      outer.fetch(new Request(`https://api.test${path}`), {}, ctx),
  };
}

describe("GET /v1/agents/:id/publications", () => {
  it("reaches the package route with the agent id and tenant from the outer context", async () => {
    const seen: { tenantId: string; agentId: string }[] = [];
    const res = await makeWorker({
      mountPath: "/agents/:id/publications",
      onList: (args) => seen.push(args),
    }).request("/v1/agents/agent_x/publications");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: [] });
    expect(seen).toEqual([{ tenantId: "tenant-a", agentId: "agent_x" }]);
  });

  it("404s when the nested mount path is not declared (the shipped bug)", async () => {
    const res = await makeWorker({ onList: () => {} }).request("/v1/agents/agent_x/publications");
    expect(res.status).toBe(404);
  });
});

describe("two-segment flat mounts (issue: /v1/integrations/telegram 404)", () => {
  it("keeps the full pattern when mountPath names both segments", () => {
    const { path, mountAt } = rewriteForPackage(
      "/v1/integrations/telegram",
      "/integrations/telegram",
    );
    expect(mountAt).toBe("/integrations/telegram");
    expect(path).toBe("/integrations/telegram");
  });

  it("routes subpaths through the same pattern", () => {
    const { path } = rewriteForPackage(
      "/v1/integrations/telegram/link",
      "/integrations/telegram",
    );
    expect(path).toBe("/integrations/telegram/link");
  });
});

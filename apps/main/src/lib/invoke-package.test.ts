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

describe("GET /v1/integrations/telegram (two-segment mount, e2e)", () => {
  it("reaches the package's '/' route through the full pattern", async () => {
    const pkg = new Hono();
    pkg.get("/", (c) => c.json({ ok: true }));
    const outer = new Hono();
    outer.use("*", async (c, next) => {
      c.set("tenant_id" as never, "tenant-a" as never);
      await next();
    });
    const group = new Hono().all("*", (c) =>
      invokePackage(c, pkg, "/integrations/telegram"),
    );
    outer.route("/v1/integrations/telegram", group);
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    const res = await outer.fetch(
      new Request("https://api.test/v1/integrations/telegram"),
      {},
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
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

describe("two-segment mount /v1/providers/anyrouter (issue #434)", () => {
  it("flat rewrite leaves /anyrouter/connect, which matches no package route", () => {
    expect(rewriteForPackage("/v1/providers/anyrouter/connect")).toEqual({
      path: "/anyrouter/connect",
      mountAt: "/",
    });
    expect(rewriteForPackage("/v1/providers/anyrouter/status")).toEqual({
      path: "/anyrouter/status",
      mountAt: "/",
    });
  });

  it("keeps both segments when mountPath names them", () => {
    expect(
      rewriteForPackage("/v1/providers/anyrouter/connect", "/providers/anyrouter"),
    ).toEqual({
      path: "/providers/anyrouter/connect",
      mountAt: "/providers/anyrouter",
    });
    expect(
      rewriteForPackage("/v1/providers/anyrouter/status", "/providers/anyrouter"),
    ).toEqual({
      path: "/providers/anyrouter/status",
      mountAt: "/providers/anyrouter",
    });
  });
});

describe("GET /v1/providers/anyrouter/status (two-segment mount, e2e)", () => {
  function makeWorker(opts: { mountPath?: string }) {
    const pkg = new Hono<{ Variables: { tenant_id: string } }>();
    pkg.get("/status", (c) => {
      const tenantId = c.get("tenant_id");
      if (!tenantId) return c.json({ error: "authentication required" }, 401);
      return c.json({ connected: false });
    });
    pkg.get("/connect", (c) => {
      const tenantId = c.get("tenant_id");
      if (!tenantId) return c.json({ error: "authentication required" }, 401);
      return c.redirect("https://anyrouter.dev/oauth", 302);
    });
    const outer = new Hono();
    outer.use("*", async (c, next) => {
      c.set("tenant_id" as never, "tenant-a" as never);
      await next();
    });
    const group = new Hono().all("*", (c) => invokePackage(c, pkg, opts.mountPath));
    outer.route("/v1/providers/anyrouter", group);
    const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
    return {
      request: (path: string) =>
        outer.fetch(new Request(`https://api.test${path}`), {}, ctx),
    };
  }

  it("404s when the nested mount path is not declared (the shipped bug)", async () => {
    const res = await makeWorker({}).request("/v1/providers/anyrouter/status");
    expect(res.status).toBe(404);
  });

  it("reaches /status with the outer tenant_id when mountPath names both segments", async () => {
    const res = await makeWorker({ mountPath: "/providers/anyrouter" }).request(
      "/v1/providers/anyrouter/status",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });

  it("reaches /connect as a 302 when mountPath names both segments", async () => {
    const res = await makeWorker({ mountPath: "/providers/anyrouter" }).request(
      "/v1/providers/anyrouter/connect",
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://anyrouter.dev/oauth");
  });
});

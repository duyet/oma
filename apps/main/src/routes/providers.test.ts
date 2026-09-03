// Regression for issue #434: a signed-in Console session hitting
// GET /v1/providers/anyrouter/status (and /connect) 404'd. The CF wrapper
// forwarded a nested Hono fetch without invokePackage, so the two-segment
// mount never reached buildAnyRouterRoutes. Auth was a red herring: an
// anonymous GET 401s at authMiddleware, which only proves the outer mount
// matched.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { InMemoryKvStore } from "@duyet/oma-kv-store";
import { createInMemoryVaultService } from "@duyet/oma-vaults-store/test-fakes";
import { createInMemoryCredentialService } from "@duyet/oma-credentials-store/test-fakes";
import { createInMemoryModelCardService } from "@duyet/oma-model-cards-store/test-fakes";
import providersRoutes from "./providers";

function makeWorker() {
  const { service: vaults } = createInMemoryVaultService();
  const { service: credentials } = createInMemoryCredentialService();
  const { service: modelCards } = createInMemoryModelCardService();
  const kv = new InMemoryKvStore();

  const outer = new Hono();
  outer.use("*", async (c, next) => {
    c.set("tenant_id" as never, "tenant-a" as never);
    c.set("user_id" as never, "user-a" as never);
    c.set("services" as never, {
      vaults,
      credentials,
      kv,
      modelCards,
      agents: {},
      publications: {},
      memory: {},
      sessions: {},
      environments: {},
      filesBlob: null,
    } as never);
    c.set("tenantDb" as never, {} as never);
    await next();
  });
  outer.route("/v1/providers/anyrouter", providersRoutes);
  const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
  return {
    request: (path: string) =>
      outer.fetch(new Request(`https://api.test${path}`), {}, ctx),
  };
}

describe("CF AnyRouter provider wrapper (issue #434)", () => {
  it("GET /status returns connected:false for a signed-in tenant, not 404", async () => {
    const res = await makeWorker().request("/v1/providers/anyrouter/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ connected: false });
  });
});

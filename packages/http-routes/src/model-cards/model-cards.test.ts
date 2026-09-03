// @ts-nocheck
// Route tests for /v1/model_cards — CRUD + cursor-paginated list, ported
// from apps/main/src/routes/model-cards.ts. Drives the Hono app directly
// against `createInMemoryModelCardService` (same fake both CF and Node
// route tests could use) via the shared `services` RouteServicesArg.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { ANYROUTER_API_COMPAT, ANYROUTER_FREE_MODEL_ID, toAnyRouterCallableModelId } from "@duyet/oma-anyrouter";
import { DEFAULT_AGENT_MODEL } from "@duyet/oma-agents-store";
import { buildModelCardRoutes } from "./index";
import { PLATFORM_DEFAULT_CARD_ID } from "./platform-default";
import type { ModelCardPlatformEnv } from "./platform-default";
import { createInMemoryModelCardService } from "@duyet/oma-model-cards-store/test-fakes";
import type { RouteServices } from "../types";

const TENANT = "tn_test";

function makeApp(
  modelCards: ReturnType<typeof createInMemoryModelCardService>["service"] | undefined,
  platformEnv?: ModelCardPlatformEnv,
) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  const routes = buildModelCardRoutes({
    services: { modelCards } as unknown as RouteServices,
    platformEnv,
  });
  app.route("/", routes);
  return app;
}

describe("model_cards routes", () => {
  let modelCards: ReturnType<typeof createInMemoryModelCardService>["service"];
  let app: Hono;

  beforeEach(() => {
    ({ service: modelCards } = createInMemoryModelCardService());
    app = makeApp(modelCards);
  });

  const post = (path: string, body: unknown) =>
    app.request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("creates a card, returns 201 with a probe result for an unsupported provider", async () => {
    const res = await post("/", {
      model_id: "my-model",
      provider: "custom",
      api_key: "sk-xxx",
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.model_id).toBe("my-model");
    expect(json.model).toBe("my-model");
    expect(json.provider).toBe("custom");
    expect(json.api_key_preview).toBeTruthy();
    expect(json.is_default).toBe(false);
    // "custom" isn't ant/oai — probe is skipped, not attempted.
    expect(json.probe).toEqual({ ok: null, reason: "unsupported_provider" });
  });

  it("rejects a create missing required fields (400)", async () => {
    const res = await post("/", { provider: "custom" });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate model_id (409)", async () => {
    await post("/", { model_id: "dup", provider: "custom", api_key: "sk-1" });
    const res = await post("/", { model_id: "dup", provider: "custom", api_key: "sk-2" });
    expect(res.status).toBe(409);
  });

  it("gets, updates, and deletes a card", async () => {
    const created = await (
      await post("/", { model_id: "gud", provider: "custom", api_key: "sk-1" })
    ).json();

    const got = await app.request(`/${created.id}`);
    expect(got.status).toBe(200);

    const updated = await post(`/${created.id}`, { model_id: "gud-renamed" });
    expect(updated.status).toBe(200);
    const updatedJson = await updated.json();
    expect(updatedJson.model_id).toBe("gud-renamed");

    const del = await app.request(`/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const gone = await app.request(`/${created.id}`);
    expect(gone.status).toBe(404);
  });

  it("404s update/delete on unknown id", async () => {
    expect((await post("/mc_missing", { model_id: "x" })).status).toBe(404);
    expect((await app.request("/mc_missing", { method: "DELETE" })).status).toBe(404);
  });

  it("lists cards for the tenant, newest first, cursor-paginated", async () => {
    await post("/", { model_id: "a", provider: "custom", api_key: "sk-a" });
    await new Promise((r) => setTimeout(r, 2));
    await post("/", { model_id: "b", provider: "custom", api_key: "sk-b" });

    const res = await app.request("/");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.map((c: { model_id: string }) => c.model_id)).toEqual(["b", "a"]);
  });

  it("rejects an unknown provider filter (400)", async () => {
    const res = await app.request("/?provider=nope");
    expect(res.status).toBe(400);
  });

  it("rejects an unparseable created_after (400)", async () => {
    const res = await app.request("/?created_after=not-a-date");
    expect(res.status).toBe(400);
  });

  it("GET /:id/key returns the decrypted api_key", async () => {
    const created = await (
      await post("/", { model_id: "keyed", provider: "custom", api_key: "sk-secret" })
    ).json();
    const res = await app.request(`/${created.id}/key`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.api_key).toBe("sk-secret");
  });

  it("404s /:id/key for an unknown id", async () => {
    const res = await app.request("/mc_missing/key");
    expect(res.status).toBe(404);
  });

  it("501s every route when modelCards service is unconfigured", async () => {
    const bareApp = makeApp(undefined);
    expect((await bareApp.request("/")).status).toBe(501);
    expect(
      (
        await bareApp.request("/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model_id: "x", provider: "custom", api_key: "k" }),
        })
      ).status,
    ).toBe(501);
    expect((await bareApp.request("/mc_x")).status).toBe(501);
  });

  describe("platform default card", () => {
    it("injects a source:platform row when the tenant has no cards", async () => {
      const res = await app.request("/");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toHaveLength(1);
      const card = json.data[0];
      expect(card.id).toBe(PLATFORM_DEFAULT_CARD_ID);
      expect(card.model_id).toBe(DEFAULT_AGENT_MODEL);
      expect(card.model).toBe(toAnyRouterCallableModelId(DEFAULT_AGENT_MODEL));
      expect(card.model).toBe(ANYROUTER_FREE_MODEL_ID);
      expect(card.model).not.toContain("claude-sonnet-4.6");
      expect(card.model).not.toContain("claude-sonnet-4-6");
      expect(card.provider).toBe(ANYROUTER_API_COMPAT);
      expect(card.source).toBe("platform");
      expect(card.is_default).toBe(true);
    });

    it("uses the Anthropic wire form when ANTHROPIC_API_KEY is visible", async () => {
      const keyed = makeApp(modelCards, { ANTHROPIC_API_KEY: "sk-ant-test" });
      const json = await (await keyed.request("/")).json();
      expect(json.data[0].provider).toBe("ant");
      expect(json.data[0].model).toBe(DEFAULT_AGENT_MODEL);
      expect(json.data[0].model_id).toBe(DEFAULT_AGENT_MODEL);
    });

    it("does not inject once the tenant has a real card", async () => {
      await post("/", { model_id: "a", provider: "custom", api_key: "sk-a" });
      const json = await (await app.request("/")).json();
      expect(json.data.map((c: { model_id: string }) => c.model_id)).toEqual(["a"]);
      expect(json.data[0].source).toBeUndefined();
    });

    it("omits the platform card when the provider filter does not match", async () => {
      const res = await app.request("/?provider=ant");
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual([]);
    });

    it("GET /platform_default returns the synthetic card", async () => {
      const res = await app.request(`/${PLATFORM_DEFAULT_CARD_ID}`);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.source).toBe("platform");
      expect(json.model_id).toBe(DEFAULT_AGENT_MODEL);
    });

    it("refuses update, delete, and key read on the platform card", async () => {
      expect((await post(`/${PLATFORM_DEFAULT_CARD_ID}`, { model_id: "x" })).status).toBe(403);
      expect((await app.request(`/${PLATFORM_DEFAULT_CARD_ID}`, { method: "DELETE" })).status).toBe(403);
      expect((await app.request(`/${PLATFORM_DEFAULT_CARD_ID}/key`)).status).toBe(403);
    });

    it("rejects creating a card with the reserved platform_default handle", async () => {
      const res = await post("/", {
        model_id: PLATFORM_DEFAULT_CARD_ID,
        provider: "custom",
        api_key: "sk-x",
      });
      expect(res.status).toBe(400);
    });
  });
});

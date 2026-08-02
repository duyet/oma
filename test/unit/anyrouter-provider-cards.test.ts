// AnyRouter provider routes — the multi-card surface (issue: model-cards UX).
//
// Covers the pieces that reuse ONE connected key across several model cards:
//   - POST /cards mints an extra card on the stored key (never echoing it)
//   - GET  /status lists every bound card
//   - reconnect rotates the key on ALL bound cards, not just "anyrouter"
//   - disconnect deletes every bound card

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  ANYROUTER_API_BASE,
  ANYROUTER_API_COMPAT,
} from "../../packages/anyrouter/src/config";
import { createInMemoryModelCardService } from "../../packages/model-cards-store/src/test-fakes";
import { buildAnyRouterRoutes } from "../../packages/http-routes/src/providers/anyrouter";
import type { RouteServices } from "../../packages/http-routes/src/types";

const TENANT = "ten_1";

interface FakeCredential {
  id: string;
  vault_id: string;
  auth: { type: string; token: string; provider?: string };
  created_at: string;
  archived_at: string | null;
}

function buildServices() {
  const kvData = new Map<string, string>();
  const vaults: { id: string; name: string }[] = [];
  const credentials: FakeCredential[] = [];
  let seq = 0;
  const { service: modelCards } = createInMemoryModelCardService();

  const services = {
    kv: {
      get: async (k: string) => kvData.get(k) ?? null,
      put: async (k: string, v: string) => void kvData.set(k, v),
      delete: async (k: string) => void kvData.delete(k),
    },
    vaults: {
      list: async () => vaults,
      create: async ({ name }: { name: string }) => {
        const v = { id: `vlt_${++seq}`, name };
        vaults.push(v);
        return v;
      },
    },
    credentials: {
      list: async ({ vaultId }: { vaultId?: string }) =>
        credentials.filter((c) => (vaultId ? c.vault_id === vaultId : true)),
      create: async ({ vaultId, auth }: { vaultId: string; auth: FakeCredential["auth"] }) => {
        const cred: FakeCredential = {
          id: `cred_${++seq}`,
          vault_id: vaultId,
          auth,
          created_at: new Date().toISOString(),
          archived_at: null,
        };
        credentials.push(cred);
        return cred;
      },
      archive: async ({ credentialId }: { credentialId: string }) => {
        const hit = credentials.find((c) => c.id === credentialId);
        if (hit) hit.archived_at = new Date().toISOString();
      },
    },
    modelCards,
  } as unknown as RouteServices;

  return { services, modelCards, vaults, credentials };
}

function buildApp(services: RouteServices, fetchImpl?: typeof fetch) {
  const app = new Hono();
  app.use("*", async (c, next) => {
    c.set("tenant_id" as never, TENANT as never);
    await next();
  });
  app.route(
    "/",
    buildAnyRouterRoutes({
      services,
      publicOrigin: "https://oma.test",
      returnUrl: "https://console.test/model-cards",
      fetchImpl,
    }),
  );
  return app;
}

/** Minimal AnyRouter upstream: DCR, token exchange, model catalog. */
function fakeUpstream(accessToken: string): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes("/mcp/oauth/register")) {
      return new Response(JSON.stringify({ client_id: "cli_1", redirect_uris: [] }), { status: 200 });
    }
    if (url.includes("/mcp/oauth/token")) {
      return new Response(JSON.stringify({ access_token: accessToken, token_type: "Bearer" }), {
        status: 200,
      });
    }
    if (url.endsWith("/models")) {
      return new Response(JSON.stringify({ data: [{ id: "anthropic/claude-sonnet-4-6" }] }), {
        status: 200,
      });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
}

async function connect(services: RouteServices, token: string) {
  // Simulate what the OAuth callback persists: a vault + provider-tagged
  // credential. The card side is then exercised through the real routes.
  const vault = await (services as any).vaults.create({ tenantId: TENANT, name: "AnyRouter" });
  await (services as any).credentials.create({
    tenantId: TENANT,
    vaultId: vault.id,
    displayName: "AnyRouter inference key",
    auth: { type: "static_bearer", token, provider: "anyrouter" },
  });
}

describe("anyrouter provider — multi-card surface", () => {
  let ctx: ReturnType<typeof buildServices>;
  let app: Hono;

  beforeEach(async () => {
    ctx = buildServices();
    app = buildApp(ctx.services);
    await connect(ctx.services, "sk-ar-v1-first");
  });

  it("POST /cards creates a card on the stored key without returning it", async () => {
    const res = await app.request("/cards", {
      method: "POST",
      body: JSON.stringify({ model_id: "anyrouter-opus", model: "anthropic/claude-opus-4-1" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({
      id: expect.any(String),
      model_id: "anyrouter-opus",
      model: "anthropic/claude-opus-4-1",
    });
    expect(JSON.stringify(body)).not.toContain("sk-ar-");

    // The card is genuinely usable: it stores the connected key + AnyRouter wiring.
    const card = await ctx.modelCards.findByModelId({ tenantId: TENANT, modelId: "anyrouter-opus" });
    expect(card?.provider).toBe(ANYROUTER_API_COMPAT);
    expect(card?.base_url).toBe(ANYROUTER_API_BASE);
    expect(
      await ctx.modelCards.getApiKey({ tenantId: TENANT, cardId: card!.id }),
    ).toBe("sk-ar-v1-first");
  });

  it("POST /cards refuses a duplicate handle and a missing body", async () => {
    await app.request("/cards", {
      method: "POST",
      body: JSON.stringify({ model_id: "dup", model: "anthropic/claude-haiku-4-5" }),
    });
    const dup = await app.request("/cards", {
      method: "POST",
      body: JSON.stringify({ model_id: "dup", model: "anthropic/claude-haiku-4-5" }),
    });
    expect(dup.status).toBe(409);

    const bad = await app.request("/cards", { method: "POST", body: JSON.stringify({ model_id: "x" }) });
    expect(bad.status).toBe(400);
  });

  it("GET /status lists every bound card", async () => {
    await app.request("/cards", {
      method: "POST",
      body: JSON.stringify({ model_id: "anyrouter", model: "anthropic/claude-sonnet-4-6" }),
    });
    await app.request("/cards", {
      method: "POST",
      body: JSON.stringify({ model_id: "anyrouter-fast", model: "anthropic/claude-haiku-4-5" }),
    });

    const res = await app.request("/status");
    const body = (await res.json()) as { connected: boolean; model_card_id?: string; cards: { model_id: string }[] };
    expect(body.connected).toBe(true);
    expect(body.model_card_id).toBeTruthy();
    expect(body.cards.map((c) => c.model_id).sort()).toEqual(["anyrouter", "anyrouter-fast"]);
  });

  it("disconnect deletes every bound card, not just the primary one", async () => {
    await app.request("/cards", {
      method: "POST",
      body: JSON.stringify({ model_id: "anyrouter", model: "anthropic/claude-sonnet-4-6" }),
    });
    await app.request("/cards", {
      method: "POST",
      body: JSON.stringify({ model_id: "anyrouter-fast", model: "anthropic/claude-haiku-4-5" }),
    });
    // An unrelated card must survive — disconnect only owns AnyRouter's.
    await ctx.modelCards.create({
      tenantId: TENANT,
      modelId: "claude-prod",
      provider: "ant",
      model: "claude-sonnet-4-6",
      apiKey: "sk-ant-other",
    });

    const res = await app.request("/disconnect", { method: "POST" });
    expect(res.status).toBe(200);

    const left = await ctx.modelCards.list({ tenantId: TENANT });
    expect(left.map((c) => c.model_id)).toEqual(["claude-prod"]);
  });

  it("reconnect rotates the key on every bound card, not just the primary one", async () => {
    await app.request("/cards", {
      method: "POST",
      body: JSON.stringify({ model_id: "anyrouter", model: "anthropic/claude-sonnet-4-6" }),
    });
    await app.request("/cards", {
      method: "POST",
      body: JSON.stringify({ model_id: "anyrouter-fast", model: "anthropic/claude-haiku-4-5" }),
    });

    // Run the real OAuth callback against a fake upstream that mints a new key.
    const oauthApp = buildApp(ctx.services, fakeUpstream("sk-ar-v1-second"));
    const start = await oauthApp.request("/connect");
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    const cb = await oauthApp.request(`/callback?code=abc&state=${state}`);
    expect(cb.status).toBe(302);

    for (const handle of ["anyrouter", "anyrouter-fast"]) {
      const card = await ctx.modelCards.findByModelId({ tenantId: TENANT, modelId: handle });
      expect(await ctx.modelCards.getApiKey({ tenantId: TENANT, cardId: card!.id })).toBe(
        "sk-ar-v1-second",
      );
    }
  });
});

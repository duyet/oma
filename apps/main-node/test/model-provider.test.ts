import { describe, expect, it, vi } from "vitest";
import type { ModelCardRow } from "@duyet/oma-model-cards-store";
import { resolveAgentProvider } from "../src/lib/model-provider";
import type { ModelCardLookup } from "../src/lib/claude-sdk-model";

const card: ModelCardRow = {
  id: "mc_test", tenant_id: "tenant-test", model_id: "my-deepseek", model: "deepseek-wire",
  provider: "oai-compatible", base_url: "https://gateway.example/v1",
  custom_headers: { "x-project": "test" }, api_key_preview: "test", is_default: false,
  created_at: "2026-09-16T00:00:00.000Z", updated_at: null, archived_at: null,
};

function lookup(row: ModelCardRow | null = card): ModelCardLookup {
  return {
    get: vi.fn(async ({ tenantId, cardId }) => row?.tenant_id === tenantId && row.id === cardId ? row : null),
    findByModelId: vi.fn(async ({ tenantId, modelId }) => row?.tenant_id === tenantId && row.model_id === modelId ? row : null),
    getApiKey: vi.fn(async () => "sk-card-test"),
  };
}

const input = {
  tenantId: "tenant-test", agent: { model: "my-deepseek" }, env: {},
};

describe("resolveAgentProvider", () => {
  it("uses all card fields ahead of global credentials and connected AnyRouter", async () => {
    const provider = await resolveAgentProvider({
      ...input, modelCards: lookup(),
      env: { ANTHROPIC_API_KEY: "sk-global", ANTHROPIC_BASE_URL: "https://global.example", OMA_API_COMPAT: "ant" },
      activeProvider: { apiKey: "sk-anyrouter", baseUrl: "https://anyrouter.dev", compat: "oai-compatible" },
    });
    expect(provider).toEqual({
      model: "deepseek-wire", apiKey: "sk-card-test", baseUrl: card.base_url,
      apiCompat: "oai-compatible", customHeaders: card.custom_headers, source: card.id,
    });
  });

  it("does not inherit a deployment gateway when the card uses the provider's default URL", async () => {
    const provider = await resolveAgentProvider({
      ...input, modelCards: lookup({ ...card, provider: "anthropic", base_url: null }),
      env: { ANTHROPIC_API_KEY: "sk-global", ANTHROPIC_BASE_URL: "https://other-gateway.example" },
    });
    expect(provider.apiCompat).toBe("ant");
    expect(provider.baseUrl).toBeUndefined();
  });

  it("resolves a card by explicit id even when the model handle differs", async () => {
    const modelCards = lookup();
    const provider = await resolveAgentProvider({
      ...input, modelCards, agent: { model: { id: "different-handle" }, metadata: { model_card_id: card.id } },
    });
    expect(provider.model).toBe(card.model);
    expect(modelCards.get).toHaveBeenCalledWith({ tenantId: input.tenantId, cardId: card.id });
    expect(modelCards.findByModelId).not.toHaveBeenCalled();
  });

  it("does not use a card or key from another tenant", async () => {
    const modelCards = lookup();
    await expect(resolveAgentProvider({ ...input, modelCards, tenantId: "other-tenant" })).rejects.toThrow(/No model card credentials/);
    expect(modelCards.getApiKey).not.toHaveBeenCalled();
  });

  it("keeps connected AnyRouter ahead of env when no card matches", async () => {
    const provider = await resolveAgentProvider({
      ...input, modelCards: lookup(null), env: { ANTHROPIC_API_KEY: "sk-global" },
      activeProvider: { apiKey: "sk-anyrouter", baseUrl: "https://anyrouter.dev", compat: "oai-compatible" },
    });
    expect(provider.apiKey).toBe("sk-anyrouter");
    expect(provider.apiCompat).toBe("oai-compatible");
  });

  it("preserves the env wire format, URL and custom headers when no card matches", async () => {
    const provider = await resolveAgentProvider({
      ...input, modelCards: lookup(null), env: {
        ANTHROPIC_API_KEY: "sk-global", ANTHROPIC_BASE_URL: "https://global.example/v1",
        OMA_API_COMPAT: "oai", ANTHROPIC_CUSTOM_HEADERS: "x-project: test, x-url: https://example.com",
      },
    });
    expect(provider).toEqual({
      model: "my-deepseek", apiKey: "sk-global", baseUrl: "https://global.example/v1", apiCompat: "oai",
      customHeaders: { "x-project": "test", "x-url": "https://example.com" },
    });
  });

  it.each([
    ["claude-agent-sdk", { CLAUDE_CODE_OAUTH_TOKEN: "oauth-test" }],
    ["poolside", { POOLSIDE_API_KEY: "pool-test" }],
  ])("preserves independent authentication for %s", async (harness, env) => {
    const provider = await resolveAgentProvider({
      ...input, modelCards: lookup(null), agent: { model: "my-deepseek", metadata: { harness } }, env,
    });
    expect(provider.apiKey).toBe("");
  });

  it("does not let harness-specific tokens authenticate the default harness", async () => {
    await expect(resolveAgentProvider({
      ...input, modelCards: lookup(null), env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-test", POOLSIDE_API_KEY: "pool-test" },
    })).rejects.toThrow(/No model card credentials/);
  });
});

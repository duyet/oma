// Per-agent model/provider selection for the self-host Node
// `claude-agent-sdk` harness (issue #316).
//
// Pure — like apps/agent/tests/claude-agent-sdk-auth.test.ts these tests
// never import @anthropic-ai/claude-agent-sdk and never spawn the CLI: the
// unit under test is the model-card → subprocess-env mapping, i.e. exactly
// the `options.env` / `options.model` the harness hands to query().

import { describe, it, expect } from "vitest";
import type { ModelCardRow } from "@duyet/oma-model-cards-store";
import { resolveClaudeSdkProvider } from "@duyet/oma-agent/harness/claude-agent-sdk/model";
import { resolveAgentModelBinding, type ModelCardLookup } from "../src/lib/claude-sdk-model";

function card(over: Partial<ModelCardRow> & { model_id: string }): ModelCardRow {
  return {
    id: "mc_1",
    tenant_id: "t1",
    model: over.model_id,
    provider: "anthropic",
    base_url: null,
    custom_headers: null,
    api_key_preview: "1234",
    is_default: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: null,
    archived_at: null,
    ...over,
  } as ModelCardRow;
}

function lookup(cards: ModelCardRow[], keys: Record<string, string | null> = {}): ModelCardLookup {
  return {
    get: async ({ cardId }) => cards.find((c) => c.id === cardId) ?? null,
    findByModelId: async ({ modelId }) => cards.find((c) => c.model_id === modelId) ?? null,
    getApiKey: async ({ cardId }) => (cardId in keys ? keys[cardId] : "sk-card-key"),
  };
}

const GLOBAL_ENV = { ANTHROPIC_API_KEY: "sk-global", ANTHROPIC_BASE_URL: "https://global.example/v1" };

describe("resolveAgentModelBinding → resolveClaudeSdkProvider", () => {
  it("maps an anthropic (ant) card onto the CLI subprocess env", async () => {
    const binding = await resolveAgentModelBinding({
      modelCards: lookup([card({ id: "mc_ant", model_id: "prod-sonnet", model: "claude-sonnet-4-6", provider: "anthropic" })]),
      tenantId: "t1",
      agent: { model: "prod-sonnet" },
    });
    expect(binding).toMatchObject({ model: "claude-sonnet-4-6", apiCompat: "ant", apiKey: "sk-card-key" });

    const res = resolveClaudeSdkProvider({ binding, env: GLOBAL_ENV, agentModel: "prod-sonnet" });
    expect(res).toEqual({
      ok: true,
      model: "claude-sonnet-4-6",
      env: {
        ANTHROPIC_API_KEY: "sk-card-key",
        // No card base_url → the node's global base URL is kept.
        ANTHROPIC_BASE_URL: "https://global.example/v1",
        ANTHROPIC_MODEL: "claude-sonnet-4-6",
      },
    });
  });

  it("maps an ant-compatible gateway card (AnyRouter-style) incl. its base_url", async () => {
    const binding = await resolveAgentModelBinding({
      modelCards: lookup([
        card({
          id: "mc_ar",
          model_id: "anyrouter-strong",
          model: "anthropic/claude-sonnet-4-6",
          provider: "ant-compatible",
          base_url: "https://anyrouter.dev/api/v1",
        }),
      ]),
      tenantId: "t1",
      agent: { model: "anyrouter-strong" },
    });

    const res = resolveClaudeSdkProvider({ binding, env: GLOBAL_ENV, agentModel: "anyrouter-strong" });
    expect(res).toEqual({
      ok: true,
      model: "anthropic/claude-sonnet-4-6",
      env: {
        ANTHROPIC_API_KEY: "sk-card-key",
        ANTHROPIC_BASE_URL: "https://anyrouter.dev/api/v1",
        ANTHROPIC_MODEL: "anthropic/claude-sonnet-4-6",
      },
    });
  });

  it("resolves an explicit metadata.model_card_id ahead of the model handle", async () => {
    const binding = await resolveAgentModelBinding({
      modelCards: lookup([
        card({ id: "mc_pinned", model_id: "pinned", model: "claude-opus-4-6", provider: "anthropic" }),
        card({ id: "mc_other", model_id: "by-handle", model: "claude-haiku-4-5", provider: "anthropic" }),
      ]),
      tenantId: "t1",
      agent: { model: "by-handle", metadata: { model_card_id: "mc_pinned" } },
    });
    expect(binding?.model).toBe("claude-opus-4-6");
  });

  it("fails the turn clearly for an OpenAI-wire card instead of falling back", async () => {
    const binding = await resolveAgentModelBinding({
      modelCards: lookup([
        card({ id: "mc_oai", model_id: "gpt", model: "gpt-4o", provider: "openai", base_url: "https://api.openai.com/v1" }),
      ]),
      tenantId: "t1",
      agent: { model: "gpt" },
    });
    expect(binding?.apiCompat).toBe("oai");

    const res = resolveClaudeSdkProvider({ binding, env: GLOBAL_ENV, agentModel: "gpt" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unreachable");
    expect(res.error).toMatch(/Anthropic/);
    expect(res.error).toMatch(/mc_oai/);
  });

  it("also refuses an oai-compatible card", async () => {
    const binding = await resolveAgentModelBinding({
      modelCards: lookup([card({ id: "mc_oc", model_id: "groq", model: "llama", provider: "oai-compatible" })]),
      tenantId: "t1",
      agent: { model: "groq" },
    });
    const res = resolveClaudeSdkProvider({ binding, env: GLOBAL_ENV, agentModel: "groq" });
    expect(res.ok).toBe(false);
  });

  it("returns null (→ unchanged global env behavior) when no card matches", async () => {
    const binding = await resolveAgentModelBinding({
      modelCards: lookup([]),
      tenantId: "t1",
      agent: { model: "claude-sonnet-4-6" },
    });
    expect(binding).toBeNull();

    const res = resolveClaudeSdkProvider({ binding, env: GLOBAL_ENV, agentModel: "claude-sonnet-4-6" });
    expect(res).toEqual({
      ok: true,
      model: "claude-sonnet-4-6",
      env: {
        ANTHROPIC_API_KEY: "sk-global",
        ANTHROPIC_BASE_URL: "https://global.example/v1",
      },
    });
  });

  it("falls back to the global env for an archived card or an undecryptable key", async () => {
    const archived = await resolveAgentModelBinding({
      modelCards: lookup([card({ id: "mc_a", model_id: "h", archived_at: "2026-01-02T00:00:00.000Z" })]),
      tenantId: "t1",
      agent: { model: "h" },
    });
    expect(archived).toBeNull();

    const noKey = await resolveAgentModelBinding({
      modelCards: lookup([card({ id: "mc_b", model_id: "h" })], { mc_b: null }),
      tenantId: "t1",
      agent: { model: "h" },
    });
    expect(noKey).toBeNull();
  });

  it("keeps the CLAUDE_CODE_OAUTH_TOKEN global fallback when no card and no api key", () => {
    const res = resolveClaudeSdkProvider({
      binding: null,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" },
      agentModel: { id: "claude-sonnet-4-6" },
    });
    expect(res).toEqual({
      ok: true,
      model: "claude-sonnet-4-6",
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" },
    });
  });

  it("uses the OAuth token with a card's model/base_url when the card key is empty", () => {
    const res = resolveClaudeSdkProvider({
      binding: { model: "claude-opus-4-6", apiCompat: "ant-compatible", baseUrl: "https://gw.example/v1", apiKey: "" },
      env: { CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok" },
      agentModel: "handle",
    });
    expect(res).toEqual({
      ok: true,
      model: "claude-opus-4-6",
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "oauth-tok",
        ANTHROPIC_BASE_URL: "https://gw.example/v1",
        ANTHROPIC_MODEL: "claude-opus-4-6",
      },
    });
  });

  it("errors when neither a card key nor global auth is available", () => {
    const res = resolveClaudeSdkProvider({
      binding: { model: "claude-sonnet-4-6", apiCompat: "ant" },
      env: {},
      agentModel: "claude-sonnet-4-6",
    });
    expect(res.ok).toBe(false);
  });
});

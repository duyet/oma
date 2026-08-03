import { describe, expect, it } from "vitest";

import { modelProvider } from "./model-provider";

describe("modelProvider", () => {
  it("reads the gateway `provider/model` prefix", () => {
    expect(modelProvider("anthropic/claude-sonnet-4-6").id).toBe("anthropic");
    expect(modelProvider("openai/gpt-5").id).toBe("openai");
    expect(modelProvider("poolside/laguna-s-2.1").id).toBe("poolside");
  });

  it("recognizes bare vendor handles the direct-API paths use", () => {
    expect(modelProvider("claude-sonnet-4-6").id).toBe("anthropic");
    expect(modelProvider("gpt-5").id).toBe("openai");
    expect(modelProvider("o3-mini").id).toBe("openai");
  });

  it("attributes an unresolved AnyRouter alias to AnyRouter", () => {
    // Until the provider reports what it ran, the alias IS the gateway.
    expect(modelProvider("anyrouter").id).toBe("anyrouter");
    expect(modelProvider("anyrouter/free").id).toBe("anyrouter");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(modelProvider("  Anthropic/Claude-Sonnet-4-6 ").id).toBe("anthropic");
  });

  it("falls back to unknown for an unrecognized or empty handle", () => {
    expect(modelProvider("some-local-llm").id).toBe("unknown");
    expect(modelProvider("").id).toBe("unknown");
    expect(modelProvider(undefined).id).toBe("unknown");
  });
});

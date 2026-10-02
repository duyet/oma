// A model card's `provider` column names a wire format — either as a wire tag
// ("oai", what the Console picker and `oma models create` write) or as a bare
// vendor name ("openai", accepted by POST /v1/model_cards, routed on by the
// create-time probe, and still on rows written before the picker narrowed).
//
// The Cloudflare resolver (resolveModelCardCredentials in
// ../src/runtime/session-do.ts) only recognized the four wire tags, so a card
// stored as `provider: "openai"` fell through to the "ant" default and the
// turn POSTed to /messages — while the same card on self-host Node ran on
// /chat/completions. These pin the shared mapping and the wire it selects.

import { describe, it, expect, afterEach, vi } from "vitest";
import { cardProviderToApiCompat, resolveModel } from "../src/harness/provider";
import { providerToApiCompat } from "../src/harness/claude-agent-sdk/model";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

const GENERATE_CALL = {
  prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
};

/** Capture the URL resolveModel's SDK instance actually requests. */
async function captureUrl(model: ReturnType<typeof resolveModel>): Promise<string> {
  let seen: string | undefined;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    seen = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return new Response(JSON.stringify({ error: { message: "stub" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const m = model as unknown as { doGenerate: (o: unknown) => Promise<unknown> };
  await m.doGenerate(GENERATE_CALL).catch(() => {});

  if (!seen) throw new Error("provider never issued a request");
  return seen;
}

describe("cardProviderToApiCompat", () => {
  it("passes the four wire tags through", () => {
    expect(cardProviderToApiCompat("ant")).toBe("ant");
    expect(cardProviderToApiCompat("ant-compatible")).toBe("ant-compatible");
    expect(cardProviderToApiCompat("oai")).toBe("oai");
    expect(cardProviderToApiCompat("oai-compatible")).toBe("oai-compatible");
  });

  it("maps the vendor names onto the wire format they speak", () => {
    expect(cardProviderToApiCompat("openai")).toBe("oai");
    expect(cardProviderToApiCompat("anthropic")).toBe("ant");
  });

  it("is case- and whitespace-insensitive", () => {
    expect(cardProviderToApiCompat(" OpenAI ")).toBe("oai");
    expect(cardProviderToApiCompat("ANTHROPIC")).toBe("ant");
  });

  it("returns undefined for a value that names no wire format", () => {
    // Callers fall back on their own (OMA_API_COMPAT, then "ant") rather
    // than committing to a wire format off an unrecognized label.
    expect(cardProviderToApiCompat("custom")).toBeUndefined();
    expect(cardProviderToApiCompat("")).toBeUndefined();
    expect(cardProviderToApiCompat(null)).toBeUndefined();
    expect(cardProviderToApiCompat(undefined)).toBeUndefined();
  });
});

describe("wire format selected by a card's provider", () => {
  it('provider "openai" reaches /chat/completions, not /messages', async () => {
    const url = await captureUrl(
      resolveModel(
        "gpt-4o",
        "sk-test",
        "https://api.openai.com/v1",
        cardProviderToApiCompat("openai"),
      ),
    );
    expect(url).toContain("/chat/completions");
    expect(url).not.toContain("/messages");
  });

  it('provider "anthropic" reaches /messages', async () => {
    const url = await captureUrl(
      resolveModel(
        "claude-sonnet-4-6",
        "sk-ant-test",
        "https://api.anthropic.com/v1",
        cardProviderToApiCompat("anthropic"),
      ),
    );
    expect(url).toContain("/messages");
    expect(url).not.toContain("/chat/completions");
  });

  it("agrees with the self-host Node normalizer on every card provider", () => {
    // providerToApiCompat defaults unknown labels to "ant" where the CF
    // resolver falls through to OMA_API_COMPAT first — so compare only the
    // recognized values.
    for (const provider of [
      "ant",
      "ant-compatible",
      "oai",
      "oai-compatible",
      "openai",
      "anthropic",
      "custom",
      "",
    ]) {
      expect(providerToApiCompat(provider)).toBe(cardProviderToApiCompat(provider) ?? "ant");
    }
  });
});
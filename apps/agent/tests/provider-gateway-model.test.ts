// captureBody reads the JSON `model` field resolveModel puts on the wire.
// #453 asserted anyrouter/free only after pre-applying toAnyRouterCallableModelId,
// so resolveModel("claude-sonnet-4-6", …) still sent hyphenated sonnet (#454).

import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveModel } from "../src/harness/provider";
import { ANYROUTER_API_BASE, ANYROUTER_FREE_MODEL_ID, toAnyRouterCallableModelId } from "@duyet/oma-anyrouter";

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function captureBody(model: ReturnType<typeof resolveModel>): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    try {
      body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    } catch {
      body = {};
    }
    return new Response(JSON.stringify({ error: { message: "stub" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const call = {
    prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
  };
  await (model as unknown as { doGenerate: (o: unknown) => Promise<unknown> })
    .doGenerate(call)
    .catch(() => {});

  if (!body) throw new Error("provider never issued a request");
  return body;
}

describe("OpenAI-compat gateway model ids", () => {
  it("AnyRouter env-fallback sonnet body is anyrouter/free, not a pre-mapped id", async () => {
    const body = await captureBody(
      resolveModel("claude-sonnet-4-6", "sk-ar-test", ANYROUTER_API_BASE, "oai"),
    );
    expect(body.model).toBe(ANYROUTER_FREE_MODEL_ID);
    expect(String(body.model)).not.toContain("claude-sonnet-4.6");
    expect(String(body.model)).not.toContain("claude-sonnet-4-6");
  });

  it("AnyRouter remaps a prefixed sonnet handle too (hyphen still aliases to dotted 4.6)", async () => {
    const body = await captureBody(
      resolveModel("anthropic/claude-sonnet-4-6", "sk-ar-test", ANYROUTER_API_BASE, "oai"),
    );
    expect(body.model).toBe(ANYROUTER_FREE_MODEL_ID);
    expect(String(body.model)).not.toContain("claude-sonnet-4.6");
  });

  it("does not rewrite a bare OpenAI id", async () => {
    const body = await captureBody(
      resolveModel("gpt-4o", "sk-test", "https://api.openai.com/v1", "oai"),
    );
    expect(body.model).toBe("gpt-4o");
  });

  it("OpenRouter keeps hyphenated anthropic/claude-* (not an AnyRouter catalog id)", async () => {
    const body = await captureBody(
      resolveModel("claude-sonnet-4-6", "sk-or-test", OPENROUTER_API_BASE, "oai"),
    );
    expect(body.model).toBe("anthropic/claude-sonnet-4-6");
    expect(body.model).not.toBe(ANYROUTER_FREE_MODEL_ID);
  });

  it("mapping twice is a no-op (SessionDO rewrite then resolveModel)", async () => {
    const body = await captureBody(
      resolveModel(
        toAnyRouterCallableModelId("claude-sonnet-4-6"),
        "sk-ar-test",
        ANYROUTER_API_BASE,
        "oai",
      ),
    );
    expect(body.model).toBe(ANYROUTER_FREE_MODEL_ID);
    expect(String(body.model)).not.toContain("claude-sonnet-4.6");
    expect(String(body.model)).not.toContain("claude-sonnet-4-6");
  });
});

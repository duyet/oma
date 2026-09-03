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

async function parseOutgoingBody(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  if (typeof init?.body === "string") {
    try {
      return JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  if (typeof input === "object" && input !== null && "clone" in input) {
    try {
      return (await (input as Request).clone().json()) as Record<string, unknown>;
    } catch {
      return {};
    }
  }
  return {};
}

const GENERATE_CALL = {
  prompt: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }],
};

async function captureBody(
  model: ReturnType<typeof resolveModel>,
  method: "doGenerate" | "doStream" = "doGenerate",
): Promise<Record<string, unknown>> {
  let body: Record<string, unknown> | undefined;
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    body = await parseOutgoingBody(input, init);
    return new Response(JSON.stringify({ error: { message: "stub" } }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const m = model as unknown as {
    doGenerate: (o: unknown) => Promise<unknown>;
    doStream: (o: unknown) => Promise<unknown>;
  };
  await m[method](GENERATE_CALL).catch(() => {});

  if (!body) throw new Error("provider never issued a request");
  return body;
}

function expectAnyRouterFree(body: Record<string, unknown>): void {
  expect(body.model).toBe(ANYROUTER_FREE_MODEL_ID);
  expect(String(body.model)).not.toContain("claude-sonnet-4.6");
  expect(String(body.model)).not.toContain("claude-sonnet-4-6");
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
    expectAnyRouterFree(body);
  });
});

// #456: live recert after #455 still 404'd dotted anthropic/claude-sonnet-4.6.
// #455 only remapped openai.chat(...). SessionDO with ANTHROPIC_API_KEY set
// (or Node with OMA_API_COMPAT unset) calls resolveModel with default/ant
// compat, and `return anthropic(modelId)` sent the stripped agent handle.
describe("Anthropic-compat AnyRouter model ids", () => {
  it("default ant compat (ANTHROPIC_API_KEY + AnyRouter base) sends anyrouter/free", async () => {
    const body = await captureBody(
      resolveModel("claude-sonnet-4-6", "sk-ant-test", ANYROUTER_API_BASE),
    );
    expectAnyRouterFree(body);
  });

  it("explicit ant sends anyrouter/free, not the stripped claude handle", async () => {
    const body = await captureBody(
      resolveModel("claude-sonnet-4-6", "sk-ant-test", ANYROUTER_API_BASE, "ant"),
    );
    expectAnyRouterFree(body);
  });

  it("ant-compatible sends anyrouter/free", async () => {
    const body = await captureBody(
      resolveModel("claude-sonnet-4-6", "sk-ar-test", ANYROUTER_API_BASE, "ant-compatible"),
    );
    expectAnyRouterFree(body);
  });

  it("does not strip a SessionDO-mapped anyrouter/free down to free", async () => {
    const body = await captureBody(
      resolveModel(ANYROUTER_FREE_MODEL_ID, "sk-ant-test", ANYROUTER_API_BASE, "ant"),
    );
    expectAnyRouterFree(body);
  });

  it("ANTHROPIC_BASE_URL=/v1 (not /api/v1) still remaps — hostname is AnyRouter", async () => {
    const body = await captureBody(
      resolveModel("claude-sonnet-4-6", "sk-ant-test", "https://anyrouter.dev/v1", "ant"),
    );
    expectAnyRouterFree(body);
  });

  it("doStream body.model is anyrouter/free too (the harness turn path)", async () => {
    const body = await captureBody(
      resolveModel("claude-sonnet-4-6", "sk-ant-test", ANYROUTER_API_BASE, "ant"),
      "doStream",
    );
    expectAnyRouterFree(body);
  });

  it("OpenRouter ant-compatible keeps the hyphenated Claude id", async () => {
    const body = await captureBody(
      resolveModel("claude-sonnet-4-6", "sk-or-test", OPENROUTER_API_BASE, "ant-compatible"),
    );
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.model).not.toBe(ANYROUTER_FREE_MODEL_ID);
  });

  it("direct Anthropic (no gateway base) is unchanged", async () => {
    const body = await captureBody(
      resolveModel("claude-sonnet-4-6", "sk-ant-test", undefined, "ant"),
    );
    expect(body.model).toBe("claude-sonnet-4-6");
  });

  it("LanguageModel.modelId is the wire id (span.model_request_start reads this)", () => {
    const model = resolveModel("claude-sonnet-4-6", "sk-ant-test", ANYROUTER_API_BASE, "ant");
    expect((model as { modelId: string }).modelId).toBe(ANYROUTER_FREE_MODEL_ID);
  });
});

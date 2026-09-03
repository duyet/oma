// Bare `claude-*` handles (seeded General agent) must go to OpenAI-compat
// gateways as `anthropic/claude-*`. Sending the hyphenated Anthropic id
// unchanged lets AnyRouter alias it to the dotted BYOK-only catalog entry
// (`anthropic/claude-sonnet-4.6`) and 404 with model_unavailable (#435).

import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveModel } from "../src/harness/provider";
import { ANYROUTER_API_BASE } from "@duyet/oma-anyrouter";

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
  it("rewrites a bare claude-* handle to anthropic/claude-*", async () => {
    const body = await captureBody(
      resolveModel("claude-sonnet-4-6", "sk-ar-test", ANYROUTER_API_BASE, "oai"),
    );
    expect(body.model).toBe("anthropic/claude-sonnet-4-6");
    expect(String(body.model)).not.toContain("claude-sonnet-4.6");
  });

  it("keeps an already-prefixed id unchanged", async () => {
    const body = await captureBody(
      resolveModel("anthropic/claude-sonnet-4-6", "sk-ar-test", ANYROUTER_API_BASE, "oai"),
    );
    expect(body.model).toBe("anthropic/claude-sonnet-4-6");
  });

  it("does not rewrite a bare OpenAI id", async () => {
    const body = await captureBody(
      resolveModel("gpt-4o", "sk-test", "https://api.openai.com/v1", "oai"),
    );
    expect(body.model).toBe("gpt-4o");
  });
});

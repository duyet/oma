// Asserts OMA identifies itself to the LLM gateways it can route through
// (AnyRouter, OpenRouter) via their app-attribution headers on every model
// request — and at no other provider. Exercises resolveModel end-to-end by
// stubbing globalThis.fetch and inspecting the outgoing headers.

import { describe, it, expect, afterEach, vi } from "vitest";
import { resolveModel } from "../src/harness/provider";
import { isAnyRouterBaseUrl, isOpenRouterBaseUrl } from "../src/harness/attribution";
import { ANYROUTER_API_BASE } from "@duyet/oma-anyrouter";

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Drives one model call and returns the headers the provider sent. */
async function captureHeaders(model: ReturnType<typeof resolveModel>): Promise<Headers> {
  let captured: Headers | undefined;
  globalThis.fetch = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    captured = new Headers(init?.headers);
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

  if (!captured) throw new Error("provider never issued a request");
  return captured;
}

describe("gateway base-URL detection", () => {
  it("matches each gateway's host and its subdomains", () => {
    expect(isAnyRouterBaseUrl(ANYROUTER_API_BASE)).toBe(true);
    expect(isAnyRouterBaseUrl("https://api.anyrouter.dev/v1")).toBe(true);
    expect(isOpenRouterBaseUrl(OPENROUTER_API_BASE)).toBe(true);
    expect(isOpenRouterBaseUrl("https://api.openrouter.ai/v1")).toBe(true);
  });

  it("rejects other hosts, look-alikes, the other gateway and empty input", () => {
    expect(isAnyRouterBaseUrl("https://api.openai.com/v1")).toBe(false);
    expect(isAnyRouterBaseUrl("https://evil.com/anyrouter.dev/v1")).toBe(false);
    expect(isAnyRouterBaseUrl(OPENROUTER_API_BASE)).toBe(false);
    expect(isOpenRouterBaseUrl("https://evil.com/openrouter.ai/v1")).toBe(false);
    expect(isOpenRouterBaseUrl(ANYROUTER_API_BASE)).toBe(false);
    expect(isAnyRouterBaseUrl(undefined)).toBe(false);
    expect(isOpenRouterBaseUrl(undefined)).toBe(false);
  });
});

describe("AnyRouter app attribution", () => {
  it("attaches attribution headers on the OpenAI-compat path", async () => {
    const headers = await captureHeaders(
      resolveModel("anthropic/claude-sonnet-4-6", "sk-ar-test", ANYROUTER_API_BASE, "oai"),
    );
    expect(headers.get("HTTP-Referer")).toBe("https://oma.duyet.net");
    expect(headers.get("X-AnyRouter-Title")).toBe("OMA");
    expect(headers.get("X-AnyRouter-Source")).toBe("managed-agents");
    expect(headers.get("X-AnyRouter-Categories")).toBe("cloud-agent");
    expect(headers.get("X-OpenRouter-Title")).toBeNull();
  });

  it("attaches attribution headers on the Anthropic-compat path", async () => {
    const headers = await captureHeaders(
      resolveModel("claude-sonnet-4-6", "sk-ar-test", ANYROUTER_API_BASE, "ant-compatible"),
    );
    expect(headers.get("HTTP-Referer")).toBe("https://oma.duyet.net");
    expect(headers.get("X-AnyRouter-Title")).toBe("OMA");
  });
});

describe("OpenRouter app attribution", () => {
  it("attaches attribution headers on the OpenAI-compat path", async () => {
    const headers = await captureHeaders(
      resolveModel("anthropic/claude-sonnet-4-6", "sk-or-test", OPENROUTER_API_BASE, "oai"),
    );
    expect(headers.get("HTTP-Referer")).toBe("https://oma.duyet.net");
    expect(headers.get("X-OpenRouter-Title")).toBe("OMA");
    expect(headers.get("X-OpenRouter-Categories")).toBe("cloud-agent");
    expect(headers.get("X-AnyRouter-Title")).toBeNull();
  });

  it("attaches attribution headers on the Anthropic-compat path", async () => {
    const headers = await captureHeaders(
      resolveModel("claude-sonnet-4-6", "sk-or-test", OPENROUTER_API_BASE, "ant-compatible"),
    );
    expect(headers.get("HTTP-Referer")).toBe("https://oma.duyet.net");
    expect(headers.get("X-OpenRouter-Title")).toBe("OMA");
  });
});

describe("non-gateway providers", () => {
  it("gets no attribution headers", async () => {
    const openaiHeaders = await captureHeaders(
      resolveModel("gpt-4o", "sk-test", "https://api.openai.com/v1", "oai"),
    );
    expect(openaiHeaders.get("HTTP-Referer")).toBeNull();
    expect(openaiHeaders.get("X-AnyRouter-Title")).toBeNull();
    expect(openaiHeaders.get("X-OpenRouter-Title")).toBeNull();

    const anthropicHeaders = await captureHeaders(
      resolveModel("claude-sonnet-4-6", "sk-ant-test", undefined, "ant"),
    );
    expect(anthropicHeaders.get("HTTP-Referer")).toBeNull();
    expect(anthropicHeaders.get("X-AnyRouter-Title")).toBeNull();
  });
});

describe("caller-supplied headers", () => {
  it("override the gateway defaults", async () => {
    const headers = await captureHeaders(
      resolveModel("anthropic/claude-sonnet-4-6", "sk-ar-test", ANYROUTER_API_BASE, "oai", {
        "X-AnyRouter-Title": "Custom",
      }),
    );
    expect(headers.get("X-AnyRouter-Title")).toBe("Custom");
    expect(headers.get("HTTP-Referer")).toBe("https://oma.duyet.net");
  });
});

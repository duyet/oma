// Unit tests for PoolsideHarness's provider/config resolution
// (poolside.ai's OpenAI-compatible inference API — see poolside-loop.ts).
//
// Only the pure resolution seam is covered here: the harness delegates its
// entire tool loop to DefaultHarness via super.run(), so there is no bespoke
// loop behavior to assert — what IS bespoke is which credentials, base URL,
// and model id it hands to resolveModel(). Runs in the root Workers pool
// (no node builtins involved), same as the other apps/agent harness tests.

import { describe, it, expect, afterEach } from "vitest";
import {
  resolvePoolsideConfig,
  buildPoolsideModel,
  POOLSIDE_DEFAULT_BASE_URL,
  POOLSIDE_DEFAULT_MODEL,
  POOLSIDE_API_COMPAT,
} from "./poolside-loop";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe("resolvePoolsideConfig", () => {
  it("throws a descriptive error when no API key is configured", () => {
    delete process.env.POOLSIDE_API_KEY;
    expect(() => resolvePoolsideConfig({}, "poolside/laguna-s-2.1")).toThrow(
      /requires POOLSIDE_API_KEY/,
    );
  });

  it("defaults to the poolside platform endpoint and model", () => {
    const cfg = resolvePoolsideConfig({ POOLSIDE_API_KEY: "ps-key" });
    expect(cfg).toEqual({
      apiKey: "ps-key",
      baseURL: POOLSIDE_DEFAULT_BASE_URL,
      modelId: POOLSIDE_DEFAULT_MODEL,
    });
  });

  it("honors agent.model verbatim, including the provider/ prefix", () => {
    // The oai-compatible path keeps the full "provider/model" string —
    // stripping it would yield an unknown model id upstream.
    const cfg = resolvePoolsideConfig({ POOLSIDE_API_KEY: "k" }, "poolside/malibu");
    expect(cfg.modelId).toBe("poolside/malibu");
  });

  it("accepts the object form of agent.model", () => {
    const cfg = resolvePoolsideConfig({ POOLSIDE_API_KEY: "k" }, { id: "malibu", speed: "fast" });
    expect(cfg.modelId).toBe("malibu");
  });

  it("falls back to the default model for a blank agent.model", () => {
    const cfg = resolvePoolsideConfig({ POOLSIDE_API_KEY: "k" }, "   ");
    expect(cfg.modelId).toBe(POOLSIDE_DEFAULT_MODEL);
  });

  it("supports a self-hosted deployment base URL and strips trailing slashes", () => {
    const cfg = resolvePoolsideConfig({
      POOLSIDE_API_KEY: "k",
      POOLSIDE_BASE_URL: "https://poolside.internal.acme.com/openai/v1/",
    });
    expect(cfg.baseURL).toBe("https://poolside.internal.acme.com/openai/v1");
  });

  it("prefers the platform env binding over process.env", () => {
    process.env.POOLSIDE_API_KEY = "from-process";
    process.env.POOLSIDE_BASE_URL = "https://process.example/v1";
    const cfg = resolvePoolsideConfig({
      POOLSIDE_API_KEY: "from-binding",
      POOLSIDE_BASE_URL: "https://binding.example/v1",
    });
    expect(cfg.apiKey).toBe("from-binding");
    expect(cfg.baseURL).toBe("https://binding.example/v1");
  });

  it("falls back to process.env when the binding is absent (self-host Node)", () => {
    process.env.POOLSIDE_API_KEY = "from-process";
    process.env.POOLSIDE_BASE_URL = "https://process.example/v1";
    const cfg = resolvePoolsideConfig({});
    expect(cfg.apiKey).toBe("from-process");
    expect(cfg.baseURL).toBe("https://process.example/v1");
  });
});

describe("buildPoolsideModel", () => {
  it("builds an OpenAI-compatible model handle carrying the full model id", () => {
    expect(POOLSIDE_API_COMPAT).toBe("oai-compatible");
    const model = buildPoolsideModel({
      apiKey: "k",
      baseURL: POOLSIDE_DEFAULT_BASE_URL,
      modelId: "poolside/laguna-s-2.1",
    });
    expect(model).toBeTruthy();
    expect((model as { modelId?: string }).modelId).toBe("poolside/laguna-s-2.1");
  });
});

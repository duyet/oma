import { describe, expect, it } from "vitest";
import { resolvedModelOf } from "./default-loop";

describe("resolvedModelOf", () => {
  it("reports the concrete model a gateway alias resolved to", () => {
    expect(
      resolvedModelOf({ modelId: "anthropic/claude-sonnet-4-6" }, "anyrouter/free"),
    ).toBe("anthropic/claude-sonnet-4-6");
  });

  it("stays undefined when the provider echoes the configured handle", () => {
    // span.model_request_end.model already carries this; a duplicate would
    // make every consumer re-derive whether the model actually differed.
    expect(resolvedModelOf({ modelId: "claude-sonnet-4-6" }, "claude-sonnet-4-6")).toBeUndefined();
  });

  it("stays undefined when the provider reports nothing usable", () => {
    expect(resolvedModelOf(undefined, "anyrouter/free")).toBeUndefined();
    expect(resolvedModelOf({}, "anyrouter/free")).toBeUndefined();
    expect(resolvedModelOf({ modelId: "  " }, "anyrouter/free")).toBeUndefined();
  });

  it("trims provider whitespace so the console renders a clean id", () => {
    expect(resolvedModelOf({ modelId: " openai/gpt-5 " }, "anyrouter/free")).toBe("openai/gpt-5");
  });
});

import { describe, expect, it } from "vitest";

import { sumTokens } from "./useAgentQuickStats";

describe("sumTokens", () => {
  it("adds every model token kind, including cache and reasoning", () => {
    expect(
      sumTokens([
        { kind: "model_input_tokens", total: 100 },
        { kind: "model_output_tokens", total: 50 },
        { kind: "model_cache_read_tokens", total: 400 },
        { kind: "model_cache_creation_tokens", total: 20 },
        { kind: "model_reasoning_tokens", total: 30 },
      ]),
    ).toBe(600);
  });

  it("ignores non-token kinds so seconds are never counted as tokens", () => {
    expect(
      sumTokens([
        { kind: "sandbox_active_seconds", total: 9000 },
        { kind: "model_input_tokens", total: 10 },
      ]),
    ).toBe(10);
  });

  it("is 0 for an agent with no usage rows", () => {
    expect(sumTokens([])).toBe(0);
  });
});

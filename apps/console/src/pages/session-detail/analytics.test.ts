import { describe, expect, it } from "vitest";

import type { Event } from "../../lib/events";
import {
  computeSessionAnalytics,
  contextWindowFor,
  estimateCostUsd,
  sandboxProviderInfo,
} from "./analytics";

/** Minimal event-log fixtures. The shapes mirror what default-loop.ts
 *  actually emits — in particular `model_usage` nested under `data`, which
 *  is the wire shape the Inspector has to read defensively. */
function modelCall(opts: {
  id: string;
  startTs: string;
  endTs: string;
  model?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  isError?: boolean;
}): Event[] {
  return [
    { type: "span.model_request_start", id: opts.id, ts: opts.startTs } as Event,
    {
      type: "span.model_request_end",
      ts: opts.endTs,
      data: {
        model: opts.model ?? "claude-sonnet-4-6",
        model_request_start_id: opts.id,
        is_error: opts.isError ?? false,
        finish_reason: "stop",
        model_usage: {
          input_tokens: opts.input ?? 0,
          output_tokens: opts.output ?? 0,
          cache_read_input_tokens: opts.cacheRead ?? 0,
          cache_creation_input_tokens: opts.cacheWrite ?? 0,
          reasoning_tokens: 0,
        },
      },
    } as unknown as Event,
  ];
}

describe("computeSessionAnalytics", () => {
  it("sums the 5-way token split across every model call", () => {
    const a = computeSessionAnalytics([
      ...modelCall({
        id: "r1",
        startTs: "2026-01-01T00:00:00.000Z",
        endTs: "2026-01-01T00:00:02.000Z",
        input: 100,
        output: 50,
        cacheRead: 900,
        cacheWrite: 200,
      }),
      ...modelCall({
        id: "r2",
        startTs: "2026-01-01T00:00:10.000Z",
        endTs: "2026-01-01T00:00:14.000Z",
        input: 40,
        output: 20,
        cacheRead: 1200,
      }),
    ]);

    expect(a.totals).toEqual({
      input: 140,
      output: 70,
      cacheRead: 2100,
      cacheCreation: 200,
      reasoning: 0,
    });
    expect(a.modelCalls).toBe(2);
    expect(a.totalTokens).toBe(2510);
  });

  it("computes cache hit rate over prompt tokens only, excluding output", () => {
    const a = computeSessionAnalytics(
      modelCall({
        id: "r1",
        startTs: "2026-01-01T00:00:00.000Z",
        endTs: "2026-01-01T00:00:01.000Z",
        input: 100,
        output: 10_000,
        cacheRead: 300,
      }),
    );
    // 300 / (300 + 100 + 0) — output must not dilute the denominator.
    expect(a.cacheHitRate).toBeCloseTo(0.75, 5);
  });

  it("leaves cache hit rate undefined when no prompt tokens were billed", () => {
    expect(computeSessionAnalytics([]).cacheHitRate).toBeUndefined();
  });

  it("pairs start/end spans by id to derive latency", () => {
    const a = computeSessionAnalytics([
      ...modelCall({
        id: "r1",
        startTs: "2026-01-01T00:00:00.000Z",
        endTs: "2026-01-01T00:00:02.000Z",
      }),
      ...modelCall({
        id: "r2",
        startTs: "2026-01-01T00:00:10.000Z",
        endTs: "2026-01-01T00:00:14.000Z",
      }),
    ]);
    expect(a.latest?.durationMs).toBe(4000);
    expect(a.avgLatencyMs).toBe(3000);
    expect(a.p95LatencyMs).toBe(4000);
  });

  it("counts context occupancy as the full prompt, not fresh input alone", () => {
    const a = computeSessionAnalytics(
      modelCall({
        id: "r1",
        startTs: "2026-01-01T00:00:00.000Z",
        endTs: "2026-01-01T00:00:01.000Z",
        input: 500,
        cacheRead: 60_000,
        cacheWrite: 1_000,
      }),
    );
    // Using input_tokens alone would report 500 against a 200k window —
    // off by two orders of magnitude on a cached session.
    expect(a.contextTokens).toBe(61_500);
    expect(a.contextWindow).toBe(200_000);
  });

  it("aggregates tool calls, errors and durations by name and kind", () => {
    const a = computeSessionAnalytics([
      { type: "agent.tool_use", name: "bash", tool_use_id: "t1", ts: "2026-01-01T00:00:00.000Z" },
      { type: "agent.tool_result", tool_use_id: "t1", ts: "2026-01-01T00:00:03.000Z" },
      { type: "agent.tool_use", name: "bash", tool_use_id: "t2", ts: "2026-01-01T00:00:04.000Z" },
      {
        type: "agent.tool_result",
        tool_use_id: "t2",
        ts: "2026-01-01T00:00:05.000Z",
        is_error: true,
      },
      {
        type: "agent.mcp_tool_use",
        name: "linear_search",
        mcp_tool_use_id: "m1",
        ts: "2026-01-01T00:00:06.000Z",
      },
      { type: "agent.mcp_tool_result", mcp_tool_use_id: "m1", ts: "2026-01-01T00:00:07.000Z" },
    ] as unknown as Event[]);

    expect(a.toolCalls).toBe(3);
    expect(a.toolErrors).toBe(1);
    const bash = a.tools.find((t) => t.name === "bash");
    expect(bash).toMatchObject({ calls: 2, errors: 1, kind: "builtin" });
    // (3000 + 1000) / 2
    expect(bash?.avgMs).toBe(2000);
    expect(a.tools.find((t) => t.name === "linear_search")?.kind).toBe("mcp");
  });

  it("does not credit a tool result that has no matching tool_use", () => {
    const a = computeSessionAnalytics([
      { type: "agent.tool_result", tool_use_id: "orphan", is_error: true },
    ] as unknown as Event[]);
    expect(a.toolCalls).toBe(0);
    expect(a.toolErrors).toBe(0);
  });

  it("tracks distinct models so an aux-model call is visible", () => {
    const a = computeSessionAnalytics([
      ...modelCall({
        id: "r1",
        startTs: "2026-01-01T00:00:00.000Z",
        endTs: "2026-01-01T00:00:01.000Z",
        model: "claude-sonnet-4-6",
      }),
      ...modelCall({
        id: "r2",
        startTs: "2026-01-01T00:00:02.000Z",
        endTs: "2026-01-01T00:00:03.000Z",
        model: "claude-haiku-4-5",
      }),
    ]);
    expect(a.modelsUsed).toEqual(["claude-sonnet-4-6", "claude-haiku-4-5"]);
    expect(a.latestModel).toBe("claude-haiku-4-5");
  });
});

describe("estimateCostUsd", () => {
  it("prices cache reads at 10% and cache writes at 125% of input", () => {
    const cost = estimateCostUsd("claude-sonnet-4-6", {
      input: 1_000_000,
      output: 0,
      cacheRead: 1_000_000,
      cacheCreation: 1_000_000,
      reasoning: 0,
    });
    // 3 + 0.3 + 3.75
    expect(cost).toBeCloseTo(7.05, 6);
  });

  it("returns undefined for an unknown model rather than guessing", () => {
    expect(estimateCostUsd("some-custom-card", { input: 1000, output: 1000 })).toBeUndefined();
    expect(estimateCostUsd(undefined, { input: 1000, output: 1000 })).toBeUndefined();
  });
});

describe("contextWindowFor", () => {
  it("resolves known families and leaves unknown ones undefined", () => {
    expect(contextWindowFor("claude-sonnet-4-6")).toBe(200_000);
    expect(contextWindowFor("anthropic/claude-haiku-4-5")).toBe(200_000);
    expect(contextWindowFor("totally-unknown-model")).toBeUndefined();
  });
});

describe("sandboxProviderInfo", () => {
  it("treats `local` as an alias for the bridge-relayed subprocess provider", () => {
    expect(sandboxProviderInfo("local").id).toBe("subprocess");
    expect(sandboxProviderInfo("subprocess").label).toBe("Local machine (bridge)");
  });

  it("defaults to the cloud sandbox when no provider is configured", () => {
    expect(sandboxProviderInfo(undefined).id).toBe("cloud");
  });

  it("surfaces caveats for relay-based providers", () => {
    expect(sandboxProviderInfo("browser-vm").caveats.length).toBeGreaterThan(0);
    expect(sandboxProviderInfo("cloud").caveats).toEqual([]);
  });

  it("falls back to a labelled unknown entry rather than throwing", () => {
    const info = sandboxProviderInfo("some-future-provider");
    expect(info.id).toBe("some-future-provider");
    expect(info.workspace).toBe("/workspace");
  });
});

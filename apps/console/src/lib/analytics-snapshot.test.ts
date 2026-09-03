import { describe, expect, it } from "vitest";

import {
  areaPath,
  deriveAnalyticsSnapshot,
  deriveCostByAgent,
  deriveDelegationEdges,
  deriveTokenMix,
  estimateSonnetUsd,
  sumTokenKinds,
  type UsageByAgent,
  type UsageSummary,
} from "./analytics-snapshot";

const kinds = (
  input: number,
  output: number,
  extra: Array<{ kind: string; total: number }> = [],
) => [
  { kind: "model_input_tokens", total: input },
  { kind: "model_output_tokens", total: output },
  ...extra,
];

describe("sumTokenKinds", () => {
  it("adds every model token kind and ignores sandbox seconds", () => {
    expect(
      sumTokenKinds([
        { kind: "sandbox_active_seconds", total: 9000 },
        { kind: "model_input_tokens", total: 100 },
        { kind: "model_output_tokens", total: 50 },
        { kind: "model_cache_read_tokens", total: 400 },
        { kind: "model_cache_creation_tokens", total: 20 },
        { kind: "model_reasoning_tokens", total: 30 },
      ]),
    ).toBe(600);
  });
});

describe("estimateSonnetUsd", () => {
  it("matches agent-stats Sonnet-class rates (3/15 per MTok, no cache)", () => {
    // 200k in * $3/M + 40k out * $15/M = 0.60 + 0.60 = 1.20
    expect(
      estimateSonnetUsd(
        kinds(200_000, 40_000, [{ kind: "model_cache_read_tokens", total: 1_000_000 }]),
      ),
    ).toBeCloseTo(1.2, 5);
  });

  it("is 0 when there are no model tokens", () => {
    expect(estimateSonnetUsd([{ kind: "sandbox_active_seconds", total: 3600 }])).toBe(0);
  });
});

describe("deriveTokenMix", () => {
  it("splits kinds as percentages of the token total", () => {
    const mix = deriveTokenMix(kinds(80, 20));
    expect(mix.find((r) => r.kind === "input")).toEqual({
      kind: "input",
      tokens: 80,
      pct: 0.8,
    });
    expect(mix.find((r) => r.kind === "output")?.pct).toBe(0.2);
    expect(mix.find((r) => r.kind === "reasoning")?.tokens).toBe(0);
  });

  it("is all zeros when nothing has been billed", () => {
    const mix = deriveTokenMix([]);
    expect(mix.every((r) => r.tokens === 0 && r.pct === 0)).toBe(true);
  });
});

describe("deriveCostByAgent", () => {
  it("ranks by estimated spend and labels the null bucket Unattributed", () => {
    const rows: UsageByAgent[] = [
      {
        agent_id: "agent_cheap",
        agent_name: "Cheap",
        total_active_seconds: 10,
        total_sessions: 1,
        by_kind: kinds(1_000, 0),
      },
      {
        agent_id: "agent_rich",
        agent_name: "Rich",
        total_active_seconds: 10,
        total_sessions: 4,
        by_kind: kinds(1_000_000, 0),
      },
      {
        agent_id: null,
        agent_name: null,
        total_active_seconds: 10,
        total_sessions: 2,
        by_kind: kinds(100_000, 0),
      },
    ];
    const { rows: ranked, others } = deriveCostByAgent(rows);
    expect(others).toBeNull();
    expect(ranked.map((r) => r.label)).toEqual(["Rich", "Unattributed", "Cheap"]);
    expect(ranked[0]?.estUsd).toBeCloseTo(3, 5);
    expect(ranked[0]?.pctOfSpend).toBeCloseTo(3 / 3.303, 3);
  });

  it("buckets agents past the top 10 into Others", () => {
    const rows: UsageByAgent[] = Array.from({ length: 12 }, (_, i) => ({
      agent_id: `agent_${i}`,
      agent_name: `A${i}`,
      total_active_seconds: 0,
      total_sessions: 1,
      by_kind: kinds((12 - i) * 1_000_000, 0),
    }));
    const { rows: top, others } = deriveCostByAgent(rows);
    expect(top).toHaveLength(10);
    expect(top[0]?.label).toBe("A0");
    expect(others?.label).toBe("Others");
    expect(others?.tokens).toBe(2_000_000 + 1_000_000);
    expect(others?.estUsd).toBeCloseTo(9, 5);
  });
});

describe("deriveDelegationEdges", () => {
  it("walks local multiagent rosters and resolves child names", () => {
    const edges = deriveDelegationEdges([
      {
        id: "agent_lead",
        name: "Lead",
        multiagent: { agents: [{ id: "agent_research" }, { id: "agent_write" }] },
      },
      { id: "agent_research", name: "Researcher", multiagent: null },
      { id: "agent_write", name: "Writer" },
    ]);
    expect(edges).toEqual([
      {
        fromId: "agent_lead",
        fromName: "Lead",
        toId: "agent_research",
        toName: "Researcher",
      },
      {
        fromId: "agent_lead",
        fromName: "Lead",
        toId: "agent_write",
        toName: "Writer",
      },
    ]);
  });

  it("skips self-edges and agents with no roster", () => {
    expect(
      deriveDelegationEdges([
        { id: "solo", name: "Solo" },
        {
          id: "loop",
          name: "Loop",
          multiagent: { agents: [{ id: "loop" }] },
        },
      ]),
    ).toEqual([]);
  });
});

describe("deriveAnalyticsSnapshot", () => {
  it("rolls tenant totals and per-agent cost from one usage payload", () => {
    const usage: UsageSummary = {
      period: { days: 7, since: "2026-08-27T00:00:00.000Z" },
      total_active_seconds: 3600,
      total_sessions: 9,
      by_kind: kinds(1_000_000, 200_000),
      daily: [{ date: "2026-09-01", active_seconds: 60, runs: 2 }],
      by_agent: [
        {
          agent_id: "agent_1",
          agent_name: "Research Bot",
          total_active_seconds: 3600,
          total_sessions: 8,
          by_kind: kinds(800_000, 160_000),
        },
        {
          agent_id: null,
          agent_name: null,
          total_active_seconds: 0,
          total_sessions: 1,
          by_kind: kinds(200_000, 40_000),
        },
      ],
    };
    const snap = deriveAnalyticsSnapshot(usage, "7d");
    expect(snap.period).toBe("7d");
    expect(snap.totalTokens).toBe(1_200_000);
    expect(snap.estUsd).toBeCloseTo(6, 5);
    expect(snap.sessions).toBe(9);
    expect(snap.agentsWithUsage).toBe(1);
    expect(snap.costByAgent.rows[0]?.label).toBe("Research Bot");
    expect(snap.daily).toHaveLength(1);
  });
});

describe("areaPath", () => {
  it("closes a polygon from baseline through the series", () => {
    const d = areaPath([0, 50, 100], 100, 10);
    expect(d.startsWith("M0.00,10.00 L")).toBe(true);
    expect(d.endsWith(" L100.00,10.00 Z")).toBe(true);
    expect(d).toContain("50.00,5.00");
    expect(d).toContain("100.00,0.00");
  });

  it("is empty for no points", () => {
    expect(areaPath([], 100, 10)).toBe("");
  });
});

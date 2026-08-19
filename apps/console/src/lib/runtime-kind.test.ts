import { describe, expect, it } from "vitest";

import { RUNTIME_KINDS, agentRuntimeKind } from "./runtime-kind";

describe("agentRuntimeKind", () => {
  it("defaults to cloud for a plain agent", () => {
    expect(agentRuntimeKind({})).toBe("cloud");
    expect(agentRuntimeKind(null)).toBe("cloud");
  });

  it("reads a runtime binding from either the row or the _oma extension", () => {
    expect(agentRuntimeKind({ runtime_binding: { runtime_id: "rt_1" } })).toBe("local");
    expect(agentRuntimeKind({ _oma: { runtime_binding: { runtime_id: "rt_1" } } })).toBe("local");
    expect(agentRuntimeKind({ runtime_binding: { acp_agent_id: "claude-acp" } })).toBe("local");
  });

  it("reads the browser marker off metadata", () => {
    expect(agentRuntimeKind({ metadata: { runtime_kind: "browser" } })).toBe("browser");
  });

  it("lets a runtime binding win over a stale browser marker", () => {
    // The binding IS the local loop; a leftover marker must not claim
    // sessions run in a tab when they demonstrably run on a machine.
    expect(
      agentRuntimeKind({
        runtime_binding: { runtime_id: "rt_1" },
        metadata: { runtime_kind: "browser" },
      }),
    ).toBe("local");
  });

  it("ignores unrelated metadata", () => {
    expect(agentRuntimeKind({ metadata: { team: "platform" } })).toBe("cloud");
  });
});

describe("RUNTIME_KINDS", () => {
  it("gives every kind a distinct label, description and icon", () => {
    const kinds = Object.values(RUNTIME_KINDS);
    expect(kinds).toHaveLength(3);
    expect(new Set(kinds.map((k) => k.label)).size).toBe(3);
    expect(new Set(kinds.map((k) => k.Icon)).size).toBe(3);
    for (const k of kinds) expect(k.description.length).toBeGreaterThan(0);
  });
});

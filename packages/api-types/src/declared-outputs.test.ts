import { describe, expect, it } from "vitest";
import { declaredOutputsFromEvents } from "./declared-outputs";

describe("declaredOutputsFromEvents", () => {
  it("returns an empty list when nothing was declared", () => {
    expect(declaredOutputsFromEvents([
      { type: "user.message" },
      { type: "agent.tool_use", name: "write" },
    ])).toEqual([]);
  });

  it("projects agent.output_declared events in log order and strips data", () => {
    const out = declaredOutputsFromEvents([
      {
        type: "agent.output_declared",
        path: "/workspace/output/report.pdf",
        description: "Weekly metrics digest",
        media_type: "application/pdf",
        size_bytes: 89432,
        sha256: "abc",
        tool_use_id: "toolu_1",
        processed_at: "2026-08-03T14:32:00Z",
        data: "large-base64-payload",
      },
      {
        type: "agent.output_declared",
        path: "/workspace/output/summary.md",
        tool_use_id: "toolu_2",
        ts: "2026-08-03T14:33:00Z",
      },
    ]);
    expect(out).toEqual([
      {
        path: "/workspace/output/report.pdf",
        description: "Weekly metrics digest",
        media_type: "application/pdf",
        size_bytes: 89432,
        sha256: "abc",
        declared_at: "2026-08-03T14:32:00Z",
        tool_use_id: "toolu_1",
      },
      {
        path: "/workspace/output/summary.md",
        declared_at: "2026-08-03T14:33:00Z",
        tool_use_id: "toolu_2",
      },
    ]);
    expect(out[0]).not.toHaveProperty("data");
  });

  it("skips malformed declarations so one bad event cannot hide the rest", () => {
    const out = declaredOutputsFromEvents([
      { type: "agent.output_declared", path: "/a", tool_use_id: "" },
      { type: "agent.output_declared", path: "", tool_use_id: "t" },
      { type: "agent.output_declared", path: "/ok", tool_use_id: "t2" },
    ]);
    expect(out).toEqual([{ path: "/ok", tool_use_id: "t2" }]);
  });
});

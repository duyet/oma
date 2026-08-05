// Pure unit tests for CAS agent-MCP grouping (no SDK import).

import { describe, expect, it } from "vitest";
import {
  OMA_SANDBOX_MCP_NAME,
  groupPlatformMcpTools,
} from "../../apps/agent/src/harness/claude-agent-sdk/agent-mcp-group";

describe("groupPlatformMcpTools", () => {
  it("groups mcp__server__tool keys and skips the reserved oma server", () => {
    const tools = {
      mcp__github__list_issues: { description: "list" },
      mcp__github__create_issue: { description: "create" },
      mcp__linear__search: { description: "search" },
      [`mcp__${OMA_SANDBOX_MCP_NAME}__bash`]: { description: "must skip" },
      bash: { description: "not mcp" },
      mcp__broken: { description: "malformed" },
    };
    const grouped = groupPlatformMcpTools(tools);
    expect([...grouped.keys()].sort()).toEqual(["github", "linear"]);
    expect(grouped.get("github")?.map((e) => e.toolName).sort()).toEqual([
      "create_issue",
      "list_issues",
    ]);
    expect(grouped.get("linear")?.[0].platformKey).toBe("mcp__linear__search");
  });

  it("handles empty tools", () => {
    expect(groupPlatformMcpTools({}).size).toBe(0);
  });
});

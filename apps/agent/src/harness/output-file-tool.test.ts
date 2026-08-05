// Tests for the `output_file` built-in tool (issue #341).
// Verifies registration and execution: it writes to `/mnt/session/outputs/`
// and returns a stable, parseable result string.

import { describe, it, expect } from "vitest";
import { buildTools } from "./tools";
import type { AgentConfig } from "@duyet/oma-shared";
import type { SandboxExecutor } from "@getoma/sandbox-sdk";

const noopSandbox: SandboxExecutor = {
  exec: async () => { throw new Error("exec should not be called"); },
  readFile: async () => { throw new Error("readFile should not be called"); },
  writeFile: async () => { throw new Error("writeFile should not be called"); },
};

function agentWithOutputFile(): AgentConfig {
  return {
    tools: [{ type: "agent_toolset_20260401" }],
  } as unknown as AgentConfig;
}

describe("output_file availability", () => {
  it("is registered by default with the standard toolset", async () => {
    const tools = await buildTools(agentWithOutputFile(), noopSandbox, {});
    expect(tools.output_file).toBeDefined();
  });
});

describe("output_file execution", () => {
  it("writes to /mnt/session/outputs/<filename> and returns a confirmation", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const sandbox: SandboxExecutor = {
      exec: async () => { throw new Error("exec should not be called"); },
      readFile: async () => { throw new Error("readFile should not be called"); },
      writeFile: async (path, content) => {
        writes.push({ path, content });
        return content;
      },
    };

    const tools = await buildTools(agentWithOutputFile(), sandbox, {});
    const out = await tools.output_file.execute(
      { filename: "report.md", content: "# Hello\n" },
      { toolCallId: "t1", messages: [] },
    );

    expect(out).toBe("Wrote session output report.md");
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/mnt/session/outputs/report.md");
    expect(writes[0].content).toBe("# Hello\n");
  });

  it("preserves exact content and reports the requested filename", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const sandbox: SandboxExecutor = {
      exec: async () => { throw new Error("exec should not be called"); },
      readFile: async () => { throw new Error("readFile should not be called"); },
      writeFile: async (path, content) => {
        writes.push({ path, content });
        return content;
      },
    };

    const tools = await buildTools(agentWithOutputFile(), sandbox, {});
    const out = await tools.output_file.execute(
      { filename: "data/analysis.json", content: '{"ok":true}' },
      { toolCallId: "t2", messages: [] },
    );

    expect(out).toBe("Wrote session output data/analysis.json");
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/mnt/session/outputs/data/analysis.json");
    expect(writes[0].content).toBe('{"ok":true}');
  });

  it("returns an error string when writeFile throws", async () => {
    const badSandbox: SandboxExecutor = {
      exec: async () => { throw new Error("exec should not be called"); },
      readFile: async () => { throw new Error("readFile should not be called"); },
      writeFile: async () => { throw new Error("disk full"); },
    };
    const tools = await buildTools(agentWithOutputFile(), badSandbox, {});
    const out = await tools.output_file.execute(
      { filename: "report.md", content: "x" },
      { toolCallId: "t3", messages: [] },
    );

    expect(typeof out).toBe("string");
    expect(out).toContain("disk full");
  });
});

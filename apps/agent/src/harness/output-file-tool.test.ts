// Tests for the opt-in `output_file` tool (issue #341).
// Registration is gated like `browser` / `run_dynamic_worker`. Execution
// declares a deliverable: path-only is best-effort, `data` is inline
// base64, and legacy filename+content still writes under /mnt/session/outputs/.

import { describe, it, expect } from "vitest";
import { buildTools } from "./tools";
import type { AgentConfig } from "@duyet/oma-shared";
import type { SandboxExecutor } from "@getoma/sandbox-sdk";

const noopSandbox: SandboxExecutor = {
  exec: async () => { throw new Error("exec should not be called"); },
  readFile: async () => { throw new Error("readFile should not be called"); },
  writeFile: async () => { throw new Error("writeFile should not be called"); },
};

function agentWithToolset(): AgentConfig {
  return {
    tools: [{ type: "agent_toolset_20260401" }],
  } as unknown as AgentConfig;
}

function agentOptingIn(): AgentConfig {
  return {
    tools: [
      {
        type: "agent_toolset_20260401",
        configs: [{ name: "output_file", enabled: true }],
      },
    ],
  } as unknown as AgentConfig;
}

async function execOutputFile(
  sandbox: SandboxExecutor,
  args: Record<string, unknown>,
  toolCallId = "t1",
) {
  const tools = await buildTools(agentOptingIn(), sandbox, {});
  expect(tools.output_file).toBeDefined();
  return tools.output_file.execute(args, { toolCallId, messages: [] });
}

describe("output_file availability", () => {
  it("is omitted by default even with the standard toolset", async () => {
    const tools = await buildTools(agentWithToolset(), noopSandbox, {});
    expect(tools.output_file).toBeUndefined();
  });

  it("is registered when configs opt in", async () => {
    const tools = await buildTools(agentOptingIn(), noopSandbox, {});
    expect(tools.output_file).toBeDefined();
  });
});

describe("output_file execution", () => {
  it("path-only declare succeeds when the sandbox file is missing", async () => {
    const sandbox: SandboxExecutor = {
      exec: async () => { throw new Error("exec should not be called"); },
      readFile: async () => { throw new Error("no such file"); },
      writeFile: async () => { throw new Error("writeFile should not be called"); },
    };
    const out = await execOutputFile(sandbox, {
      path: "/workspace/output/report.pdf",
      description: "Weekly metrics digest",
      media_type: "application/pdf",
    });
    expect(typeof out).toBe("string");
    expect(out).not.toMatch(/^Error:/);
    const parsed = JSON.parse(out as string) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe("/workspace/output/report.pdf");
    expect(parsed.description).toBe("Weekly metrics digest");
    expect(parsed.media_type).toBe("application/pdf");
    expect(parsed.size_bytes).toBeUndefined();
  });

  it("path-only declare attaches size from a sandbox stat", async () => {
    const sandbox: SandboxExecutor = {
      exec: async () => { throw new Error("exec should not be called"); },
      readFile: async () => "hello",
      writeFile: async () => { throw new Error("writeFile should not be called"); },
    };
    const out = await execOutputFile(sandbox, { path: "/workspace/notes.md" });
    const parsed = JSON.parse(out as string) as Record<string, unknown>;
    expect(parsed.size_bytes).toBe(5);
    expect(parsed.media_type).toBe("text/markdown");
    expect(typeof parsed.sha256).toBe("string");
  });

  it("writes inline data via writeFileBytes and does not echo data in the result", async () => {
    const writes: Array<{ path: string; bytes: Uint8Array }> = [];
    const sandbox: SandboxExecutor = {
      exec: async () => { throw new Error("exec should not be called"); },
      readFile: async () => { throw new Error("readFile should not be called"); },
      writeFile: async () => { throw new Error("writeFile should not be called"); },
      writeFileBytes: async (path, bytes) => {
        writes.push({ path, bytes });
        return path;
      },
    };
    const out = await execOutputFile(sandbox, {
      path: "/workspace/output/hello.bin",
      data: "aGVsbG8=",
    });
    const parsed = JSON.parse(out as string) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.path).toBe("/workspace/output/hello.bin");
    expect(parsed.size_bytes).toBe(5);
    expect(parsed.data).toBeUndefined();
    expect(out as string).not.toContain("aGVsbG8=");
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/workspace/output/hello.bin");
    expect(new TextDecoder().decode(writes[0].bytes)).toBe("hello");
  });

  it("still declares when inline data cannot be written to the sandbox", async () => {
    const sandbox: SandboxExecutor = {
      exec: async () => { throw new Error("exec should not be called"); },
      readFile: async () => { throw new Error("readFile should not be called"); },
      writeFile: async () => { throw new Error("writeFile should not be called"); },
      writeFileBytes: async () => { throw new Error("disk full"); },
    };
    const out = await execOutputFile(sandbox, {
      path: "/workspace/output/hello.bin",
      data: "aGVsbG8=",
    });
    expect(out as string).not.toMatch(/^Error:/);
    const parsed = JSON.parse(out as string) as Record<string, unknown>;
    expect(parsed.ok).toBe(true);
    expect(parsed.size_bytes).toBe(5);
  });

  it("maps legacy filename+content to /mnt/session/outputs/", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const sandbox: SandboxExecutor = {
      exec: async () => { throw new Error("exec should not be called"); },
      readFile: async () => { throw new Error("readFile should not be called"); },
      writeFile: async (path, content) => {
        writes.push({ path, content });
        return content;
      },
    };
    const out = await execOutputFile(sandbox, {
      filename: "report.md",
      content: "# Hello\n",
    });
    const parsed = JSON.parse(out as string) as Record<string, unknown>;
    expect(parsed.path).toBe("/mnt/session/outputs/report.md");
    expect(parsed.size_bytes).toBe(new TextEncoder().encode("# Hello\n").byteLength);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe("/mnt/session/outputs/report.md");
    expect(writes[0].content).toBe("# Hello\n");
  });

  it("returns an error string when a legacy content write throws", async () => {
    const badSandbox: SandboxExecutor = {
      exec: async () => { throw new Error("exec should not be called"); },
      readFile: async () => { throw new Error("readFile should not be called"); },
      writeFile: async () => { throw new Error("disk full"); },
    };
    const out = await execOutputFile(badSandbox, {
      filename: "report.md",
      content: "x",
    });
    expect(typeof out).toBe("string");
    expect(out).toContain("disk full");
  });

  it("independent calls do not conflict", async () => {
    const sandbox: SandboxExecutor = {
      exec: async () => { throw new Error("exec should not be called"); },
      readFile: async () => { throw new Error("no such file"); },
      writeFile: async () => { throw new Error("writeFile should not be called"); },
    };
    const tools = await buildTools(agentOptingIn(), sandbox, {});
    const a = await tools.output_file.execute(
      { path: "/workspace/a.pdf" },
      { toolCallId: "t1", messages: [] },
    );
    const b = await tools.output_file.execute(
      { path: "/workspace/b.md", description: "Notes" },
      { toolCallId: "t2", messages: [] },
    );
    expect(JSON.parse(a as string).path).toBe("/workspace/a.pdf");
    expect(JSON.parse(b as string).path).toBe("/workspace/b.md");
    expect(JSON.parse(b as string).description).toBe("Notes");
  });
});

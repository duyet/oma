// Verifies buildTools generates a `call_remote_agent_*` tool for a
// `type: "remote_agent"` callable_agents entry (issue #132) and routes its
// execution through env.delegateToRemoteAgent.

import { describe, it, expect } from "vitest";
import { buildTools } from "./tools";
import type { AgentConfig } from "@duyet/oma-api-types";
import type { SandboxExecutor } from "./interface";

const fakeSandbox = {
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
  destroy: async () => {},
} as unknown as SandboxExecutor;

function baseAgent(overrides: Partial<AgentConfig>): AgentConfig {
  return {
    id: "agent_1",
    name: "Test",
    model: "claude-sonnet-4-6",
    system: "",
    tools: [],
    version: 1,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("federation call_remote_agent tool", () => {
  it("generates a call_remote_agent_* tool and delegates to it", async () => {
    const calls: Array<[string, string, string, string | undefined]> = [];
    const agent = baseAgent({
      callable_agents: [
        { type: "remote_agent", instance_id: "fed_abc", remote_agent_id: "agent_xyz" },
      ],
    });
    const tools = (await buildTools(agent, fakeSandbox, {
      ANTHROPIC_API_KEY: "sk-test",
      delegateToRemoteAgent: async (instanceId, remoteAgentId, message, remoteEnvId) => {
        calls.push([instanceId, remoteAgentId, message, remoteEnvId]);
        return "remote reply";
      },
    })) as Record<string, { execute: (args: unknown) => Promise<unknown> }>;

    const toolName = "call_remote_agent_fed_abc_agent_xyz";
    expect(tools[toolName]).toBeDefined();
    // A remote-only roster still gets call_agents_parallel (remote fan-out,
    // issue #132 follow-up), but no per-agent local `call_agent_*` tool.
    expect(tools.call_agents_parallel).toBeDefined();
    expect(tools.call_agent_agent_xyz).toBeUndefined();

    const out = await tools[toolName].execute({ message: "do it" });
    expect(out).toBe("remote reply");
    expect(calls).toEqual([["fed_abc", "agent_xyz", "do it", undefined]]);
  });

  it("returns an unavailable message when no remote executor is wired", async () => {
    const agent = baseAgent({
      callable_agents: [
        { type: "remote_agent", instance_id: "fed_abc", remote_agent_id: "agent_xyz" },
      ],
    });
    const tools = (await buildTools(agent, fakeSandbox, {
      ANTHROPIC_API_KEY: "sk-test",
    })) as Record<string, { execute: (args: unknown) => Promise<unknown> }>;
    const out = await tools.call_remote_agent_fed_abc_agent_xyz.execute({ message: "x" });
    expect(String(out)).toMatch(/not available/);
  });
});

describe("federation call_agents_parallel fan-out (issue #132)", () => {
  it("fans out to remote agents concurrently with per-call isolation", async () => {
    const calls: Array<[string, string, string, string | undefined]> = [];
    const agent = baseAgent({
      callable_agents: [
        { type: "agent", id: "agent_local" },
        { type: "remote_agent", instance_id: "fed_a", remote_agent_id: "agent_ok" },
        {
          type: "remote_agent",
          instance_id: "fed_a",
          remote_agent_id: "agent_err",
          remote_environment_id: "env_r",
        },
      ],
    });
    const tools = (await buildTools(agent, fakeSandbox, {
      ANTHROPIC_API_KEY: "sk-test",
      delegateToAgentDetailed: async (agentId, message) => ({ text: `local:${agentId}:${message}` }),
      delegateToRemoteAgent: async (instanceId, remoteAgentId, message, remoteEnvId) => {
        calls.push([instanceId, remoteAgentId, message, remoteEnvId]);
        if (remoteAgentId === "agent_err") throw new Error("boom");
        return `remote:${remoteAgentId}`;
      },
    })) as Record<string, { execute: (args: unknown) => Promise<unknown> }>;

    expect(tools.call_agents_parallel).toBeDefined();

    const raw = await tools.call_agents_parallel.execute({
      calls: [
        { agent_id: "agent_local", message: "L" },
        { agent_id: "agent_ok", instance_id: "fed_a", message: "R1" },
        { agent_id: "agent_err", instance_id: "fed_a", message: "R2" },
        { agent_id: "agent_ghost", instance_id: "fed_a", message: "R3" },
      ],
    });
    const { results } = JSON.parse(String(raw));

    expect(results[0]).toEqual({ agent_id: "agent_local", success: true, response: "local:agent_local:L" });
    expect(results[1]).toEqual({ agent_id: "agent_ok", instance_id: "fed_a", success: true, response: "remote:agent_ok" });
    // One failing remote entry doesn't abort the batch.
    expect(results[2]).toMatchObject({ agent_id: "agent_err", instance_id: "fed_a", success: false });
    expect(String(results[2].error)).toMatch(/boom/);
    // Unknown (instance, agent) pair fails just its own entry.
    expect(results[3]).toMatchObject({ agent_id: "agent_ghost", instance_id: "fed_a", success: false });
    expect(String(results[3].error)).toMatch(/not in this agent's callable_agents roster/);

    // remote_environment_id forwarded for the erroring entry.
    expect(calls).toContainEqual(["fed_a", "agent_err", "R2", "env_r"]);
    expect(calls).toContainEqual(["fed_a", "agent_ok", "R1", undefined]);
  });

  it("reports remote entries as unavailable when no remote executor is wired", async () => {
    const agent = baseAgent({
      callable_agents: [
        { type: "remote_agent", instance_id: "fed_a", remote_agent_id: "agent_ok" },
      ],
    });
    const tools = (await buildTools(agent, fakeSandbox, {
      ANTHROPIC_API_KEY: "sk-test",
    })) as Record<string, { execute: (args: unknown) => Promise<unknown> }>;

    const raw = await tools.call_agents_parallel.execute({
      calls: [{ agent_id: "agent_ok", instance_id: "fed_a", message: "R" }],
    });
    const { results } = JSON.parse(String(raw));
    expect(results[0]).toMatchObject({ agent_id: "agent_ok", instance_id: "fed_a", success: false });
    expect(String(results[0].error)).toMatch(/not available/);
  });
});

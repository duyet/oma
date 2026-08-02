// OmaRemoteHarness (issue #132 M1): the proxied-session harness. Drives it
// against a faked `proxyRemoteTurn` port so no network, no SessionDO, and no
// federation registry is involved — the port is exactly the seam that keeps
// the remote's API key inside SessionDO.

import { describe, it, expect } from "vitest";
import { OmaRemoteHarness } from "./oma-remote-loop";
import type { HarnessContext } from "./interface";
import type { SessionEvent } from "@duyet/oma-shared";
import type { EnvironmentConfig } from "@duyet/oma-api-types";

function remoteEnvironment(overrides: Record<string, unknown> = {}): EnvironmentConfig {
  return {
    id: "env_fed",
    name: "homelab",
    config: {
      type: "cloud",
      sandbox_provider: "oma-remote",
      remote: { instance_id: "fed_home", agent_id: "agent_remote", environment_id: "env_k8s" },
      ...overrides,
    },
  } as EnvironmentConfig;
}

function buildCtx(
  env: HarnessContext["env"],
  environment: EnvironmentConfig | undefined,
  broadcast: (e: SessionEvent) => void,
): HarnessContext {
  return {
    agent: { id: "agent_local", name: "n", model: "m", system: "", tools: [] },
    userMessage: { type: "user.message", content: [{ type: "text", text: "do the thing" }] },
    environment,
    tools: {},
    systemPrompt: "",
    env,
    runtime: { broadcast },
  } as unknown as HarnessContext;
}

describe("OmaRemoteHarness", () => {
  it("forwards the turn and mirrors the remote's agent events into the origin log", async () => {
    const events: SessionEvent[] = [];
    const seen: unknown[] = [];
    const env = {
      proxyRemoteTurn: async (opts: {
        instanceId: string;
        remoteAgentId: string;
        remoteEnvironmentId?: string;
        message: string;
        onRemoteEvent: (e: { seq?: number; type?: string; content?: unknown }) => void;
      }) => {
        seen.push([opts.instanceId, opts.remoteAgentId, opts.remoteEnvironmentId, opts.message]);
        opts.onRemoteEvent({ seq: 1, type: "session.status_running" });
        opts.onRemoteEvent({ seq: 2, type: "agent.tool_use", content: { name: "bash" } });
        opts.onRemoteEvent({
          seq: 3,
          type: "agent.message",
          content: [{ type: "text", text: "done on the homelab" }],
        });
        opts.onRemoteEvent({ seq: 4, type: "session.status_idle" });
        return { remote_session_id: "sess_remote", text: "done on the homelab" };
      },
    } as unknown as HarnessContext["env"];

    await new OmaRemoteHarness().run(buildCtx(env, remoteEnvironment(), (e) => events.push(e)));

    expect(seen).toEqual([["fed_home", "agent_remote", "env_k8s", "do the thing"]]);
    // Only agent.* records are copied; the origin owns its own lifecycle.
    expect(events.map((e) => e.type)).toEqual(["agent.tool_use", "agent.message"]);
    const message = events[1] as unknown as {
      content: Array<{ text: string }>;
      metadata: Record<string, unknown>;
    };
    expect(message.content[0].text).toBe("done on the homelab");
    expect(message.metadata).toMatchObject({ remote_instance_id: "fed_home", remote_seq: 3 });
    expect(events.some((e) => e.type === "session.error")).toBe(false);
  });

  it("fails loudly (session.error, no local run) when federation is unwired", async () => {
    const events: SessionEvent[] = [];
    await new OmaRemoteHarness().run(
      buildCtx({} as HarnessContext["env"], remoteEnvironment(), (e) => events.push(e)),
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session.error");
    expect((events[0] as unknown as { error: string }).error).toMatch(/proxyRemoteTurn unwired/);
  });

  it("fails loudly when the environment has no remote binding", async () => {
    const events: SessionEvent[] = [];
    const env = { proxyRemoteTurn: async () => ({ remote_session_id: "x", text: "" }) } as unknown as HarnessContext["env"];
    await new OmaRemoteHarness().run(
      buildCtx(env, remoteEnvironment({ remote: undefined }), (e) => events.push(e)),
    );
    expect(events[0].type).toBe("session.error");
    expect((events[0] as unknown as { error: string }).error).toMatch(/environment\.config\.remote/);
  });

  it("surfaces a remote/transport failure as session.error rather than swallowing it", async () => {
    const events: SessionEvent[] = [];
    const env = {
      proxyRemoteTurn: async () => {
        throw new Error("federation instance fed_home not found for this tenant");
      },
    } as unknown as HarnessContext["env"];

    await new OmaRemoteHarness().run(buildCtx(env, remoteEnvironment(), (e) => events.push(e)));

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("session.error");
    expect((events[0] as unknown as { error: string }).error).toMatch(
      /Remote OMA session failed: federation instance fed_home not found/,
    );
  });

  it("runs no model loop of its own", () => {
    const h = new OmaRemoteHarness();
    expect(h.shouldCompact()).toBe(false);
    expect(h.deriveModelContext()).toEqual([]);
  });
});

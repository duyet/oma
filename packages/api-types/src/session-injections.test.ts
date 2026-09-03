import { describe, expect, it } from "vitest";
import {
  MAX_PROMPT_APPENDS,
  applyInjectionCommand,
  applyOverlayToAgent,
  applyToolOverrides,
  configUpdatedEvent,
  credentialIdForHost,
  emptyInjectionOverlay,
  injectionCommandSchema,
  injectionReminders,
  mergeMcpServers,
  normalizeHost,
  overlayFromMetadata,
  parseInjectionOverlay,
  pickMcpServer,
  stripInjectionsFromMetadata,
} from "./session-injections";
import type { AgentConfig } from "./types";

const now = "2026-09-03T15:00:00.000Z";
const id = "inj_1";

describe("injectionCommandSchema", () => {
  it("accepts each command variant", () => {
    expect(injectionCommandSchema.parse({ type: "system_prompt_append", text: "Be careful." }).type)
      .toBe("system_prompt_append");
    expect(injectionCommandSchema.parse({
      type: "mcp_server_add",
      name: "linear",
      url: "https://linear.app/mcp",
    }).type).toBe("mcp_server_add");
    expect(injectionCommandSchema.parse({
      type: "tools_update",
      enabled: ["browser"],
      disabled: ["web_search"],
    }).type).toBe("tools_update");
    expect(injectionCommandSchema.parse({
      type: "credential_inject",
      host: "api.example.com",
      credential_id: "cred_1",
    }).type).toBe("credential_inject");
  });

  it("rejects a prompt over the cap, a token field, and MCP without url or registry", () => {
    expect(injectionCommandSchema.safeParse({
      type: "system_prompt_append",
      text: "x".repeat(8001),
    }).success).toBe(false);
    expect(injectionCommandSchema.safeParse({
      type: "credential_inject",
      host: "api.example.com",
      credential_id: "cred_1",
      token: "secret",
    }).success).toBe(true);
    expect(injectionCommandSchema.parse({
      type: "credential_inject",
      host: "api.example.com",
      credential_id: "cred_1",
      token: "secret",
    })).not.toHaveProperty("token");
    expect(injectionCommandSchema.safeParse({
      type: "mcp_server_add",
      name: "linear",
    }).success).toBe(false);
    expect(injectionCommandSchema.safeParse({
      type: "mcp_server_add",
      name: "linear",
      url: "ftp://linear.app/mcp",
    }).success).toBe(false);
  });
});

describe("applyInjectionCommand", () => {
  it("appends a prompt, then drops the oldest past the cap", () => {
    let overlay = emptyInjectionOverlay();
    for (let i = 0; i < MAX_PROMPT_APPENDS + 2; i++) {
      overlay = applyInjectionCommand(
        overlay,
        { type: "system_prompt_append", text: `n${i}` },
        now,
        `inj_${i}`,
      );
    }
    expect(overlay.prompt_appends).toHaveLength(MAX_PROMPT_APPENDS);
    expect(overlay.prompt_appends[0].text).toBe("n2");
    expect(overlay.prompt_appends.at(-1)?.text).toBe(`n${MAX_PROMPT_APPENDS + 1}`);
  });

  it("upserts MCP by name and credentials by host", () => {
    let overlay = applyInjectionCommand(
      emptyInjectionOverlay(),
      { type: "mcp_server_add", name: "linear", url: "https://a.example/mcp" },
      now,
      id,
    );
    overlay = applyInjectionCommand(
      overlay,
      { type: "mcp_server_add", name: "linear", url: "https://b.example/mcp", credential_id: "cred_x" },
      now,
      id,
    );
    expect(overlay.mcp_servers).toEqual([
      { name: "linear", url: "https://b.example/mcp", credential_id: "cred_x" },
    ]);
    overlay = applyInjectionCommand(
      overlay,
      { type: "credential_inject", host: "API.Example.com", credential_id: "cred_1" },
      now,
      id,
    );
    overlay = applyInjectionCommand(
      overlay,
      { type: "credential_inject", host: "https://api.example.com/v1", credential_id: "cred_2" },
      now,
      id,
    );
    expect(overlay.credentials).toEqual([
      { host: "api.example.com", credential_id: "cred_2" },
    ]);
  });

  it("merges tool overrides without losing earlier toggles", () => {
    let overlay = applyInjectionCommand(
      emptyInjectionOverlay(),
      { type: "tools_update", enabled: ["browser"], disabled: ["web_search"] },
      now,
      id,
    );
    overlay = applyInjectionCommand(
      overlay,
      { type: "tools_update", enabled: ["web_search"] },
      now,
      id,
    );
    expect(overlay.tool_overrides).toEqual({ browser: true, web_search: true });
  });
});

describe("overlay helpers", () => {
  it("strips the overlay key from public session metadata", () => {
    expect(stripInjectionsFromMetadata({
      team: "ops",
      _oma_injections: { prompt_appends: [] },
    })).toEqual({ team: "ops" });
  });

  it("reads the overlay from session metadata and ignores junk", () => {
    const overlay = overlayFromMetadata({
      _oma_injections: {
        prompt_appends: [{ id: "inj_1", text: "hi", injected_at: now }],
        mcp_servers: [{ name: "bad" }, { name: "ok", url: "https://x.example/mcp" }],
        tool_overrides: { bash: true, skip: "yes" },
        credentials: [{ host: "Api.X.example", credential_id: "cred_1" }],
      },
    });
    expect(overlay.prompt_appends).toHaveLength(1);
    expect(overlay.mcp_servers).toEqual([{ name: "ok", url: "https://x.example/mcp" }]);
    expect(overlay.tool_overrides).toEqual({ bash: true });
    expect(overlay.credentials).toEqual([{ host: "api.x.example", credential_id: "cred_1" }]);
    expect(parseInjectionOverlay(null)).toEqual(emptyInjectionOverlay());
  });

  it("builds operator-injection reminders without putting tokens in the source", () => {
    const overlay = applyInjectionCommand(
      emptyInjectionOverlay(),
      { type: "system_prompt_append", text: "Run npm test." },
      now,
      id,
    );
    expect(injectionReminders(overlay)).toEqual([
      {
        source: "operator-injection:inj_1",
        text: "[Operator injection at 2026-09-03T15:00:00.000Z]\n\nRun npm test.",
      },
    ]);
  });

  it("picks overlay credentials by host and MCP overlay-wins on name", () => {
    const overlay = applyInjectionCommand(
      applyInjectionCommand(
        emptyInjectionOverlay(),
        { type: "credential_inject", host: "api.example.com", credential_id: "cred_over" },
        now,
        id,
      ),
      { type: "mcp_server_add", name: "linear", url: "https://injected.example/mcp" },
      now,
      id,
    );
    expect(credentialIdForHost(overlay, "api.example.com")).toBe("cred_over");
    expect(pickMcpServer(
      [{ name: "linear", url: "https://agent.example/mcp" }],
      overlay,
      "linear",
    )?.url).toBe("https://injected.example/mcp");
    expect(mergeMcpServers(
      [{ name: "existing", type: "url", url: "https://old.example/mcp" }],
      overlay.mcp_servers,
    ).map((s) => s.name)).toEqual(["existing", "linear"]);
  });

  it("never puts a token or prompt body on the audit event for credential/prompt inject", () => {
    const credEv = configUpdatedEvent({
      type: "credential_inject",
      host: "api.example.com",
      credential_id: "cred_1",
    }, id);
    expect(JSON.stringify(credEv)).not.toMatch(/token|secret|Bearer/i);
    expect(credEv.detail).toEqual({
      credential_injected: { host: "api.example.com", credential_id: "cred_1" },
    });
    const promptEv = configUpdatedEvent({
      type: "system_prompt_append",
      text: "secret prompt body",
    }, id);
    expect(JSON.stringify(promptEv)).not.toContain("secret prompt body");
    expect(promptEv.detail).toEqual({ system_prompt_append: { id } });
  });

  it("normalizes hosts and applies tool overrides", () => {
    expect(normalizeHost("HTTPS://API.Example.com/foo")).toBe("api.example.com");
    const enabled = applyToolOverrides(new Set(["bash", "read"]), {
      browser: true,
      bash: false,
    });
    expect([...enabled].sort()).toEqual(["browser", "read"]);
  });
});

describe("applyOverlayToAgent", () => {
  const base = (): AgentConfig => ({
    id: "agent_1",
    name: "A",
    model: "claude-sonnet-4-6",
    system: "s",
    tools: [{ type: "agent_toolset_20260401" }],
    mcp_servers: [{ name: "existing", type: "url", url: "https://old.example/mcp" }],
  });

  it("adds mcp_servers without mutating the input", () => {
    const snap = base();
    const overlay = applyInjectionCommand(
      emptyInjectionOverlay(),
      { type: "mcp_server_add", name: "linear", url: "https://linear.app/mcp" },
      now,
      id,
    );
    const out = applyOverlayToAgent(snap, overlay);
    expect(snap.mcp_servers).toHaveLength(1);
    expect(out.mcp_servers?.map((s) => s.name)).toEqual(["existing", "linear"]);
  });

  it("writes toolset configs from overlay overrides", () => {
    const snap = base();
    const overlay = applyInjectionCommand(
      emptyInjectionOverlay(),
      { type: "tools_update", enabled: ["browser"], disabled: ["web_search"] },
      now,
      id,
    );
    const out = applyOverlayToAgent(snap, overlay);
    const ts = out.tools[0] as { configs?: Array<{ name: string; enabled: boolean }> };
    expect(ts.configs).toEqual(
      expect.arrayContaining([
        { name: "browser", enabled: true },
        { name: "web_search", enabled: false },
      ]),
    );
  });
});

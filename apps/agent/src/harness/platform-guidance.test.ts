import { describe, expect, it } from "vitest";
import {
  buildSandboxEnvironmentGuidance,
  composeSystemPrompt,
  platformGuidance,
  sessionOutputsGuidance,
} from "./platform-guidance";

describe("buildSandboxEnvironmentGuidance", () => {
  it("returns null when no environment is provided", () => {
    expect(buildSandboxEnvironmentGuidance(null)).toBeNull();
    expect(buildSandboxEnvironmentGuidance(undefined)).toBeNull();
  });

  it("includes provider, paths, and browser-vm notes", () => {
    const text = buildSandboxEnvironmentGuidance({
      id: "env_1",
      name: "Browser sandbox",
      description: "WASM tab",
      config: {
        type: "cloud",
        sandbox_provider: "browser-vm",
        networking: { type: "unrestricted" },
      },
    });
    expect(text).toContain("## Sandbox environment");
    expect(text).toContain("Browser sandbox");
    expect(text).toContain("`env_1`");
    expect(text).toContain("`browser-vm`");
    expect(text).toContain("/workspace");
    expect(text).toContain("/mnt/session/outputs/");
    expect(text).toContain("No inbound SSH");
    expect(text).toContain("Networking**: unrestricted");
  });

  it("sorts packages and limited hosts for cache stability", () => {
    const a = buildSandboxEnvironmentGuidance({
      id: "env_a",
      name: "A",
      config: {
        type: "cloud",
        packages: { pip: ["z", "a"], npm: ["lodash"] },
        networking: { type: "limited", allowed_hosts: ["b.example", "a.example"] },
      },
    });
    const b = buildSandboxEnvironmentGuidance({
      id: "env_a",
      name: "A",
      config: {
        type: "cloud",
        packages: { pip: ["a", "z"], npm: ["lodash"] },
        networking: { type: "limited", allowed_hosts: ["a.example", "b.example"] },
      },
    });
    expect(a).toBe(b);
    expect(a).toContain("pip: a, z");
    expect(a).toContain("`a.example`");
    expect(a!.indexOf("a.example")).toBeLessThan(a!.indexOf("b.example"));
  });

  it("mentions auto-cloned git repo and local ACP binding", () => {
    const text = buildSandboxEnvironmentGuidance({
      id: "env_local",
      name: "Laptop",
      config: {
        type: "subprocess",
        kind: "local",
        sandbox_provider: "subprocess",
        git_repo: { url: "https://github.com/acme/app", branch: "main" },
        local: {
          runtime_id: "rt_1",
          acp_agent_id: "claude-acp",
          working_dir: "/Users/me/code",
        },
      },
    });
    expect(text).toContain("Auto-cloned repo");
    expect(text).toContain("github.com/acme/app");
    expect(text).toContain("Local ACP agent");
    expect(text).toContain("claude-acp");
    expect(text).toContain("/Users/me/code");
    expect(text).toContain("Execution kind**: local");
  });

  it("omits FS paths for dynamic-workers", () => {
    const text = buildSandboxEnvironmentGuidance({
      id: "env_dw",
      name: "Eval",
      config: { type: "dynamic-workers", sandbox_provider: "dynamic-workers" },
    });
    expect(text).not.toContain("/workspace");
    expect(text).toContain("V8 isolate");
  });
});

describe("composeSystemPrompt", () => {
  it("appends platform guidance and sandbox block after agent system", () => {
    const out = composeSystemPrompt("You are a coder.", undefined, {
      id: "env_1",
      name: "Cloud",
      config: { type: "cloud", sandbox_provider: "cloud" },
    });
    expect(out.startsWith("You are a coder.")).toBe(true);
    expect(out).toContain(platformGuidance);
    expect(out).toContain(sessionOutputsGuidance);
    expect(out).toContain("## Sandbox environment");
    expect(out).toContain("`cloud`");
    // Order: agent → platform → sandbox
    expect(out.indexOf("You are a coder.")).toBeLessThan(out.indexOf(sessionOutputsGuidance));
    expect(out.indexOf(sessionOutputsGuidance)).toBeLessThan(out.indexOf("## Sandbox environment"));
  });

  it("wraps reminders after the sandbox block", () => {
    const out = composeSystemPrompt(
      "Base",
      [{ source: "skill:x", text: "Do X carefully." }],
      { id: "e", name: "E", config: { type: "cloud" } },
    );
    expect(out).toContain('<source name="skill:x">');
    expect(out.indexOf("## Sandbox environment")).toBeLessThan(out.indexOf('<source name="skill:x">'));
  });

  it("is byte-stable for the same env across calls", () => {
    const env = {
      id: "env_1",
      name: "Cloud",
      config: {
        type: "cloud" as const,
        packages: { apt: ["curl", "git"] },
      },
    };
    expect(composeSystemPrompt("S", [], env)).toBe(composeSystemPrompt("S", [], env));
  });
});

import { describe, expect, it } from "vitest";

import {
  browserVmEnvironments,
  isBrowserVmEnvironment,
  newBrowserEnvironmentBody,
  preferredEnvironmentId,
} from "./browser-env";

describe("isBrowserVmEnvironment", () => {
  it("matches on sandbox_provider and on the legacy type field", () => {
    expect(isBrowserVmEnvironment({ id: "e1", name: "a", config: { sandbox_provider: "browser-vm" } })).toBe(true);
    expect(isBrowserVmEnvironment({ id: "e2", name: "b", config: { type: "browser-vm" } })).toBe(true);
  });

  it("lets sandbox_provider win over a stale legacy type", () => {
    expect(
      isBrowserVmEnvironment({ id: "e3", name: "c", config: { sandbox_provider: "cloud", type: "browser-vm" } }),
    ).toBe(false);
  });

  it("is false for other providers and for an env with no config", () => {
    expect(isBrowserVmEnvironment({ id: "e4", name: "d", config: { sandbox_provider: "k8s" } })).toBe(false);
    expect(isBrowserVmEnvironment({ id: "e5", name: "e" })).toBe(false);
  });
});

describe("browserVmEnvironments", () => {
  it("keeps only the browser-vm rows", () => {
    const envs = [
      { id: "e1", name: "cloud", config: { sandbox_provider: "cloud" } },
      { id: "e2", name: "tab", config: { sandbox_provider: "browser-vm" } },
    ];
    expect(browserVmEnvironments(envs).map((e) => e.id)).toEqual(["e2"]);
  });
});

describe("newBrowserEnvironmentBody", () => {
  it("sets both provider fields so either reader resolves browser-vm", () => {
    const body = newBrowserEnvironmentBody();
    expect(body.config.sandbox_provider).toBe("browser-vm");
    expect(body.config.type).toBe("browser-vm");
  });
});

describe("preferredEnvironmentId", () => {
  it("prefers the agent's declared environment over the tenant default", () => {
    expect(preferredEnvironmentId({ default_environment_id: "env_browser" }, "env_only")).toBe(
      "env_browser",
    );
  });

  it("falls back to the single-environment shortcut, then to empty", () => {
    expect(preferredEnvironmentId(undefined, "env_only")).toBe("env_only");
    expect(preferredEnvironmentId({}, null)).toBe("");
  });

  it("ignores a non-string metadata value rather than sending it as an id", () => {
    expect(preferredEnvironmentId({ default_environment_id: 42 }, null)).toBe("");
  });
});

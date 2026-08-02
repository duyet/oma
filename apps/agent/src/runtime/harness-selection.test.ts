// Unit tests for resolveHarnessNameForEnvironment — the environment → harness
// decision SessionDO makes on every turn.

import { describe, it, expect } from "vitest";
import { resolveHarnessNameForEnvironment } from "./harness-selection";
import type { EnvironmentConfig } from "@duyet/oma-api-types";

const env = (config: Record<string, unknown>): EnvironmentConfig =>
  ({ id: "env_1", name: "e", config }) as EnvironmentConfig;

describe("resolveHarnessNameForEnvironment", () => {
  it("defaults to the default harness", () => {
    expect(resolveHarnessNameForEnvironment(undefined)).toBe("default");
    expect(resolveHarnessNameForEnvironment(env({ type: "cloud" }))).toBe("default");
  });

  it("honors an explicit config.harness for cloud environments", () => {
    expect(resolveHarnessNameForEnvironment(env({ type: "cloud", harness: "long-running" }))).toBe(
      "long-running",
    );
  });

  it('implies acp-proxy for kind: "local"', () => {
    expect(resolveHarnessNameForEnvironment(env({ type: "cloud", kind: "local", harness: "long-running" }))).toBe(
      "acp-proxy",
    );
  });

  it('implies oma-remote for sandbox_provider: "oma-remote" (issue #132 M1)', () => {
    expect(resolveHarnessNameForEnvironment(env({ type: "cloud", sandbox_provider: "oma-remote" }))).toBe(
      "oma-remote",
    );
  });

  it("does not let config.harness override a federated environment", () => {
    expect(
      resolveHarnessNameForEnvironment(env({ type: "cloud", sandbox_provider: "oma-remote", harness: "default" })),
    ).toBe("oma-remote");
  });

  it("leaves every other sandbox_provider on the default harness", () => {
    expect(resolveHarnessNameForEnvironment(env({ type: "cloud", sandbox_provider: "k8s-remote" }))).toBe("default");
  });
});

import { describe, expect, it } from "vitest";
import {
  DEFAULT_ENV_METADATA_KEY,
  defaultEnvironmentIdFromMetadata,
  resolveSessionEnvironmentId,
  validateDefaultEnvironmentMetadata,
} from "./resolve-environment";

describe("defaultEnvironmentIdFromMetadata", () => {
  it("returns null for missing / empty / wrong type", () => {
    expect(defaultEnvironmentIdFromMetadata(undefined)).toBeNull();
    expect(defaultEnvironmentIdFromMetadata({})).toBeNull();
    expect(defaultEnvironmentIdFromMetadata({ [DEFAULT_ENV_METADATA_KEY]: "" })).toBeNull();
    expect(defaultEnvironmentIdFromMetadata({ [DEFAULT_ENV_METADATA_KEY]: "  " })).toBeNull();
    expect(defaultEnvironmentIdFromMetadata({ [DEFAULT_ENV_METADATA_KEY]: 42 })).toBeNull();
  });

  it("trims a string id", () => {
    expect(
      defaultEnvironmentIdFromMetadata({ [DEFAULT_ENV_METADATA_KEY]: "  env_abc  " }),
    ).toBe("env_abc");
  });
});

describe("resolveSessionEnvironmentId", () => {
  it("prefers body over agent default", () => {
    expect(
      resolveSessionEnvironmentId({
        bodyEnvironmentId: "env_body",
        agentMetadata: { [DEFAULT_ENV_METADATA_KEY]: "env_default" },
      }),
    ).toEqual({ environmentId: "env_body", source: "body" });
  });

  it("falls back to agent default when body is absent", () => {
    expect(
      resolveSessionEnvironmentId({
        bodyEnvironmentId: undefined,
        agentMetadata: { [DEFAULT_ENV_METADATA_KEY]: "env_default" },
      }),
    ).toEqual({ environmentId: "env_default", source: "agent_default" });
  });

  it("treats blank body as missing", () => {
    expect(
      resolveSessionEnvironmentId({
        bodyEnvironmentId: "  ",
        agentMetadata: { [DEFAULT_ENV_METADATA_KEY]: "env_default" },
      }),
    ).toEqual({ environmentId: "env_default", source: "agent_default" });
  });

  it("returns none when neither is set", () => {
    expect(resolveSessionEnvironmentId({})).toEqual({
      environmentId: null,
      source: "none",
    });
  });
});

describe("validateDefaultEnvironmentMetadata", () => {
  it("accepts missing key and explicit clear", async () => {
    expect(await validateDefaultEnvironmentMetadata({ tenantId: "t", metadata: {} })).toEqual({
      ok: true,
    });
    expect(
      await validateDefaultEnvironmentMetadata({
        tenantId: "t",
        metadata: { [DEFAULT_ENV_METADATA_KEY]: "" },
      }),
    ).toEqual({ ok: true });
    expect(
      await validateDefaultEnvironmentMetadata({
        tenantId: "t",
        metadata: { [DEFAULT_ENV_METADATA_KEY]: null },
      }),
    ).toEqual({ ok: true });
  });

  it("rejects non-string values", async () => {
    const r = await validateDefaultEnvironmentMetadata({
      tenantId: "t",
      metadata: { [DEFAULT_ENV_METADATA_KEY]: 99 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(422);
  });

  it("rejects missing and archived environments when a getter is provided", async () => {
    const missing = await validateDefaultEnvironmentMetadata({
      tenantId: "t",
      metadata: { [DEFAULT_ENV_METADATA_KEY]: "env_gone" },
      getEnvironment: async () => null,
    });
    expect(missing.ok).toBe(false);

    const archived = await validateDefaultEnvironmentMetadata({
      tenantId: "t",
      metadata: { [DEFAULT_ENV_METADATA_KEY]: "env_old" },
      getEnvironment: async () => ({ id: "env_old", archived_at: "2026-01-01T00:00:00Z" }),
    });
    expect(archived.ok).toBe(false);

    const ok = await validateDefaultEnvironmentMetadata({
      tenantId: "t",
      metadata: { [DEFAULT_ENV_METADATA_KEY]: "env_ok" },
      getEnvironment: async () => ({ id: "env_ok", archived_at: null }),
    });
    expect(ok).toEqual({ ok: true });
  });
});

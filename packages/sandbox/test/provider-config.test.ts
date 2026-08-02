// Unit tests for classifyCfSandboxProvider — the pure classification the
// Cloudflare deployment uses to decide whether a `sandbox_provider` (or
// legacy `config.type`) resolves to CloudflareSandbox, a remote HTTP
// adapter, or fails clearly because it's Node-only. See
// apps/agent/src/runtime/sandbox.ts's `resolveCfSandbox` for the caller.

import { describe, it, expect, vi } from "vitest";
import {
  classifyCfSandboxProvider,
  SYSTEM_PROVIDERS,
  parseOpenShellMode,
  resolveDefaultLocalSandboxProvider,
  seedSystemProviders,
} from "../src/provider-config";

describe("classifyCfSandboxProvider", () => {
  it("defaults to cloudflare when providerId is absent", () => {
    expect(classifyCfSandboxProvider(undefined)).toEqual({ kind: "cloudflare" });
    expect(classifyCfSandboxProvider(null)).toEqual({ kind: "cloudflare" });
    expect(classifyCfSandboxProvider("")).toEqual({ kind: "cloudflare" });
  });

  it('defaults to cloudflare for "cloud"', () => {
    expect(classifyCfSandboxProvider("cloud")).toEqual({ kind: "cloudflare" });
    // case-insensitive, matches main-node's resolveEnvProvider .toLowerCase()
    expect(classifyCfSandboxProvider("Cloud")).toEqual({ kind: "cloudflare" });
  });

  it("falls back to cloudflare for an unrecognized provider id", () => {
    expect(classifyCfSandboxProvider("totally-unknown-provider")).toEqual({ kind: "cloudflare" });
  });

  it.each(["boxrun", "daytona", "e2b", "k8s-remote", "openshell"])(
    "classifies remote HTTP-API adapter %s as remote",
    (type) => {
      expect(classifyCfSandboxProvider(type)).toEqual({ kind: "remote", type });
      // case-insensitive
      expect(classifyCfSandboxProvider(type.toUpperCase())).toEqual({ kind: "remote", type });
    },
  );

  it.each(["litebox", "k8s", "docker-compose"])(
    "classifies Node-only adapter %s as unavailable",
    (type) => {
      expect(classifyCfSandboxProvider(type)).toEqual({ kind: "unavailable", type });
    },
  );

  it.each(["subprocess", "local", "SUBPROCESS", " Local "])(
    "classifies local/subprocess provider %s as bridge-relayed",
    (id) => {
      expect(classifyCfSandboxProvider(id)).toEqual({ kind: "bridge", type: "subprocess" });
    },
  );

  it.each(["browser-vm", "BROWSER-VM", " browser-vm "])(
    "classifies browser-vm provider %s as bridge-relayed",
    (id) => {
      expect(classifyCfSandboxProvider(id)).toEqual({ kind: "bridge", type: "browser-vm" });
    },
  );

  it("trims whitespace before classifying", () => {
    expect(classifyCfSandboxProvider("  boxrun  ")).toEqual({ kind: "remote", type: "boxrun" });
  });

  it("SYSTEM_PROVIDERS.cfCompatible matches the documented remote-vs-node-only split", () => {
    const byType = Object.fromEntries(SYSTEM_PROVIDERS.map((p) => [p.type, p.cfCompatible]));
    expect(byType).toEqual({
      subprocess: false,
      litebox: false,
      boxrun: true,
      daytona: true,
      e2b: true,
      k8s: false,
      "k8s-remote": true,
      "k8s-bridge": true,
      cloud: true,
      "docker-compose": false,
      "github-actions": true,
      "remote-agent": true,
      openshell: true,
      "browser-vm": true,
    });
  });

  it("classifies openshell as remote (reachable on CF via the k8s-bridge OpenShell backend)", () => {
    expect(classifyCfSandboxProvider("openshell")).toEqual({ kind: "remote", type: "openshell" });
    // case-insensitive
    expect(classifyCfSandboxProvider("OpenShell")).toEqual({ kind: "remote", type: "openshell" });
  });
});

describe("parseOpenShellMode", () => {
  it("defaults to auto for unset/unrecognized values", () => {
    expect(parseOpenShellMode(undefined)).toBe("auto");
    expect(parseOpenShellMode("")).toBe("auto");
    expect(parseOpenShellMode("bogus")).toBe("auto");
  });

  it("recognizes openshell and subprocess, case-insensitively and trimmed", () => {
    expect(parseOpenShellMode("openshell")).toBe("openshell");
    expect(parseOpenShellMode("OpenShell")).toBe("openshell");
    expect(parseOpenShellMode("  subprocess  ")).toBe("subprocess");
  });
});

describe("resolveDefaultLocalSandboxProvider", () => {
  it("picks openshell when the gateway is configured and probe reports reachable", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const result = await resolveDefaultLocalSandboxProvider(
      { OPENSHELL_GATEWAY_ENDPOINT: "127.0.0.1:8080" },
      probe,
    );
    expect(result.providerId).toBe("openshell");
    expect(probe).toHaveBeenCalledWith("127.0.0.1:8080");
  });

  it("falls back to subprocess when the probe reports unreachable", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const result = await resolveDefaultLocalSandboxProvider(
      { OPENSHELL_GATEWAY_ENDPOINT: "127.0.0.1:8080" },
      probe,
    );
    expect(result.providerId).toBe("subprocess");
    expect(result.reason).toMatch(/unreachable/);
  });

  it("falls back to subprocess without probing when no gateway endpoint is configured", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const result = await resolveDefaultLocalSandboxProvider({}, probe);
    expect(result.providerId).toBe("subprocess");
    expect(probe).not.toHaveBeenCalled();
  });

  it("falls back to subprocess when the probe throws", async () => {
    const probe = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await resolveDefaultLocalSandboxProvider(
      { OPENSHELL_GATEWAY_ENDPOINT: "127.0.0.1:8080" },
      probe,
    );
    expect(result.providerId).toBe("subprocess");
    expect(result.reason).toMatch(/ECONNREFUSED/);
  });

  it("OPENSHELL_MODE=openshell forces openshell without probing", async () => {
    const probe = vi.fn().mockResolvedValue(false);
    const result = await resolveDefaultLocalSandboxProvider(
      { OPENSHELL_MODE: "openshell", OPENSHELL_GATEWAY_ENDPOINT: "127.0.0.1:8080" },
      probe,
    );
    expect(result.providerId).toBe("openshell");
    expect(probe).not.toHaveBeenCalled();
  });

  it("OPENSHELL_MODE=openshell falls back to subprocess if no endpoint is configured to force", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const result = await resolveDefaultLocalSandboxProvider(
      { OPENSHELL_MODE: "openshell" },
      probe,
    );
    expect(result.providerId).toBe("subprocess");
    expect(probe).not.toHaveBeenCalled();
  });

  it("OPENSHELL_MODE=subprocess forces subprocess without probing, even when reachable", async () => {
    const probe = vi.fn().mockResolvedValue(true);
    const result = await resolveDefaultLocalSandboxProvider(
      { OPENSHELL_MODE: "subprocess", OPENSHELL_GATEWAY_ENDPOINT: "127.0.0.1:8080" },
      probe,
    );
    expect(result.providerId).toBe("subprocess");
    expect(probe).not.toHaveBeenCalled();
  });
});

describe("seedSystemProviders", () => {
  it("always seeds browser-vm (no env key required, like subprocess)", () => {
    const seeded = seedSystemProviders({});
    const types = seeded.map((p) => p.type);
    expect(types).toContain("browser-vm");
    expect(types).toContain("subprocess");
    expect(types).toContain("cloud");
    const bv = seeded.find((p) => p.type === "browser-vm");
    expect(bv?.isSystem).toBe(true);
  });
});

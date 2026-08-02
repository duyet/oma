// Backend selection for the daemon's relayed sandbox ops. Mirrors
// apps/k8s-bridge/test/backend-select.test.ts, minus the auto-detect rule —
// the divergence is deliberate (see sandbox-backend.ts).

import { describe, it, expect } from "vitest";
import { resolveSandboxBackend } from "./sandbox-backend.js";

describe("resolveSandboxBackend", () => {
  it("defaults to subprocess with nothing configured", () => {
    const sel = resolveSandboxBackend({});
    expect(sel.kind).toBe("subprocess");
  });

  it("does NOT auto-detect openshell from a gateway endpoint alone", () => {
    const sel = resolveSandboxBackend({ OPENSHELL_GATEWAY_ENDPOINT: "127.0.0.1:8080" });
    expect(sel.kind).toBe("subprocess");
  });

  it("honours BRIDGE_SANDBOX_BACKEND=openshell and carries the endpoint", () => {
    const sel = resolveSandboxBackend({
      BRIDGE_SANDBOX_BACKEND: "openshell",
      OPENSHELL_GATEWAY_ENDPOINT: "gateway:50051",
    });
    expect(sel.kind).toBe("openshell");
    expect(sel.endpoint).toBe("gateway:50051");
    expect(sel.reason).toContain("explicit");
  });

  it("falls back to the default endpoint when none is configured", () => {
    const sel = resolveSandboxBackend({ BRIDGE_SANDBOX_BACKEND: "openshell" });
    expect(sel.endpoint).toBe("127.0.0.1:8080");
  });

  it("daemon settings win over the env var", () => {
    const sel = resolveSandboxBackend(
      { BRIDGE_SANDBOX_BACKEND: "openshell" },
      { sandboxBackend: "subprocess" },
    );
    expect(sel.kind).toBe("subprocess");
    expect(sel.reason).toContain("daemon config");
  });

  it("daemon settings can select openshell with its own endpoint", () => {
    const sel = resolveSandboxBackend({}, {
      sandboxBackend: "openshell",
      openshellEndpoint: "10.0.0.5:8080",
    });
    expect(sel.kind).toBe("openshell");
    expect(sel.endpoint).toBe("10.0.0.5:8080");
  });

  it("treats an unrecognized BRIDGE_SANDBOX_BACKEND as the default", () => {
    const sel = resolveSandboxBackend({ BRIDGE_SANDBOX_BACKEND: "banana" });
    expect(sel.kind).toBe("subprocess");
  });
});

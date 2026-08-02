// Unit tests for resolveCfSandbox / createSandbox — the Cloudflare-side
// sandbox provider resolution seam. Covers: default CloudflareSandbox
// behavior (absent / "cloud" / unknown provider id), the boxrun and
// k8s-remote remote adapters (success + missing-config error), and the
// clear-failure path for providers this deployment can't serve (Node-only,
// and daytona/e2b which are cf-compatible in principle but not bundled here
// yet).

import { describe, it, expect, vi } from "vitest";
import type { Env } from "@duyet/oma-shared";
import { BoxRunSandbox } from "@duyet/oma-sandbox/adapters/boxrun";
import { KubernetesRemoteSandbox } from "@duyet/oma-sandbox/adapters/kubernetes-remote";
import { K8sBridgeSandbox } from "@duyet/oma-sandbox/adapters/k8s-bridge";
import { DynamicWorkerSandbox } from "@duyet/oma-sandbox/adapters/dynamic-workers";
import type { WorkerLoader } from "@duyet/oma-shared";
import {
  CloudflareSandbox,
  createSandbox,
  resolveCfSandbox,
  SandboxProviderUnavailableError,
} from "./sandbox";
import { BridgeRelaySandbox } from "./bridge-relay";
import { BrowserVmRelaySandbox } from "./browser-vm-relay";

// @cloudflare/sandbox is aliased to test/sandbox-stub.ts in vitest.config.ts
// — getSandbox() there ignores its arguments, so any object satisfies the
// `SANDBOX` binding CloudflareSandbox's constructor reads.
const baseEnv = { SANDBOX: {} } as unknown as Env;

describe("resolveCfSandbox", () => {
  it("defaults to CloudflareSandbox when envConfig is absent", () => {
    const sandbox = resolveCfSandbox(baseEnv, "sess_1", undefined);
    expect(sandbox).toBeInstanceOf(CloudflareSandbox);
  });

  it('defaults to CloudflareSandbox for config.type === "cloud"', () => {
    const sandbox = resolveCfSandbox(baseEnv, "sess_1", { type: "cloud" });
    expect(sandbox).toBeInstanceOf(CloudflareSandbox);
  });

  it("defaults to CloudflareSandbox for an unrecognized sandbox_provider", () => {
    const sandbox = resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: "made-up" });
    expect(sandbox).toBeInstanceOf(CloudflareSandbox);
  });

  it("resolves boxrun to a real BoxRunSandbox when BOXRUN_URL is set", () => {
    const env = { ...baseEnv, BOXRUN_URL: "http://boxrun:8100/v1/default" } as unknown as Env;
    const sandbox = resolveCfSandbox(env, "sess_1", { sandbox_provider: "boxrun" });
    expect(sandbox).toBeInstanceOf(BoxRunSandbox);
  });

  it("honors legacy config.type when sandbox_provider is absent", () => {
    const env = { ...baseEnv, BOXRUN_URL: "http://boxrun:8100/v1/default" } as unknown as Env;
    const sandbox = resolveCfSandbox(env, "sess_1", { type: "boxrun" });
    expect(sandbox).toBeInstanceOf(BoxRunSandbox);
  });

  it("sandbox_provider takes priority over legacy config.type", () => {
    const env = { ...baseEnv, BOXRUN_URL: "http://boxrun:8100/v1/default" } as unknown as Env;
    const sandbox = resolveCfSandbox(env, "sess_1", {
      sandbox_provider: "boxrun",
      type: "cloud",
    });
    expect(sandbox).toBeInstanceOf(BoxRunSandbox);
  });

  it("throws SandboxProviderUnavailableError for boxrun without BOXRUN_URL configured", () => {
    expect(() => resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: "boxrun" })).toThrow(
      SandboxProviderUnavailableError,
    );
  });

  it("resolves k8s-remote to a real KubernetesRemoteSandbox when K8S_SANDBOX_GATEWAY_URL is set", () => {
    const env = {
      ...baseEnv,
      K8S_SANDBOX_GATEWAY_URL: "https://k8s-gateway.oma.internal/v1/default",
    } as unknown as Env;
    const sandbox = resolveCfSandbox(env, "sess_1", { sandbox_provider: "k8s-remote" });
    expect(sandbox).toBeInstanceOf(KubernetesRemoteSandbox);
  });

  it("throws SandboxProviderUnavailableError for k8s-remote without K8S_SANDBOX_GATEWAY_URL configured", () => {
    expect(() =>
      resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: "k8s-remote" }),
    ).toThrow(SandboxProviderUnavailableError);
  });

  it("resolves openshell to a K8sBridgeSandbox pointed at OPENSHELL_BRIDGE_URL", () => {
    const env = {
      ...baseEnv,
      OPENSHELL_BRIDGE_URL: "https://openshell-bridge.oma.internal",
    } as unknown as Env;
    const sandbox = resolveCfSandbox(env, "sess_1", { sandbox_provider: "openshell" });
    expect(sandbox).toBeInstanceOf(K8sBridgeSandbox);
  });

  it("throws SandboxProviderUnavailableError for openshell without OPENSHELL_BRIDGE_URL configured", () => {
    expect(() =>
      resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: "openshell" }),
    ).toThrow(SandboxProviderUnavailableError);
  });

  it.each(["litebox", "k8s", "docker-compose"])(
    "throws SandboxProviderUnavailableError for the Node-only provider %s",
    (type) => {
      expect(() => resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: type })).toThrow(
        SandboxProviderUnavailableError,
      );
    },
  );

  it.each(["daytona", "e2b"])(
    "throws SandboxProviderUnavailableError for %s (cf-compatible but not bundled here yet)",
    (type) => {
      expect(() => resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: type })).toThrow(
        SandboxProviderUnavailableError,
      );
    },
  );

  it("error message names the deployment and the offending provider", () => {
    try {
      resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: "litebox" });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SandboxProviderUnavailableError);
      expect((err as Error).message).toContain("litebox");
      expect((err as Error).message).toContain("Cloudflare deployment");
    }
  });

  it("resolves dynamic-workers to a DynamicWorkerSandbox when the LOADER binding is present", () => {
    const loader = { get: () => ({ getEntrypoint: () => ({ fetch: async () => new Response() }) }) } as unknown as WorkerLoader;
    const env = { ...baseEnv, LOADER: loader } as unknown as Env;
    const sandbox = resolveCfSandbox(env, "sess_1", { sandbox_provider: "dynamic-workers" });
    expect(sandbox).toBeInstanceOf(DynamicWorkerSandbox);
  });

  it("throws SandboxProviderUnavailableError for dynamic-workers without the LOADER binding", () => {
    expect(() =>
      resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: "dynamic-workers" }),
    ).toThrow(SandboxProviderUnavailableError);
  });

  it.each(["subprocess", "local"])(
    "resolves the local provider %s to a BridgeRelaySandbox (relayed, not a hard failure)",
    (id) => {
      const sandbox = resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: id }, "tenant_1");
      expect(sandbox).toBeInstanceOf(BridgeRelaySandbox);
    },
  );

  it("resolves the browser-vm provider to a BrowserVmRelaySandbox (relayed to a browser tab)", () => {
    const sandbox = resolveCfSandbox(baseEnv, "sess_1", { sandbox_provider: "browser-vm" }, "tenant_1");
    expect(sandbox).toBeInstanceOf(BrowserVmRelaySandbox);
    expect(sandbox).not.toBeInstanceOf(BridgeRelaySandbox);
  });
});

describe("createSandbox", () => {
  it("delegates to resolveCfSandbox with the given envConfig", () => {
    const env = {
      ...baseEnv,
      K8S_SANDBOX_GATEWAY_URL: "https://k8s-gateway.oma.internal/v1/default",
    } as unknown as Env;
    const sandbox = createSandbox(env, "sess_1", { sandbox_provider: "k8s-remote" });
    expect(sandbox).toBeInstanceOf(KubernetesRemoteSandbox);
  });

  it("defaults to CloudflareSandbox when envConfig is omitted (back-compat call shape)", () => {
    const sandbox = createSandbox(baseEnv, "sess_1");
    expect(sandbox).toBeInstanceOf(CloudflareSandbox);
  });
});

describe("CloudflareSandbox.destroy", () => {
  // Regression: the @cloudflare/sandbox SDK's destroy() can hang forever when
  // the Containers control plane is unresponsive. Before the bounded-timeout
  // fix, that hang propagated straight through SessionDO's /pause and /destroy
  // handlers, so the caller's HTTP request never returned and the sandbox
  // appeared impossible to stop. destroy() must resolve within the timeout and
  // still rebuild the stub even when the underlying teardown never settles.
  it("resolves within the timeout when the underlying destroy() hangs", async () => {
    vi.useFakeTimers();
    try {
      const sandbox = new CloudflareSandbox(baseEnv, "sess_hang");
      const hangingDestroy = vi.fn(() => new Promise<void>(() => {}));
      (sandbox as unknown as { sandboxPromise: Promise<unknown> }).sandboxPromise =
        Promise.resolve({ destroy: hangingDestroy });

      const destroyPromise = sandbox.destroy();
      // Let the awaited getSandbox() microtask settle before advancing timers.
      await vi.advanceTimersByTimeAsync(30000);
      await expect(destroyPromise).resolves.toBeUndefined();
      expect(hangingDestroy).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  // The bounded wait is only half the fix: if destroy() times out but leaves
  // the cached stub in place, the next getSandbox() hands the caller an RPC
  // handle pointing at the container we just tore down — the stale-stub reuse
  // that preceded the observed 53-min wedge. Assert the cache is actually
  // rebuilt, not merely that destroy() returned.
  it("invalidates the cached stub after the underlying destroy() times out", async () => {
    vi.useFakeTimers();
    try {
      const sandbox = new CloudflareSandbox(baseEnv, "sess_hang_cache");
      const hangingStub = { destroy: vi.fn(() => new Promise<void>(() => {})) };
      const internals = sandbox as unknown as {
        sandboxPromise: Promise<unknown>;
        mounted: boolean;
      };
      internals.sandboxPromise = Promise.resolve(hangingStub);
      internals.mounted = true;

      const destroyPromise = sandbox.destroy();
      await vi.advanceTimersByTimeAsync(30000);
      await destroyPromise;

      await expect(internals.sandboxPromise).resolves.not.toBe(hangingStub);
      expect(internals.mounted).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  // A non-Error rejection must not throw while being formatted for the log —
  // that would escape the catch and skip the stale-stub invalidation above,
  // reintroducing the wedge through a different door.
  it.each([null, undefined, "plain string"])(
    "still invalidates the cached stub when destroy() rejects with %s",
    async (rejection) => {
      const sandbox = new CloudflareSandbox(baseEnv, "sess_reject");
      const rejectingStub = {
        destroy: vi.fn(() => Promise.reject(rejection)),
      };
      const internals = sandbox as unknown as {
        sandboxPromise: Promise<unknown>;
        mounted: boolean;
      };
      internals.sandboxPromise = Promise.resolve(rejectingStub);
      internals.mounted = true;

      await expect(sandbox.destroy()).resolves.toBeUndefined();
      await expect(internals.sandboxPromise).resolves.not.toBe(rejectingStub);
      expect(internals.mounted).toBe(false);
    },
  );

  it("awaits a fast destroy() without waiting for the timeout", async () => {
    const sandbox = new CloudflareSandbox(baseEnv, "sess_fast");
    const fastDestroy = vi.fn(async () => {});
    (sandbox as unknown as { sandboxPromise: Promise<unknown> }).sandboxPromise =
      Promise.resolve({ destroy: fastDestroy });

    await expect(sandbox.destroy()).resolves.toBeUndefined();
    expect(fastDestroy).toHaveBeenCalledOnce();
  });
});

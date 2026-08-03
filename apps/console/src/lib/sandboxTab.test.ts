import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  ensureSandboxTabForEnvironment,
  isNoSandboxTabError,
  resetSandboxTabDedupe,
} from "./sandboxTab";

const nowSec = () => Math.floor(Date.now() / 1000);

function apiStub(handlers: Record<string, unknown>) {
  return vi.fn(async (path: string) => {
    const key = Object.keys(handlers).find((k) => path.startsWith(k));
    if (!key) throw new Error(`unexpected path ${path}`);
    return handlers[key];
  }) as unknown as <T>(path: string, init?: RequestInit) => Promise<T>;
}

describe("sandboxTab", () => {
  beforeEach(() => {
    resetSandboxTabDedupe();
    vi.stubGlobal("open", vi.fn(() => ({ closed: false }) as unknown as Window));
  });

  it("detects the relay's no-tab message", () => {
    expect(isNoSandboxTabError("Sandbox warmup failed: no browser sandbox tab connected — …")).toBe(true);
    expect(isNoSandboxTabError("some other error")).toBe(false);
    expect(isNoSandboxTabError(undefined)).toBe(false);
  });

  it("opens a tab for a browser-vm environment with no runtime online", async () => {
    const api = apiStub({
      "/v1/environments/": { config: { sandbox_provider: "browser-vm" } },
      "/v1/runtimes": { runtimes: [] },
      "/v1/runtimes/connect-runtime": { code: "abc", expires_at: 0 },
    });
    await ensureSandboxTabForEnvironment(api, "env_1");
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it("does not open a tab when one is already online", async () => {
    const api = apiStub({
      "/v1/environments/": { config: { sandbox_provider: "browser-vm" } },
      "/v1/runtimes": {
        runtimes: [{ kind: "browser-vm", status: "online", last_heartbeat: nowSec() }],
      },
    });
    await ensureSandboxTabForEnvironment(api, "env_1");
    expect(window.open).not.toHaveBeenCalled();
  });

  it("ignores a stale browser-vm heartbeat", async () => {
    const api = apiStub({
      "/v1/environments/": { config: { sandbox_provider: "browser-vm" } },
      "/v1/runtimes": {
        runtimes: [{ kind: "browser-vm", status: "online", last_heartbeat: nowSec() - 600 }],
      },
      "/v1/runtimes/connect-runtime": { code: "abc", expires_at: 0 },
    });
    await ensureSandboxTabForEnvironment(api, "env_1");
    expect(window.open).toHaveBeenCalledTimes(1);
  });

  it("does nothing for a non-browser-vm environment", async () => {
    const api = apiStub({ "/v1/environments/": { config: { type: "cloud" } } });
    await ensureSandboxTabForEnvironment(api, "env_1");
    expect(window.open).not.toHaveBeenCalled();
  });

  it("does not stack tabs while a freshly opened one is still pairing", async () => {
    const api = apiStub({
      "/v1/environments/": { config: { sandbox_provider: "browser-vm" } },
      "/v1/runtimes": { runtimes: [] },
      "/v1/runtimes/connect-runtime": { code: "abc", expires_at: 0 },
    });
    await ensureSandboxTabForEnvironment(api, "env_1");
    await ensureSandboxTabForEnvironment(api, "env_1");
    expect(window.open).toHaveBeenCalledTimes(1);
  });
});

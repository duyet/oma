import { beforeEach, describe, expect, it, vi } from "vitest";
import { OpenShellManager } from "../src/openshell-manager";
import { createRouter } from "../src/router";

// Mock the OpenShell gRPC adapter so these tests never touch a real gateway.
// The manager dynamically imports "@getoma/sandbox-sdk/adapters/openshell";
// vi.mock intercepts that specifier.
const execMock = vi.fn(async (cmd: string) => `exit=0\n${cmd}`);
const destroyMock = vi.fn(async () => {});
const setEnvMock = vi.fn(async () => {});
const ctorCalls: unknown[] = [];

vi.mock("@getoma/sandbox-sdk/adapters/openshell", () => ({
  OpenShellSandbox: class {
    constructor(opts: unknown) {
      ctorCalls.push(opts);
    }
    exec = execMock;
    readFile = vi.fn(async (p: string) => `file:${p}`);
    writeFile = vi.fn(async (p: string) => p);
    setEnvVars = setEnvMock;
    destroy = destroyMock;
  },
  resolveOpenShellTlsFromEnv: () => undefined,
}));

const ENV = {
  OPENSHELL_GATEWAY_ENDPOINT: "127.0.0.1:8080",
  OPENSHELL_TOKEN: "tok",
  OPENSHELL_IMAGE: "ghcr.io/example/image:latest",
} as unknown as NodeJS.ProcessEnv;

beforeEach(() => {
  ctorCalls.length = 0;
  execMock.mockClear();
  destroyMock.mockClear();
  setEnvMock.mockClear();
});

describe("OpenShellManager box lifecycle", () => {
  it("creates a box backed by an OpenShellSandbox constructed from env", async () => {
    const mgr = new OpenShellManager(ENV);
    const boxId = await mgr.createBox("sess-123");

    expect(boxId).toBe("box-sess-123");
    expect(mgr.activeCount()).toBe(1);
    expect(mgr.getBox(boxId)).toBeDefined();
    expect(ctorCalls).toHaveLength(1);
    expect(ctorCalls[0]).toMatchObject({
      endpoint: "127.0.0.1:8080",
      token: "tok",
      image: "ghcr.io/example/image:latest",
      sessionId: "sess-123",
    });
  });

  it("lets a per-box image override the env default", async () => {
    const mgr = new OpenShellManager(ENV);
    await mgr.createBox("sess-x", { image: "custom:tag" });
    expect(ctorCalls[0]).toMatchObject({ image: "custom:tag" });
  });

  it("forwards the mapped OpenShell policy to the sandbox constructor", async () => {
    const mgr = new OpenShellManager(ENV);
    const policy = {
      version: 1,
      filesystem: { include_workdir: true },
      network_policies: { oma: { name: "oma", endpoints: [{ host: "api.github.com" }] } },
    };
    await mgr.createBox("sess-p", { policy });
    expect(ctorCalls[0]).toMatchObject({ policy });
  });

  it("destroys the executor and drops the box", async () => {
    const mgr = new OpenShellManager(ENV);
    const boxId = await mgr.createBox("sess-9");
    await mgr.destroyBox(boxId);
    expect(destroyMock).toHaveBeenCalledOnce();
    expect(mgr.getBox(boxId)).toBeUndefined();
    expect(mgr.activeCount()).toBe(0);
  });

  it("fails loudly when the gateway endpoint is unset", async () => {
    const mgr = new OpenShellManager({} as NodeJS.ProcessEnv);
    await expect(mgr.createBox("sess-1")).rejects.toThrow(/OPENSHELL_GATEWAY_ENDPOINT/);
  });

  it("returns degraded cluster values (owns no cluster)", async () => {
    const mgr = new OpenShellManager(ENV);
    expect(await mgr.getK8sVersion()).toBe("openshell");
    expect(await mgr.getNodeCount()).toBe(0);
    expect(await mgr.getNodes()).toEqual([]);
    expect(await mgr.discoverSandboxes()).toEqual([]);
    expect(await mgr.getPodMetrics()).toEqual([]);
    expect(await mgr.getSandboxDetail("anything")).toBeNull();
  });

  it("reports capacity as unavailable with a reason instead of zeros that read as real", async () => {
    const mgr = new OpenShellManager(ENV);
    const capacity = await mgr.getClusterCapacity();

    expect(capacity.available).toBe(false);
    expect(capacity.reason).toMatch(/openshell/i);
    // No fabricated phase breakdown — the gateway exposes no pod phases.
    expect(capacity.sandboxPods).toBeNull();
  });

  it("serves the capacity endpoint over the router without crashing on the openshell backend", async () => {
    const mgr = new OpenShellManager(ENV);
    const router = createRouter(mgr);

    const res = await router.request("/api/v1/cluster/capacity");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { available: boolean; reason?: string };
    expect(body.available).toBe(false);
    expect(body.reason).toBeTruthy();
  });
});

describe("OpenShellManager behind the HTTP router", () => {
  it("execs a command through the boxrun-shaped API", async () => {
    const mgr = new OpenShellManager(ENV);
    const router = createRouter(mgr);

    const created = await router.request("/api/v1/boxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: "sess-router" }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const res = await router.request(`/api/v1/boxes/${id}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command: "echo hi" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stdout: string };
    expect(body.stdout).toContain("echo hi");
    expect(execMock).toHaveBeenCalled();
  });
});

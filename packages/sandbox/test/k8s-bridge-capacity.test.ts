// Verifies the K8sBridgeSandbox capacity client against the payload the
// bridge actually serves (apps/k8s-bridge/src/k8s-manager.ts ClusterCapacity).
// The mapping matters because a wrong shape degrades silently to null — the
// caller can't tell "no capacity data" from "adapter parsed the wrong keys".

import { describe, it, expect, vi, beforeEach } from "vitest";
import { K8sBridgeSandbox } from "../src/adapters/k8s-bridge";
import type { BridgeClusterCapacity } from "../src/adapters/k8s-bridge";

const bridgeCapacity: BridgeClusterCapacity = {
  available: true,
  totalCpu: "4.00",
  totalMemory: "16.00",
  allocatableCpu: "3.80",
  allocatableMemory: "15.00",
  requestedCpu: "1.50",
  requestedMemory: "1.50",
  allocatableCpuMillicores: 3800,
  requestedCpuMillicores: 1500,
  allocatableMemoryMib: 15360,
  requestedMemoryMib: 1536,
  runningPods: 2,
  maxPods: 110,
  estimatedAdditionalSandboxes: 4,
  sandboxPods: {
    total: 3,
    running: 2,
    pending: 1,
    terminating: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
  },
};

function stubFetch(handler: (url: string) => Response): void {
  (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (input: RequestInfo | URL) =>
    handler(typeof input === "string" ? input : input.toString()),
  ) as unknown as typeof fetch;
}

function makeSandbox(): K8sBridgeSandbox {
  return new K8sBridgeSandbox({ baseUrl: "http://bridge/api/v1", bearerToken: "t" });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("K8sBridgeSandbox cluster capacity client", () => {
  it("returns the bridge payload verbatim, lifecycle counts included", async () => {
    stubFetch(() => new Response(JSON.stringify(bridgeCapacity), { status: 200 }));

    const body = await makeSandbox().getClusterCapacity();

    expect(body).toEqual(bridgeCapacity);
    expect(body?.sandboxPods?.pending).toBe(1);
  });

  it("maps the payload onto the provider-agnostic SandboxCapacity port", async () => {
    stubFetch(() => new Response(JSON.stringify(bridgeCapacity), { status: 200 }));

    const capacity = await makeSandbox().getCapacity();

    expect(capacity).toEqual({
      cpu: { used: 1.5, total: 3.8, unit: "cores" },
      memory: { used: 1536, total: 15360, unit: "MiB" },
      pods: { used: 2, total: 110 },
    });
  });

  it("reports unknown (null) rather than zeros when the bridge owns no cluster", async () => {
    // OpenShell backend: every number is zero but `available: false` says so.
    // Mapping those zeros through would tell a scheduler the cluster is full.
    const degraded: BridgeClusterCapacity = {
      ...bridgeCapacity,
      available: false,
      reason: "BRIDGE_BACKEND=openshell — owns no Kubernetes cluster",
      allocatableCpuMillicores: 0,
      requestedCpuMillicores: 0,
      allocatableMemoryMib: 0,
      requestedMemoryMib: 0,
      runningPods: 0,
      maxPods: 0,
      estimatedAdditionalSandboxes: 0,
      sandboxPods: null,
    };
    stubFetch(() => new Response(JSON.stringify(degraded), { status: 200 }));

    const sb = makeSandbox();

    // The raw call still surfaces the honest reason...
    await expect(sb.getClusterCapacity()).resolves.toMatchObject({ available: false });
    // ...while the port view refuses to invent a reading.
    await expect(sb.getCapacity()).resolves.toBeNull();
  });

  it("returns null when an older bridge has no capacity endpoint", async () => {
    stubFetch(() => new Response("not found", { status: 404 }));

    const sb = makeSandbox();
    await expect(sb.getClusterCapacity()).resolves.toBeNull();
    await expect(sb.getCapacity()).resolves.toBeNull();
  });

  it("returns null instead of throwing when the bridge is unreachable", async () => {
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(makeSandbox().getClusterCapacity()).resolves.toBeNull();
  });

  it("fetches cluster info from /cluster/info", async () => {
    stubFetch((url) => {
      expect(url).toBe("http://bridge/api/v1/cluster/info");
      return new Response(
        JSON.stringify({
          k8sVersion: "v1",
          platform: "x64",
          nodeCount: 2,
          totalCpu: "8.00",
          totalMemory: "32.00",
          allocatableCpu: "7.60",
          allocatableMemory: "30.00",
          maxPods: 220,
        }),
        { status: 200 },
      );
    });

    const info = await makeSandbox().getClusterInfo();
    expect(info?.nodeCount).toBe(2);
    expect(info?.maxPods).toBe(220);
  });
});

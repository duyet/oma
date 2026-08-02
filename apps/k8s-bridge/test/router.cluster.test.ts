// Router-level tests for the cluster capacity endpoint, using a stubbed
// K8sManager so no real (or mocked) k8s client is involved.

import { describe, it, expect, vi } from "vitest";
import { createRouter } from "../src/router";
import type { K8sManager, ClusterCapacity } from "../src/k8s-manager";

function makeManager(overrides: Partial<K8sManager> = {}): K8sManager {
  return {
    getClusterCapacity: vi.fn(),
    ...overrides,
  } as unknown as K8sManager;
}

const sampleCapacity: ClusterCapacity = {
  available: true,
  allocatableCpuMillicores: 7600,
  requestedCpuMillicores: 1500,
  allocatableMemoryMib: 15360,
  requestedMemoryMib: 1536,
  sandboxPods: {
    total: 2,
    running: 2,
    pending: 0,
    terminating: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
  },
  totalCpu: "8.00",
  totalMemory: "16.00",
  allocatableCpu: "7.60",
  allocatableMemory: "15.00",
  requestedCpu: "1.50",
  requestedMemory: "1.50",
  runningPods: 2,
  maxPods: 110,
  estimatedAdditionalSandboxes: 4,
};

describe("GET /api/v1/cluster/capacity", () => {
  it("returns the aggregated capacity payload", async () => {
    const manager = makeManager({
      getClusterCapacity: vi.fn().mockResolvedValue(sampleCapacity),
    });
    const router = createRouter(manager);

    const res = await router.request("/api/v1/cluster/capacity");

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual(sampleCapacity);
  });

  it("returns 500 with an error body when the manager throws", async () => {
    const manager = makeManager({
      getClusterCapacity: vi.fn().mockRejectedValue(new Error("k8s api unreachable")),
    });
    const router = createRouter(manager);

    const res = await router.request("/api/v1/cluster/capacity");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: "cluster_capacity_failed", message: "k8s api unreachable" });
  });
});

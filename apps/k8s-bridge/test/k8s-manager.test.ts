// Unit tests for K8sManager cluster info/capacity/nodes endpoints, with
// `@kubernetes/client-node` fully mocked — no real cluster involved.
// Mirrors the mocking style used in packages/sandbox/test/kubernetes.test.ts.
//
// Also covers getSandboxDetail, which stubs the private getCoreApi() helper
// directly rather than relying on the module mock — keeping the fake surface
// small and matching only the calls getSandboxDetail makes.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { K8sManager } from "../src/k8s-manager";

interface FakeNode {
  metadata: { name: string; labels?: Record<string, string> };
  spec?: { taints?: Array<{ key: string; value?: string; effect: string }> };
  status: {
    capacity: Record<string, string>;
    allocatable: Record<string, string>;
    conditions: Array<{ type: string; status: string }>;
    nodeInfo?: { architecture?: string; osImage?: string; kernelVersion?: string };
  };
}

interface FakePod {
  status?: { phase?: string };
  spec?: { containers?: Array<{ resources?: { requests?: { cpu?: string; memory?: string } } }> };
}

const world = {
  nodes: [] as FakeNode[],
  pods: [] as FakePod[],
  apiVersions: ["v1"] as string[],
};

vi.mock("@kubernetes/client-node", () => {
  class KubeConfig {
    loadFromCluster(): void {}
    loadFromDefault(): void {}
    makeApiClient<T>(Ctor: new () => T): T {
      return new Ctor();
    }
  }

  class CoreV1Api {
    async getAPIVersions() {
      return { body: { versions: world.apiVersions } };
    }
    async listNode() {
      return { body: { items: world.nodes } };
    }
    async listPodForAllNamespaces() {
      return { body: { items: world.pods } };
    }
    async listNamespacedPod() {
      return { body: { items: world.pods } };
    }
  }

  class Metrics {
    async getPodMetrics() {
      return { items: [] };
    }
  }

  return { KubeConfig, CoreV1Api, Metrics };
});

function makeNode(overrides: Partial<FakeNode["status"]> = {}, name = "node-1"): FakeNode {
  return {
    metadata: { name, labels: {} },
    spec: { taints: [] },
    status: {
      capacity: { cpu: "4", memory: "16Gi", pods: "110" },
      allocatable: { cpu: "3800m", memory: "15Gi", pods: "110" },
      conditions: [{ type: "Ready", status: "True" }],
      nodeInfo: { architecture: "amd64", osImage: "Linux", kernelVersion: "6.0" },
      ...overrides,
    },
  };
}

describe("K8sManager cluster endpoints", () => {
  beforeEach(() => {
    world.nodes = [];
    world.pods = [];
    world.apiVersions = ["v1"];
    delete process.env.OMA_K8S_CPU;
    delete process.env.OMA_K8S_MEMORY;
    vi.resetModules();
  });

  it("aggregates node capacity + version for getClusterInfo", async () => {
    const { K8sManager } = await import("../src/k8s-manager");
    world.nodes = [makeNode(), makeNode({}, "node-2")];

    const manager = new K8sManager("default");
    const info = await manager.getClusterInfo();

    expect(info.nodeCount).toBe(2);
    expect(info.k8sVersion).toBe("v1");
    expect(info.totalCpu).toBe("8.00"); // 2 nodes * 4 cpu
    expect(info.allocatableCpu).toBe("7.60"); // 2 * 3800m
    expect(info.maxPods).toBe(220);
  });

  it("maps per-node status, capacity, and taints for getNodes", async () => {
    const { K8sManager } = await import("../src/k8s-manager");
    world.nodes = [
      makeNode(),
      makeNode(
        { conditions: [{ type: "Ready", status: "False" }] },
        "node-not-ready",
      ),
    ];
    world.nodes[1].spec = { taints: [{ key: "dedicated", value: "gpu", effect: "NoSchedule" }] };

    const manager = new K8sManager("default");
    const nodes = await manager.getNodes();

    expect(nodes).toHaveLength(2);
    expect(nodes[0].status).toBe("Ready");
    expect(nodes[0].cpuCapacity).toBe("4");
    expect(nodes[1].status).toBe("NotReady");
    expect(nodes[1].taints).toEqual([{ key: "dedicated", value: "gpu", effect: "NoSchedule" }]);
  });

  it("computes allocatable vs requested capacity and sandbox headroom", async () => {
    const { K8sManager } = await import("../src/k8s-manager");
    process.env.OMA_K8S_CPU = "500m";
    process.env.OMA_K8S_MEMORY = "512Mi";

    // One node: 4 CPU / 16Gi capacity, 3800m / 15Gi allocatable, 110 max pods.
    world.nodes = [makeNode()];
    // Two running pods each requesting 500m CPU / 512Mi memory.
    world.pods = [
      { status: { phase: "Running" }, spec: { containers: [{ resources: { requests: { cpu: "500m", memory: "512Mi" } } }] } },
      { status: { phase: "Running" }, spec: { containers: [{ resources: { requests: { cpu: "500m", memory: "512Mi" } } }] } },
      { status: { phase: "Pending" }, spec: { containers: [{ resources: { requests: { cpu: "500m", memory: "512Mi" } } }] } },
    ];

    const manager = new K8sManager("default");
    const capacity = await manager.getClusterCapacity();

    expect(capacity.allocatableCpu).toBe("3.80");
    expect(capacity.allocatableMemory).toBe("15.00");
    expect(capacity.runningPods).toBe(2);
    expect(capacity.maxPods).toBe(110);
    // requested = 3 pods * 500m = 1500m; remaining = 3800m - 1500m = 2300m -> floor(2300/500) = 4
    // memory: requested = 3 * 512Mi = 1536Mi; allocatable 15Gi = 15360Mi; remaining = 13824Mi -> floor(/512) = 27
    // pod slots remaining = 110 - 2 = 108
    // estimate = min(4, 27, 108) = 4
    expect(capacity.estimatedAdditionalSandboxes).toBe(4);
  });

  it("returns zero headroom when the cluster is saturated", async () => {
    const { K8sManager } = await import("../src/k8s-manager");
    world.nodes = [makeNode({ capacity: { cpu: "1", memory: "1Gi", pods: "2" }, allocatable: { cpu: "1", memory: "1Gi", pods: "2" } })];
    world.pods = [
      { status: { phase: "Running" }, spec: { containers: [{ resources: { requests: { cpu: "1", memory: "1Gi" } } }] } },
      { status: { phase: "Running" }, spec: { containers: [] } },
    ];

    const manager = new K8sManager("default");
    const capacity = await manager.getClusterCapacity();

    expect(capacity.estimatedAdditionalSandboxes).toBe(0);
  });

  it("reports a node with no capacity/allocatable data as contributing nothing, not as NaN", async () => {
    // A node that has joined but whose kubelet hasn't reported status yet.
    // The figures must stay numeric and the headroom estimate must be 0 —
    // a NaN or Infinity here would render as unlimited free capacity and
    // let the scheduler over-commit the cluster.
    const { K8sManager } = await import("../src/k8s-manager");
    world.nodes = [{ metadata: { name: "node-unreported" }, status: {} } as unknown as FakeNode];
    world.pods = [];

    const manager = new K8sManager("default");
    const capacity = await manager.getClusterCapacity();

    expect(capacity.available).toBe(true);
    expect(capacity.allocatableCpuMillicores).toBe(0);
    expect(capacity.allocatableMemoryMib).toBe(0);
    expect(capacity.maxPods).toBe(0);
    expect(capacity.estimatedAdditionalSandboxes).toBe(0);
    expect(Number.isFinite(capacity.estimatedAdditionalSandboxes)).toBe(true);
  });

  it("reports all-zero sandbox lifecycle counts on an empty cluster", async () => {
    const { K8sManager } = await import("../src/k8s-manager");
    world.nodes = [makeNode()];
    world.pods = [];

    const manager = new K8sManager("default");
    const capacity = await manager.getClusterCapacity();

    expect(capacity.sandboxPods).toEqual({
      total: 0,
      running: 0,
      pending: 0,
      terminating: 0,
      succeeded: 0,
      failed: 0,
      unknown: 0,
    });
    // With no pods requesting anything, the whole allocatable pool is headroom.
    expect(capacity.requestedCpuMillicores).toBe(0);
  });

  it("breaks sandbox pods down by lifecycle state", async () => {
    const { K8sManager } = await import("../src/k8s-manager");
    world.nodes = [makeNode()];
    world.pods = [
      { status: { phase: "Running" } },
      { status: { phase: "Running" } },
      { status: { phase: "Pending" } },
      // Still phase=Running, but being torn down: must count as terminating
      // only, or a draining cluster looks fully occupied.
      { metadata: { deletionTimestamp: "2026-08-01T00:00:00Z" }, status: { phase: "Running" } },
      { status: { phase: "Failed" } },
    ] as unknown as FakePod[];

    const manager = new K8sManager("default");
    const capacity = await manager.getClusterCapacity();

    expect(capacity.sandboxPods).toEqual({
      total: 5,
      running: 2,
      pending: 1,
      terminating: 1,
      succeeded: 0,
      failed: 1,
      unknown: 0,
    });
  });
});

describe("countSandboxLifecycle", () => {
  it("classifies an unrecognized or missing phase as unknown rather than dropping it", async () => {
    // Total must always equal the pod count so a caller can trust it as the
    // namespace's sandbox pod count regardless of phase vocabulary drift.
    const { countSandboxLifecycle } = await import("../src/k8s-manager");
    const counts = countSandboxLifecycle([{}, { status: {} }, { status: { phase: "Weird" } }]);

    expect(counts.total).toBe(3);
    expect(counts.unknown).toBe(3);
  });
});

// The K8s client is loaded lazily via a private getCoreApi() helper. These
// tests stub that helper directly rather than mocking @kubernetes/client-node,
// keeping the fake surface small and matching only the two calls
// getSandboxDetail makes (readNamespacedPod, plus getPodMetrics's own
// dynamic import which we let fail closed to []).
function withFakeCoreApi(manager: K8sManager, coreApi: Record<string, unknown>): void {
  (manager as unknown as { getCoreApi: () => Promise<unknown> }).getCoreApi = vi.fn(async () => coreApi);
}

describe("K8sManager.getSandboxDetail", () => {
  it("returns full pod detail with null metrics when metrics-server is unavailable", async () => {
    const manager = new K8sManager("test-ns");
    const pod = {
      metadata: {
        name: "box-sess-123",
        namespace: "test-ns",
        labels: { "oma.dev/managed": "true", "oma.dev/session-id": "sess-123" },
        creationTimestamp: new Date(Date.now() - 5000).toISOString(),
      },
      spec: {
        nodeName: "node-a",
        containers: [{ name: "sandbox", resources: { requests: { cpu: "500m", memory: "512Mi" } } }],
      },
      status: {
        phase: "Running",
        containerStatuses: [
          { name: "sandbox", ready: true, restartCount: 2, state: { running: {} } },
        ],
      },
    };

    withFakeCoreApi(manager, {
      readNamespacedPod: vi.fn(async () => ({ body: pod })),
    });

    const detail = await manager.getSandboxDetail("box-sess-123");

    expect(detail).not.toBeNull();
    expect(detail?.podName).toBe("box-sess-123");
    expect(detail?.namespace).toBe("test-ns");
    expect(detail?.nodeName).toBe("node-a");
    expect(detail?.status).toBe("Running");
    expect(detail?.containerStatuses).toEqual([
      { name: "sandbox", ready: true, restartCount: 2, state: "running" },
    ]);
    expect(detail?.cpuRequest).toBe("500m");
    expect(detail?.memoryRequest).toBe("512Mi");
    expect(detail?.durationSeconds).toBeGreaterThanOrEqual(0);
    expect(detail?.metrics).toBeNull();
  });

  it("returns null when the pod doesn't exist", async () => {
    const manager = new K8sManager("test-ns");
    withFakeCoreApi(manager, {
      readNamespacedPod: vi.fn(async () => {
        throw new Error("404 Not Found");
      }),
    });

    const detail = await manager.getSandboxDetail("missing-pod");
    expect(detail).toBeNull();
  });

  it("does not expose raw pod manifest or secret-bearing fields", async () => {
    const manager = new K8sManager("test-ns");
    const pod = {
      metadata: {
        name: "box-sess-456",
        namespace: "test-ns",
        labels: { "oma.dev/managed": "true" },
        creationTimestamp: new Date().toISOString(),
      },
      spec: { nodeName: "node-b", containers: [], serviceAccountName: "leaked-sa" },
      status: { phase: "Running" },
    };

    withFakeCoreApi(manager, {
      readNamespacedPod: vi.fn(async () => ({ body: pod })),
    });

    const detail = await manager.getSandboxDetail("box-sess-456");

    expect(detail).not.toBeNull();
    expect(JSON.stringify(detail)).not.toContain("serviceAccountName");
    expect(JSON.stringify(detail)).not.toContain("leaked-sa");
  });
});

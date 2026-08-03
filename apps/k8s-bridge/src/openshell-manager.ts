// OpenShellManager — bridge backend that fronts NVIDIA OpenShell sandboxes.
//
// The OpenShell gateway's only public API is gRPC (`openshell.v1.OpenShell`),
// which a Cloudflare Worker cannot speak. This manager runs in the Node
// bridge process, reuses the gRPC client from
// `@getoma/sandbox-sdk/adapters/openshell` (`OpenShellSandbox` — TLS/mTLS,
// token, image, exec-over-stream, base64-through-exec file I/O), and exposes
// each sandbox through the same boxrun-shaped HTTP router the Kubernetes
// backend uses. The Worker then reaches it over plain fetch via the
// `openshell` provider (OPENSHELL_BRIDGE_URL).
//
// It reads the same OPENSHELL_* env vars the direct adapter reads, so a
// self-host gRPC deployment and a bridge deployment are configured
// identically. Cluster/discovery/metrics endpoints are Kubernetes-shaped
// and have no OpenShell analogue, so they return degraded values — the
// bridge owns no cluster of its own here.

import type { BoxExecutor, BridgeBackend, CreateBoxOptions } from "./backend";
import type {
  ClusterCapacity,
  ClusterInfo,
  NodeInfo,
  PodMetrics,
  SandboxDetail,
  SandboxPodInfo,
} from "./k8s-manager";

interface ManagedBox {
  executor: BoxExecutor;
  sessionId: string;
  createdAt: Date;
}

export class OpenShellManager implements BridgeBackend {
  private boxes = new Map<string, ManagedBox>();
  private endpoint: string;
  private token?: string;
  private image?: string;
  private tlsEnv: NodeJS.ProcessEnv;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    this.endpoint = env.OPENSHELL_GATEWAY_ENDPOINT ?? "";
    this.token = env.OPENSHELL_TOKEN;
    this.image = env.OPENSHELL_IMAGE;
    this.tlsEnv = env;
  }

  // ── Box lifecycle ────────────────────────────────────────────────

  async createBox(sessionId: string, options?: CreateBoxOptions): Promise<string> {
    if (!this.endpoint) {
      throw new Error(
        "BRIDGE_BACKEND=openshell requires OPENSHELL_GATEWAY_ENDPOINT (e.g. 127.0.0.1:8080)",
      );
    }
    const boxId = "box-" + sessionId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 60);

    // Untyped dynamic import: the sandbox package ships raw .ts via
    // "exports", which this CJS tsc build can't resolve — typing comes from
    // the structural BoxExecutor interface. Mirrors K8sManager.createBox.
    const mod = await import("@getoma/sandbox-sdk/adapters/openshell" as string);
    const executor: BoxExecutor = new mod.OpenShellSandbox({
      endpoint: this.endpoint,
      token: this.token,
      image: options?.image ?? this.image,
      tls: mod.resolveOpenShellTlsFromEnv(this.tlsEnv),
      sessionId,
      // Egress policy mapped on the Worker side from the OMA environment config
      // and forwarded through the bridge. Attached to CreateSandbox's spec.policy.
      policy: options?.policy,
    });

    this.boxes.set(boxId, { executor, sessionId, createdAt: new Date() });
    return boxId;
  }

  getBox(boxId: string): { executor: BoxExecutor; sessionId: string } | undefined {
    const box = this.boxes.get(boxId);
    if (!box) return undefined;
    return { executor: box.executor, sessionId: box.sessionId };
  }

  async destroyBox(boxId: string): Promise<void> {
    const box = this.boxes.get(boxId);
    if (!box) return;
    try {
      await box.executor.destroy();
    } finally {
      this.boxes.delete(boxId);
    }
  }

  activeCount(): number {
    return this.boxes.size;
  }

  // ── Cluster / discovery (degraded — no cluster owned here) ────────

  async getK8sVersion(): Promise<string> {
    return "openshell";
  }

  async getNodeCount(): Promise<number> {
    return 0;
  }

  async getClusterInfo(): Promise<ClusterInfo> {
    return {
      k8sVersion: "openshell",
      platform: process.arch,
      nodeCount: 0,
      totalCpu: "0m",
      totalMemory: "0Mi",
      allocatableCpu: "0m",
      allocatableMemory: "0Mi",
      maxPods: 0,
    };
  }

  async getNodes(): Promise<NodeInfo[]> {
    return [];
  }

  /**
   * No cluster is owned here, so there is nothing truthful to report. The
   * numbers are zeroed but flagged `available: false` with a reason, so a
   * consumer renders "capacity unavailable" instead of "0 cores free" —
   * and `sandboxPods` is null rather than a fabricated phase breakdown
   * (the gateway exposes no pod phases). `runningPods` stays the one thing
   * this backend does know: the boxes it currently holds.
   */
  async getClusterCapacity(): Promise<ClusterCapacity> {
    return {
      available: false,
      reason:
        "BRIDGE_BACKEND=openshell — this bridge fronts an OpenShell gateway and owns no Kubernetes cluster; capacity figures are unavailable",
      allocatableCpuMillicores: 0,
      requestedCpuMillicores: 0,
      allocatableMemoryMib: 0,
      requestedMemoryMib: 0,
      sandboxPods: null,
      totalCpu: "0m",
      totalMemory: "0Mi",
      allocatableCpu: "0m",
      allocatableMemory: "0Mi",
      requestedCpu: "0m",
      requestedMemory: "0Mi",
      runningPods: this.boxes.size,
      maxPods: 0,
      estimatedAdditionalSandboxes: 0,
    };
  }

  async discoverSandboxes(): Promise<SandboxPodInfo[]> {
    return [];
  }

  async getSandboxLogs(_podName: string, _tailLines?: number): Promise<string> {
    return "";
  }

  async getPodMetrics(): Promise<PodMetrics[]> {
    return [];
  }

  async getSandboxDetail(_id: string): Promise<SandboxDetail | null> {
    return null;
  }
}

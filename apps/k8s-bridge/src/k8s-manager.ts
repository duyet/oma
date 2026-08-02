import type { BridgeBackend } from "./backend";

interface KubernetesSandboxOptions {
  sessionId: string;
  namespace?: string;
  image?: string;
  command?: string[];
  runtimeClassName?: string;
  serviceAccountName?: string;
  cpu?: string;
  memory?: string;
  readyTimeoutMs?: number;
  defaultTimeoutMs?: number;
  memoryBucket?: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    bucketName: string;
  };
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

interface KubernetesSandboxExecutorLike {
  exec(command: string, timeout?: number): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  setEnvVars(envVars: Record<string, string>): Promise<void>;
  destroy(): Promise<void>;
}

interface ManagedBox {
  executor: KubernetesSandboxExecutorLike;
  sessionId: string;
  createdAt: Date;
}

// ─── Cluster info types ─────────────────────────────────────────────

export interface NodeInfo {
  name: string;
  status: "Ready" | "NotReady" | "Unknown";
  cpuCapacity: string;
  cpuAllocatable: string;
  memoryCapacity: string;
  memoryAllocatable: string;
  podCapacity: number;
  architecture: string;
  osImage: string;
  kernelVersion: string;
  taints: Array<{ key: string; value?: string; effect: string }>;
  labels: Record<string, string>;
}

export interface ClusterInfo {
  k8sVersion: string;
  platform: string;
  nodeCount: number;
  totalCpu: string;
  totalMemory: string;
  allocatableCpu: string;
  allocatableMemory: string;
  maxPods: number;
}

/** Per-lifecycle-state counts for the sandbox pods in the bridge's namespace. */
export interface SandboxLifecycleCounts {
  total: number;
  running: number;
  pending: number;
  /** Pods with a deletionTimestamp — counted here and NOT in running/pending. */
  terminating: number;
  succeeded: number;
  failed: number;
  unknown: number;
}

export interface ClusterCapacity {
  /** False when the backend owns no Kubernetes cluster (OpenShell). Consumers
   *  must treat every numeric field below as meaningless in that case rather
   *  than rendering zeros as a real reading. */
  available: boolean;
  /** Human-readable explanation, present only when `available` is false. */
  reason?: string;
  totalCpu: string;
  totalMemory: string;
  allocatableCpu: string;
  allocatableMemory: string;
  requestedCpu: string;
  requestedMemory: string;
  /** Numeric companions to the formatted strings above, so a client doesn't
   *  have to re-parse "3.50" / "500m" / "15500Mi" to do arithmetic. */
  allocatableCpuMillicores: number;
  requestedCpuMillicores: number;
  allocatableMemoryMib: number;
  requestedMemoryMib: number;
  runningPods: number;
  maxPods: number;
  estimatedAdditionalSandboxes: number;
  /** Lifecycle breakdown of the sandbox pods in the bridge's own namespace.
   *  `null` when the backend can't observe pods at all (OpenShell). */
  sandboxPods: SandboxLifecycleCounts | null;
}

/** Raw pod fields the lifecycle tally reads. */
interface LifecycleRawPod {
  metadata?: { deletionTimestamp?: string };
  status?: { phase?: string };
}

/** Pure tally of sandbox pod lifecycle states. Exported for unit tests. */
export function countSandboxLifecycle(pods: unknown[]): SandboxLifecycleCounts {
  const counts: SandboxLifecycleCounts = {
    total: 0,
    running: 0,
    pending: 0,
    terminating: 0,
    succeeded: 0,
    failed: 0,
    unknown: 0,
  };

  for (const raw of pods) {
    const pod = raw as LifecycleRawPod;
    counts.total++;
    // A pod being deleted keeps its old phase (usually Running) until the
    // kubelet finishes teardown, so deletionTimestamp wins over phase —
    // otherwise a draining cluster reads as fully occupied.
    if (pod.metadata?.deletionTimestamp) {
      counts.terminating++;
      continue;
    }
    switch (pod.status?.phase) {
      case "Running": counts.running++; break;
      case "Pending": counts.pending++; break;
      case "Succeeded": counts.succeeded++; break;
      case "Failed": counts.failed++; break;
      default: counts.unknown++; break;
    }
  }

  return counts;
}

export interface SandboxPodInfo {
  id: string;
  boxId: string | null;
  sessionId: string | null;
  namespace: string;
  podName: string;
  nodeName: string;
  status: "Pending" | "Running" | "Succeeded" | "Failed" | "Unknown";
  phase: string;
  containerStatuses: Array<{
    name: string;
    ready: boolean;
    restartCount: number;
    state: string;
  }>;
  cpuRequest: string;
  memoryRequest: string;
  createdAt: string;
  durationSeconds: number;
  labels: Record<string, string>;
}

export interface ContainerHealth {
  name: string;
  restartCount: number;
  waitingReason?: string;
  terminatedReason?: string;
  lastTerminatedReason?: string;
  memoryLimit?: string;
}

export interface SandboxHealthSnapshot {
  podName: string;
  sessionId: string | null;
  nodeName: string;
  phase: string;
  createdAt: string;
  pendingSeconds: number;
  containers: ContainerHealth[];
}

export interface CapacityUsage {
  cpuUsedPct: number;
  memUsedPct: number;
}

export interface PodMetrics {
  podName: string;
  namespace: string;
  cpuUsage: string;
  memoryUsage: string;
  timestamp: string;
  containers: Array<{
    name: string;
    cpuUsage: string;
    memoryUsage: string;
  }>;
}

export interface SandboxDetail extends SandboxPodInfo {
  metrics: PodMetrics | null;
}

interface RawPod {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec?: {
    nodeName?: string;
    containers?: Array<{
      name?: string;
      resources?: { requests?: { cpu?: string; memory?: string } };
    }>;
  };
  status?: {
    phase?: string;
    containerStatuses?: Array<{
      name?: string;
      ready?: boolean;
      restartCount?: number;
      state?: Record<string, unknown>;
    }>;
  };
}

// ─── K8s API client types ───────────────────────────────────────────

interface K8sClientModule {
  KubeConfig: new () => {
    loadFromCluster(): void;
    loadFromDefault(): void;
    makeApiClient<T>(ctor: new (...args: never[]) => T): T;
  };
  CoreV1Api: new (...args: never[]) => CoreV1ApiInstance;
}

type CoreV1ApiInstance = {
  getAPIVersions(): Promise<{ body?: { versions?: string[]; serverAddressByClientCIDRs?: unknown[] } } | unknown>;
  listNode(): Promise<{ body?: { items?: unknown[] } } | unknown>;
  listNamespacedPod(namespace: string): Promise<{ body?: { items?: unknown[] } } | unknown>;
  listPodForAllNamespaces(): Promise<{ body?: { items?: unknown[] } } | unknown>;
  readNamespacedPod(name: string, namespace: string): Promise<{ body?: unknown } | unknown>;
  readNamespacedPodLog(name: string, namespace: string): Promise<{ body?: string } | unknown>;
};

// ─── K8sManager ─────────────────────────────────────────────────────

export class K8sManager implements BridgeBackend {
  private boxes = new Map<string, ManagedBox>();
  private clientPromise: Promise<CoreV1ApiInstance> | null = null;
  private namespace: string;

  constructor(namespace?: string) {
    this.namespace = namespace ?? process.env.OMA_K8S_NAMESPACE ?? "default";
  }

  getNamespace(): string {
    return this.namespace;
  }

  // ── Private helpers ──────────────────────────────────────────────

  private async getCoreApi(): Promise<CoreV1ApiInstance> {
    if (!this.clientPromise) this.clientPromise = this.loadCoreApi();
    return this.clientPromise;
  }

  private async loadCoreApi(): Promise<CoreV1ApiInstance> {
    const mod = (await import(/* @vite-ignore */ "@kubernetes/client-node" as string)) as unknown as K8sClientModule;
    const kc = new mod.KubeConfig();
    if (process.env.KUBERNETES_SERVICE_HOST) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
    return kc.makeApiClient(mod.CoreV1Api);
  }

  private async listNodesRaw(): Promise<unknown[]> {
    const coreApi = await this.getCoreApi();
    const res = await coreApi.listNode();
    const body = unwrapBody<{ items?: unknown[] }>(res);
    return body?.items ?? [];
  }

  private parseResourceQuantity(val: string | undefined | null): number {
    if (!val) return 0;
    val = val.trim();
    // Convert K8s CPU/memory quantities to millicores/MiB
    const cpuMatch = val.match(/^(\d+(?:\.\d+)?)(m?)$/);
    if (cpuMatch) {
      return cpuMatch[2] === "m" ? parseFloat(cpuMatch[1]) : parseFloat(cpuMatch[1]) * 1000;
    }
    const memMatch = val.match(/^(\d+)(Ki|Mi|Gi|Ti|k|M|G|T)?$/);
    if (memMatch) {
      const num = parseInt(memMatch[1], 10);
      const unit = memMatch[2] ?? "";
      switch (unit) {
        case "Ki": return Math.round(num / 1024);
        case "Mi": return num;
        case "Gi": return num * 1024;
        case "Ti": return num * 1024 * 1024;
        case "k": return Math.round(num / 1000);
        case "M": return num;
        case "G": return num * 1000;
        case "T": return num * 1000 * 1000;
        default: return num;
      }
    }
    return 0;
  }

  private parsePodCount(val: string | undefined | null): number {
    if (!val) return 0;
    const n = parseInt(val.trim(), 10);
    return Number.isNaN(n) ? 0 : n;
  }

  private formatMillicores(mcpu: number): string {
    if (mcpu >= 1000) return `${(mcpu / 1000).toFixed(2)}`;
    return `${mcpu}m`;
  }

  private formatMemoryMi(mib: number): string {
    if (mib >= 1024) return `${(mib / 1024).toFixed(2)}`;
    return `${Math.round(mib)}Mi`;
  }

  // ── Cluster info ─────────────────────────────────────────────────

  async getK8sVersion(): Promise<string> {
    try {
      const coreApi = await this.getCoreApi();
      const res = await coreApi.getAPIVersions();
      const body = unwrapBody<{ versions?: string[] }>(res);
      return body?.versions?.join(", ") ?? "unknown";
    } catch {
      return "unknown";
    }
  }

  async getNodeCount(): Promise<number> {
    try {
      return (await this.listNodesRaw()).length;
    } catch {
      return 0;
    }
  }

  private aggregateNodeCapacity(nodes: unknown[]): {
    totalCpuMcpu: number;
    totalMemMi: number;
    allocCpuMcpu: number;
    allocMemMi: number;
    maxPods: number;
  } {
    let totalCpuMcpu = 0;
    let totalMemMi = 0;
    let allocCpuMcpu = 0;
    let allocMemMi = 0;
    let maxPods = 0;

    for (const raw of nodes) {
      const node = raw as {
        status?: { capacity?: Record<string, string>; allocatable?: Record<string, string> };
      };
      if (node.status?.capacity) {
        totalCpuMcpu += this.parseResourceQuantity(node.status.capacity.cpu);
        totalMemMi += this.parseResourceQuantity(node.status.capacity.memory);
      }
      if (node.status?.allocatable) {
        allocCpuMcpu += this.parseResourceQuantity(node.status.allocatable.cpu);
        allocMemMi += this.parseResourceQuantity(node.status.allocatable.memory);
      }
      maxPods += this.parsePodCount(
        (node as { status?: { capacity?: Record<string, string> } })?.status?.capacity?.["pods"] ?? "0",
      );
    }

    return { totalCpuMcpu, totalMemMi, allocCpuMcpu, allocMemMi, maxPods };
  }

  async getClusterInfo(): Promise<ClusterInfo> {
    const nodes = await this.listNodesRaw();
    const { totalCpuMcpu, totalMemMi, allocCpuMcpu, allocMemMi, maxPods } = this.aggregateNodeCapacity(nodes);

    const version = await this.getK8sVersion();

    return {
      k8sVersion: version,
      platform: process.arch,
      nodeCount: nodes.length,
      totalCpu: this.formatMillicores(totalCpuMcpu),
      totalMemory: this.formatMemoryMi(totalMemMi),
      allocatableCpu: this.formatMillicores(allocCpuMcpu),
      allocatableMemory: this.formatMemoryMi(allocMemMi),
      maxPods,
    };
  }

  /** Percentage of cluster CPU/memory capacity currently in use (0 when a node has no capacity reported). */
  async getCapacityUsage(): Promise<CapacityUsage> {
    const nodes = await this.listNodesRaw();
    const { totalCpuMcpu, totalMemMi, allocCpuMcpu, allocMemMi } = this.aggregateNodeCapacity(nodes);

    return {
      cpuUsedPct: totalCpuMcpu > 0 ? Math.round(((totalCpuMcpu - allocCpuMcpu) / totalCpuMcpu) * 100) : 0,
      memUsedPct: totalMemMi > 0 ? Math.round(((totalMemMi - allocMemMi) / totalMemMi) * 100) : 0,
    };
  }

  async getNodes(): Promise<NodeInfo[]> {
    const nodes = await this.listNodesRaw();
    return nodes.map((raw) => {
      const node = raw as {
        metadata?: { name?: string; labels?: Record<string, string> };
        spec?: { taints?: Array<{ key: string; value?: string; effect: string }> };
        status?: {
          capacity?: Record<string, string>;
          allocatable?: Record<string, string>;
          conditions?: Array<{ type: string; status: string }>;
          nodeInfo?: { architecture?: string; osImage?: string; kernelVersion?: string };
        };
      };

      const readyCondition = node.status?.conditions?.find((c) => c.type === "Ready");
      const status: "Ready" | "NotReady" | "Unknown" =
        readyCondition?.status === "True" ? "Ready"
        : readyCondition?.status === "False" ? "NotReady"
        : "Unknown";

      return {
        name: node.metadata?.name ?? "unknown",
        status,
        cpuCapacity: node.status?.capacity?.cpu ?? "0",
        cpuAllocatable: node.status?.allocatable?.cpu ?? "0",
        memoryCapacity: node.status?.capacity?.memory ?? "0",
        memoryAllocatable: node.status?.allocatable?.memory ?? "0",
        podCapacity: this.parsePodCount(node.status?.capacity?.["pods"] ?? "0"),
        architecture: node.status?.nodeInfo?.architecture ?? "",
        osImage: node.status?.nodeInfo?.osImage ?? "",
        kernelVersion: node.status?.nodeInfo?.kernelVersion ?? "",
        taints: node.spec?.taints ?? [],
        labels: node.metadata?.labels ?? {},
      };
    });
  }

  async getClusterCapacity(): Promise<ClusterCapacity> {
    const nodes = await this.listNodesRaw();
    // Same aggregation getClusterInfo/getCapacityUsage use — a node missing
    // status.capacity or status.allocatable simply contributes nothing.
    const {
      totalCpuMcpu,
      totalMemMi,
      allocCpuMcpu,
      allocMemMi,
      maxPods,
    } = this.aggregateNodeCapacity(nodes);

    const pods = await this.listAllPodsRaw();
    let requestedCpuMcpu = 0;
    let requestedMemMi = 0;
    let runningPods = 0;

    for (const raw of pods) {
      const pod = raw as {
        status?: { phase?: string };
        spec?: { containers?: Array<{ resources?: { requests?: { cpu?: string; memory?: string } } }> };
      };
      if (pod.status?.phase === "Running") runningPods++;
      for (const container of pod.spec?.containers ?? []) {
        requestedCpuMcpu += this.parseResourceQuantity(container.resources?.requests?.cpu);
        requestedMemMi += this.parseResourceQuantity(container.resources?.requests?.memory);
      }
    }

    const defaultSandboxCpuMcpu = this.parseResourceQuantity(process.env.OMA_K8S_CPU ?? "500m");
    const defaultSandboxMemMi = this.parseResourceQuantity(process.env.OMA_K8S_MEMORY ?? "512Mi");
    const remainingCpuMcpu = Math.max(0, allocCpuMcpu - requestedCpuMcpu);
    const remainingMemMi = Math.max(0, allocMemMi - requestedMemMi);
    const remainingPodSlots = Math.max(0, maxPods - runningPods);
    const estimatedAdditionalSandboxes = Math.max(
      0,
      Math.min(
        defaultSandboxCpuMcpu > 0 ? Math.floor(remainingCpuMcpu / defaultSandboxCpuMcpu) : remainingPodSlots,
        defaultSandboxMemMi > 0 ? Math.floor(remainingMemMi / defaultSandboxMemMi) : remainingPodSlots,
        remainingPodSlots,
      ),
    );

    return {
      available: true,
      totalCpu: this.formatMillicores(totalCpuMcpu),
      totalMemory: this.formatMemoryMi(totalMemMi),
      allocatableCpu: this.formatMillicores(allocCpuMcpu),
      allocatableMemory: this.formatMemoryMi(allocMemMi),
      requestedCpu: this.formatMillicores(requestedCpuMcpu),
      requestedMemory: this.formatMemoryMi(requestedMemMi),
      allocatableCpuMillicores: allocCpuMcpu,
      requestedCpuMillicores: requestedCpuMcpu,
      allocatableMemoryMib: allocMemMi,
      requestedMemoryMib: requestedMemMi,
      runningPods,
      maxPods,
      estimatedAdditionalSandboxes,
      sandboxPods: countSandboxLifecycle(await this.listNamespacedPodsRaw()),
    };
  }

  /** Pods in the bridge's own namespace — the sandbox pods it manages. */
  private async listNamespacedPodsRaw(): Promise<unknown[]> {
    const coreApi = await this.getCoreApi();
    const res = await coreApi.listNamespacedPod(this.namespace);
    const body = unwrapBody<{ items?: unknown[] }>(res);
    return body?.items ?? [];
  }

  private async listAllPodsRaw(): Promise<unknown[]> {
    const coreApi = await this.getCoreApi();
    const res = await coreApi.listPodForAllNamespaces();
    const body = unwrapBody<{ items?: unknown[] }>(res);
    return body?.items ?? [];
  }

  // ── Sandbox discovery ────────────────────────────────────────────

  async discoverSandboxes(): Promise<SandboxPodInfo[]> {
    try {
      const coreApi = await this.getCoreApi();
      const res = await coreApi.listNamespacedPod(this.namespace);
      const body = unwrapBody<{ items?: unknown[] }>(res);
      const pods = body?.items ?? [];

      return pods.map((raw) => this.toSandboxPodInfo(raw as RawPod));
    } catch {
      return [];
    }
  }

  /** Health snapshot for sandbox pods — container waiting/terminated reasons for crash-loop / OOM detection. */
  async getSandboxHealth(): Promise<SandboxHealthSnapshot[]> {
    try {
      const coreApi = await this.getCoreApi();
      const res = await coreApi.listNamespacedPod(this.namespace);
      const body = unwrapBody<{ items?: unknown[] }>(res);
      const pods = body?.items ?? [];

      return pods.map((raw) => {
        const pod = raw as {
          metadata?: { name?: string; labels?: Record<string, string>; creationTimestamp?: string };
          spec?: {
            nodeName?: string;
            containers?: Array<{ name?: string; resources?: { limits?: { memory?: string } } }>;
          };
          status?: {
            phase?: string;
            containerStatuses?: Array<{
              name?: string;
              restartCount?: number;
              state?: { waiting?: { reason?: string }; terminated?: { reason?: string } };
              lastState?: { terminated?: { reason?: string } };
            }>;
          };
        };

        const podName = pod.metadata?.name ?? "unknown";
        const isManaged = pod.metadata?.labels?.["oma.dev/managed"] === "true" ||
                          pod.metadata?.labels?.["app.kubernetes.io/managed-by"] === "oma-k8s-bridge" ||
                          podName.startsWith("box-");
        const boxId = isManaged ? this.findBoxIdByPodName(podName) : null;
        const sessionId = isManaged ? pod.metadata?.labels?.["oma.dev/session-id"] ?? boxId : null;

        const createdAt = pod.metadata?.creationTimestamp ?? new Date().toISOString();
        const pendingSeconds = Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000);

        const memoryLimits = new Map(
          (pod.spec?.containers ?? []).map((c) => [c.name ?? "", c.resources?.limits?.memory]),
        );

        const containers: ContainerHealth[] = (pod.status?.containerStatuses ?? []).map((cs) => ({
          name: cs.name ?? "",
          restartCount: cs.restartCount ?? 0,
          waitingReason: cs.state?.waiting?.reason,
          terminatedReason: cs.state?.terminated?.reason,
          lastTerminatedReason: cs.lastState?.terminated?.reason,
          memoryLimit: memoryLimits.get(cs.name ?? ""),
        }));

        return {
          podName,
          sessionId,
          nodeName: pod.spec?.nodeName ?? "unknown",
          phase: pod.status?.phase ?? "Unknown",
          createdAt,
          pendingSeconds,
          containers,
        };
      });
    } catch {
      return [];
    }
  }

  /**
   * Full-detail view of a single sandbox pod: pod status, container
   * statuses, restart counts, plus its per-pod metrics (if metrics-server
   * is available). Returns null if the pod doesn't exist.
   */
  async getSandboxDetail(id: string): Promise<SandboxDetail | null> {
    try {
      const coreApi = await this.getCoreApi();
      const res = await coreApi.readNamespacedPod(id, this.namespace);
      const body = unwrapBody<unknown>(res);
      if (!body) return null;

      const info = this.toSandboxPodInfo(body as RawPod);
      const allMetrics = await this.getPodMetrics();
      const metrics = allMetrics.find((m) => m.podName === info.podName) ?? null;

      return { ...info, metrics };
    } catch {
      return null;
    }
  }

  private toSandboxPodInfo(pod: RawPod): SandboxPodInfo {
    const podName = pod.metadata?.name ?? "unknown";
    // Box managed by this bridge has ID in label; fall back to discovering from name
    const isManaged = pod.metadata?.labels?.["oma.dev/managed"] === "true" ||
                      pod.metadata?.labels?.["app.kubernetes.io/managed-by"] === "oma-k8s-bridge" ||
                      podName.startsWith("box-");
    const boxId = isManaged ? this.findBoxIdByPodName(podName) : null;

    const containerResources = pod.spec?.containers?.[0]?.resources?.requests;
    const createdAt = pod.metadata?.creationTimestamp ?? new Date().toISOString();
    const durationSeconds = createdAt
      ? Math.floor((Date.now() - new Date(createdAt).getTime()) / 1000)
      : 0;

    const containerStatuses = (pod.status?.containerStatuses ?? []).map((cs) => {
      const stateKeys = cs.state ? Object.keys(cs.state) : ["unknown"];
      return {
        name: cs.name ?? "",
        ready: cs.ready ?? false,
        restartCount: cs.restartCount ?? 0,
        state: stateKeys[0] ?? "unknown",
      };
    });

    return {
      id: podName,
      boxId,
      sessionId: isManaged ? pod.metadata?.labels?.["oma.dev/session-id"] ?? boxId : null,
      namespace: pod.metadata?.namespace ?? this.namespace,
      podName,
      nodeName: pod.spec?.nodeName ?? "unknown",
      status: pod.status?.phase as SandboxPodInfo["status"] ?? "Unknown",
      phase: pod.status?.phase ?? "Unknown",
      containerStatuses,
      cpuRequest: containerResources?.cpu ?? "0",
      memoryRequest: containerResources?.memory ?? "0",
      createdAt: pod.metadata?.creationTimestamp ?? new Date().toISOString(),
      durationSeconds,
      labels: pod.metadata?.labels ?? {},
    };
  }

  async getSandboxLogs(podName: string, tailLines?: number): Promise<string> {
    try {
      const coreApi = await this.getCoreApi();
      // The K8s client-node API signature for logs
      const res = await (coreApi as unknown as {
        readNamespacedPodLog(name: string, namespace: string, opts?: { tailLines?: number }): Promise<{ body?: string }>;
      }).readNamespacedPodLog(podName, this.namespace, { tailLines });
      const body = unwrapBody<string>(res);
      return body ?? "";
    } catch (err) {
      return `Error fetching logs: ${(err as Error).message}`;
    }
  }

  private findBoxIdByPodName(podName: string): string | null {
    // Check if any managed box maps to this pod name
    for (const [boxId, box] of this.boxes) {
      if (box.sessionId && podName.includes(box.sessionId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 40))) {
        return boxId;
      }
    }
    // Fallback: podName itself is the boxId
    if (this.boxes.has(podName)) return podName;
    return null;
  }

  // ── Box management ───────────────────────────────────────────────

  async createBox(sessionId: string, options?: {
    image?: string;
    cpu?: string;
    memory?: string;
    runtimeClassName?: string;
    serviceAccountName?: string;
    namespace?: string;
    readyTimeoutMs?: number;
  }): Promise<string> {
    const boxId = "box-" + sessionId.replace(/[^a-zA-Z0-9-]/g, "-").slice(0, 60);

    // Untyped dynamic import: the sandbox package ships raw .ts via
    // "exports", which this CJS tsc build can't resolve — typing comes
    // from the structural KubernetesSandboxExecutorLike interface above.
    const mod = await import("@duyet/oma-sandbox/adapters/kubernetes" as string);
    const executor: KubernetesSandboxExecutorLike = new mod.KubernetesSandboxExecutor({
      sessionId,
      namespace: options?.namespace ?? this.namespace,
      // Default matches DEFAULT_SANDBOX_IMAGE in @duyet/oma-sandbox (this
      // CJS build can't import the raw-.ts package statically — keep the
      // literal in lock-step). Batteries-included toolset image built from
      // docker/base/Dockerfile; bare node:22-slim had no curl/git (issue
      // #140).
      image: options?.image ?? process.env.SANDBOX_IMAGE ?? "ghcr.io/duyet/oma-runtime-base:latest",
      cpu: options?.cpu ?? process.env.OMA_K8S_CPU,
      memory: options?.memory ?? process.env.OMA_K8S_MEMORY,
      runtimeClassName: options?.runtimeClassName ?? process.env.OMA_K8S_RUNTIME_CLASS,
      serviceAccountName: options?.serviceAccountName ?? process.env.OMA_K8S_SERVICE_ACCOUNT,
      readyTimeoutMs: Number(options?.readyTimeoutMs ?? process.env.OMA_K8S_READY_TIMEOUT_MS ?? 120_000),
    } as KubernetesSandboxOptions);

    this.boxes.set(boxId, { executor, sessionId, createdAt: new Date() });
    return boxId;
  }

  getBox(boxId: string): { executor: KubernetesSandboxExecutorLike; sessionId: string } | undefined {
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

  listBoxes(): Array<{ id: string; sessionId: string; createdAt: Date }> {
    return Array.from(this.boxes.entries()).map(([id, box]) => ({
      id,
      sessionId: box.sessionId,
      createdAt: box.createdAt,
    }));
  }

  // ── Metrics ──────────────────────────────────────────────────────

  async getPodMetrics(): Promise<PodMetrics[]> {
    try {
      // metrics.k8s.io is optional — if not available, return empty
      const mod = await import("@kubernetes/client-node");
      const kc = new mod.KubeConfig();
      if (process.env.KUBERNETES_SERVICE_HOST) {
        kc.loadFromCluster();
      } else {
        kc.loadFromDefault();
      }
      const metrics = new mod.Metrics(kc);
      const res = await metrics.getPodMetrics(this.namespace);

      return (res.items ?? []).map((pm) => ({
        podName: pm.metadata?.name ?? "unknown",
        namespace: this.namespace,
        cpuUsage: pm.containers?.[0]?.usage?.cpu ?? "0",
        memoryUsage: pm.containers?.[0]?.usage?.memory ?? "0",
        timestamp: pm.timestamp ?? new Date().toISOString(),
        containers: (pm.containers ?? []).map((c) => ({
          name: c.name ?? "",
          cpuUsage: c.usage?.cpu ?? "0",
          memoryUsage: c.usage?.memory ?? "0",
        })),
      }));
    } catch {
      // metrics-server not installed, return empty
      return [];
    }
  }
}

function unwrapBody<T>(res: { body?: unknown } | unknown): T {
  if (res && typeof res === "object" && "body" in res) return (res as { body: T }).body;
  return res as T;
}

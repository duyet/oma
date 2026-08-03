// BridgeBackend — the surface the HTTP router (and health checks) drive,
// independent of which sandbox substrate serves it.
//
// The bridge historically fronted Kubernetes pods (`K8sManager`). It now
// also fronts NVIDIA OpenShell sandboxes (`OpenShellManager`), delegating
// the gRPC control plane the Cloudflare Worker cannot speak to a Node
// process here. Both back the exact same boxrun-shaped HTTP API in
// router.ts, so the router depends on this interface rather than a concrete
// manager. Cluster/discovery/metrics methods are Kubernetes-shaped; the
// OpenShell backend returns degraded (empty / "unknown") values for them
// since it owns no cluster of its own.

import type {
  ClusterCapacity,
  ClusterInfo,
  NodeInfo,
  PodMetrics,
  SandboxDetail,
  SandboxPodInfo,
} from "./k8s-manager";

/** The executor subset the router calls on a managed box. */
export interface BoxExecutor {
  exec(command: string, timeout?: number): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  setEnvVars(envVars: Record<string, string>): Promise<void>;
  destroy(): Promise<void>;
}

export interface CreateBoxOptions {
  image?: string;
  cpu?: string;
  memory?: string;
  /** OpenShell egress SandboxPolicy forwarded from the Worker (mapped from the
   *  OMA environment config). The k8s backend ignores it; the OpenShell backend
   *  attaches it to CreateSandbox. Opaque JSON here to avoid a build-time dep on
   *  the raw-.ts sandbox package from this CJS build. */
  policy?: unknown;
}

export interface BridgeBackend {
  // Box lifecycle
  createBox(sessionId: string, options?: CreateBoxOptions): Promise<string>;
  getBox(boxId: string): { executor: BoxExecutor; sessionId: string } | undefined;
  destroyBox(boxId: string): Promise<void>;
  activeCount(): number;

  // Cluster / discovery (Kubernetes-shaped; degraded on OpenShell)
  getK8sVersion(): Promise<string>;
  getNodeCount(): Promise<number>;
  getClusterInfo(): Promise<ClusterInfo>;
  getNodes(): Promise<NodeInfo[]>;
  getClusterCapacity(): Promise<ClusterCapacity>;
  discoverSandboxes(): Promise<SandboxPodInfo[]>;
  getSandboxLogs(podName: string, tailLines?: number): Promise<string>;
  getPodMetrics(): Promise<PodMetrics[]>;
  getSandboxDetail(id: string): Promise<SandboxDetail | null>;
}

// ─── Backend auto-detection ──────────────────────────────────────────
//
// Mirrors `resolveDefaultLocalSandboxProvider` in
// packages/sandbox-sdk/src/provider-config.ts: an explicit BRIDGE_BACKEND is
// trusted as-is; when unset (or "auto"), the presence of
// OPENSHELL_GATEWAY_ENDPOINT selects the OpenShell backend, otherwise
// Kubernetes. Pure so it's unit-testable without a process env.

export type BridgeBackendKind = "k8s" | "openshell";

export interface BridgeBackendSelection {
  kind: BridgeBackendKind;
  /** Human-readable reason, safe to log as-is. */
  reason: string;
}

export function resolveBridgeBackendKind(
  env: Record<string, string | undefined>,
): BridgeBackendSelection {
  const v = (env.BRIDGE_BACKEND ?? "").trim().toLowerCase();
  if (v === "openshell") {
    return { kind: "openshell", reason: "BRIDGE_BACKEND=openshell (explicit)" };
  }
  if (v === "k8s" || v === "kubernetes") {
    return { kind: "k8s", reason: `BRIDGE_BACKEND=${v} (explicit)` };
  }
  if (env.OPENSHELL_GATEWAY_ENDPOINT) {
    return {
      kind: "openshell",
      reason: `auto-detected: OPENSHELL_GATEWAY_ENDPOINT=${env.OPENSHELL_GATEWAY_ENDPOINT}`,
    };
  }
  return { kind: "k8s", reason: "auto-detected: no OpenShell gateway configured" };
}

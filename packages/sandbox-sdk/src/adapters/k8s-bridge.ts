// K8sBridgeSandbox — REST adapter for a Kubernetes sandbox bridge.
//
// This adapter calls a remote HTTP bridge service (running as a Pod or
// Deployment inside a Kubernetes cluster) that manages sandbox containers
// as Kubernetes pods. The bridge translates REST calls into Kubernetes
// API operations, providing an HTTP control plane for container lifecycle.
//
// Architecture:
//
//   [OMA Worker, CF]
//        │ HTTP to K8s Bridge
//        ▼
//   [K8s Bridge Pod, in-cluster]
//        │ k8s API → Pod + exec
//        ▼
//   [Ephemeral container (agent sandbox)]
//
// Driver dep: zero — uses globalThis.fetch. No @kubernetes/client-node,
// no Node builtins. Works in a Cloudflare Worker (pure outbound fetch).
//
// API surface (REST → SandboxExecutor):
//   POST   /api/v1/boxes                       — create box
//   DELETE /api/v1/boxes/:id                    — destroy box
//   POST   /api/v1/boxes/:id/exec              — run command
//   GET    /api/v1/boxes/:id/files?path=       — read file
//   PUT    /api/v1/boxes/:id/files?path=       — write file (+ ?base64=true)
//   POST   /api/v1/boxes/:id/env               — set env vars
//   GET    /api/v1/boxes/:id/status            — box status
//   GET    /api/v1/health                       — health check
//   GET    /api/v1/cluster/info                 — cluster info (observational)
//   GET    /api/v1/cluster/capacity             — cluster capacity (observational)
//
// Box lifecycle: lazy-create on first exec/readFile/writeFile.

import type { SandboxExecutor, SandboxFactory, SandboxCapacity } from "../ports";
import type { OpenShellSandboxPolicy } from "./openshell-policy";
import { getLogger } from "@duyet/oma-observability";

const moduleLogger = getLogger("k8s-bridge-sandbox");

/** Sandbox-pod lifecycle counts, mirroring the bridge's
 *  `SandboxLifecycleCounts` (apps/k8s-bridge/src/k8s-manager.ts). Declared
 *  here rather than imported: the bridge app depends on this package, not
 *  the other way round. */
export interface BridgeSandboxLifecycleCounts {
  total: number;
  running: number;
  pending: number;
  terminating: number;
  succeeded: number;
  failed: number;
  unknown: number;
}

/** `GET /cluster/capacity` response — mirrors the bridge's `ClusterCapacity`. */
export interface BridgeClusterCapacity {
  /** False when the bridge owns no cluster (OpenShell backend); every
   *  numeric field below is then meaningless. */
  available: boolean;
  reason?: string;
  totalCpu: string;
  totalMemory: string;
  allocatableCpu: string;
  allocatableMemory: string;
  requestedCpu: string;
  requestedMemory: string;
  allocatableCpuMillicores: number;
  requestedCpuMillicores: number;
  allocatableMemoryMib: number;
  requestedMemoryMib: number;
  runningPods: number;
  maxPods: number;
  estimatedAdditionalSandboxes: number;
  sandboxPods: BridgeSandboxLifecycleCounts | null;
}

/** `GET /cluster/info` response — mirrors the bridge's `ClusterInfo`. */
export interface BridgeClusterInfo {
  k8sVersion: string;
  platform: string;
  nodeCount: number;
  totalCpu: string;
  totalMemory: string;
  allocatableCpu: string;
  allocatableMemory: string;
  maxPods: number;
}

export interface K8sBridgeSandboxOptions {
  /** K8s bridge base URL with API prefix.
   *  Example: `http://k8s-bridge:8080/api/v1` */
  baseUrl: string;
  /** Bearer token for Authorization header on every request. */
  bearerToken: string;
  /** Used to name the box for operator visibility. Optional. */
  sessionId?: string;
  /** Container image. Default: the bridge server's SANDBOX_IMAGE (falls
   *  back to DEFAULT_SANDBOX_IMAGE). */
  image?: string;
  /** CPU cores (fractional allowed). */
  cpu?: number;
  /** Memory in MiB. */
  memory?: number;
  /** Kubernetes runtime class name — passed to the bridge. */
  runtimeClassName?: string;
  /** Kubernetes service account name — passed to the bridge. */
  serviceAccountName?: string;
  /** OpenShell egress SandboxPolicy (mapped from the OMA environment config on
   *  the Worker side). Forwarded verbatim in the create-box body; the k8s
   *  backend ignores it, the OpenShell backend attaches it to CreateSandbox. */
  policy?: OpenShellSandboxPolicy;
  /** Logger. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

export class K8sBridgeSandbox implements SandboxExecutor {
  private boxIdPromise: Promise<string> | null = null;
  private logger: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };

  constructor(private opts: K8sBridgeSandboxOptions) {
    if (!opts.baseUrl) throw new Error("K8sBridgeSandbox: baseUrl required");
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => moduleLogger.warn({ ...(ctx as Record<string, unknown> ?? {}) }, msg),
      log: (msg) => moduleLogger.info(msg),
    };
  }

  // ── core API ─────────────────────────────────────────────────────────

  async exec(command: string, timeout?: number): Promise<string> {
    const boxId = await this.ensureBox();
    const res = await this.fetch(`/boxes/${boxId}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command,
        timeoutMs: timeout,
      }),
    });
    if (!res.ok) {
      throw new Error(`k8s-bridge exec failed: ${res.status} ${await res.text()}`);
    }
    return await res.text();
  }

  async readFile(path: string): Promise<string> {
    const boxId = await this.ensureBox();
    const res = await this.fetch(
      `/boxes/${boxId}/files?path=${encodeURIComponent(path)}`,
    );
    if (!res.ok) {
      throw new Error(`k8s-bridge readFile ${path} failed: ${res.status}`);
    }
    return await res.text();
  }

  async writeFile(path: string, content: string): Promise<string> {
    const boxId = await this.ensureBox();
    const res = await this.fetch(
      `/boxes/${boxId}/files?path=${encodeURIComponent(path)}`,
      {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: content,
      },
    );
    if (!res.ok) {
      throw new Error(`k8s-bridge writeFile ${path} failed: ${res.status} ${await res.text()}`);
    }
    return path;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const boxId = await this.ensureBox();
    let bin = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + CHUNK) as unknown as number[],
      );
    }
    const b64 = btoa(bin);
    const res = await this.fetch(
      `/boxes/${boxId}/files?path=${encodeURIComponent(path)}&base64=true`,
      {
        method: "PUT",
        headers: { "content-type": "text/plain" },
        body: b64,
      },
    );
    if (!res.ok) {
      throw new Error(`k8s-bridge writeFileBytes ${path} failed: ${res.status} ${await res.text()}`);
    }
    return path;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    const boxId = await this.ensureBox();
    const res = await this.fetch(`/boxes/${boxId}/env`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envVars }),
    });
    if (!res.ok) {
      throw new Error(`k8s-bridge setEnvVars failed: ${res.status} ${await res.text()}`);
    }
  }

  async setOutboundContext(_opts?: { tenantId: string; sessionId: string }): Promise<void> {
    // K8s bridge uses an outbound proxy injected at the pod level via
    // the bridge's Pod spec — not configured per-sandbox from here.
  }

  async mountMemoryStore(_opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    throw new Error(
      "K8sBridgeSandbox.mountMemoryStore: not supported — the K8s bridge HTTP API " +
      "has no mount primitive. Use a custom container image with s3fs preinstalled, or " +
      "switch to a provider that supports managed mounts.",
    );
  }

  async mountSessionOutputs(_opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    // Not supported. The agent can still write to /workspace.
  }

  async startProcess(_command: string): Promise<null> {
    return null;
  }

  async createWorkspaceBackup(_opts: {
    name?: string;
    ttlSec: number;
  }): Promise<null> {
    return null;
  }

  async restoreWorkspaceBackup(_handle: {
    id: string;
    dir: string;
    localBucket?: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    return { ok: false };
  }

  async gitCheckout(_repoUrl: string, _options: { branch?: string; targetDir?: string }): Promise<null> {
    return null;
  }

  async destroy(): Promise<void> {
    if (!this.boxIdPromise) return;
    let boxId: string;
    try {
      boxId = await this.boxIdPromise;
    } catch {
      this.boxIdPromise = null;
      return;
    }
    try {
      const res = await this.fetch(`/boxes/${boxId}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        this.logger.warn(`k8s-bridge destroy non-OK: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      this.logger.warn(`k8s-bridge destroy error: ${(err as Error).message}`);
    } finally {
      this.boxIdPromise = null;
    }
  }

  /**
   * Health check with RTT measurement.
   * Returns `{ status: "ok", latencyMs }` on success,
   * `{ status: "error", latencyMs, details }` on failure.
   */
  async ping(): Promise<{ status: "ok" | "error"; latencyMs: number; details?: string }> {
    const start = Date.now();
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10000);
      const res = await this.fetch(`/health`, { signal: ac.signal });
      clearTimeout(t);
      if (!res.ok) {
        return { status: "error", latencyMs: Date.now() - start, details: `health check returned ${res.status}` };
      }
      return { status: "ok", latencyMs: Date.now() - start };
    } catch (err) {
      return { status: "error", latencyMs: Date.now() - start, details: (err as Error).message };
    }
  }

  /**
   * Raw cluster capacity payload from `GET /cluster/capacity`, verbatim.
   * Returns `null` on any failure (404 on an old bridge, network error,
   * non-JSON body) — capacity is observational and must never fail a call
   * path. An OpenShell-backed bridge answers with `available: false`; that
   * is a successful response, not a failure, so it is returned as-is and the
   * caller decides how to render it.
   */
  async getClusterCapacity(): Promise<BridgeClusterCapacity | null> {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10000);
      const res = await this.fetch(`/cluster/capacity`, { signal: ac.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      return (await res.json()) as BridgeClusterCapacity;
    } catch {
      return null;
    }
  }

  /**
   * Cluster info snapshot from `GET /cluster/info` (versions, node count,
   * total/allocatable). Same best-effort contract as getClusterCapacity.
   */
  async getClusterInfo(): Promise<BridgeClusterInfo | null> {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 10000);
      const res = await this.fetch(`/cluster/info`, { signal: ac.signal });
      clearTimeout(t);
      if (!res.ok) return null;
      return (await res.json()) as BridgeClusterInfo;
    } catch {
      return null;
    }
  }

  /**
   * Provider-agnostic capacity view, mapped from the bridge payload onto the
   * `SandboxCapacity` port. Returns `null` when the bridge reports
   * `available: false` (OpenShell backend) — a provider that owns no cluster
   * must report "unknown", never a zeroed reading that looks like a full one.
   */
  async getCapacity(): Promise<SandboxCapacity | null> {
    const body = await this.getClusterCapacity();
    if (!body || body.available === false) return null;

    const capacity: SandboxCapacity = {};
    if (body.allocatableCpuMillicores) {
      capacity.cpu = {
        used: (body.requestedCpuMillicores ?? 0) / 1000,
        total: body.allocatableCpuMillicores / 1000,
        unit: "cores",
      };
    }
    if (body.allocatableMemoryMib) {
      capacity.memory = {
        used: body.requestedMemoryMib ?? 0,
        total: body.allocatableMemoryMib,
        unit: "MiB",
      };
    }
    if (body.maxPods) {
      capacity.pods = { used: body.runningPods ?? 0, total: body.maxPods };
    }
    return Object.keys(capacity).length > 0 ? capacity : null;
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private ensureBox(): Promise<string> {
    if (!this.boxIdPromise) this.boxIdPromise = this.createBox();
    return this.boxIdPromise;
  }

  private async createBox(): Promise<string> {
    const body: Record<string, unknown> = {
      sessionId: this.opts.sessionId ?? "",
    };
    if (this.opts.image) body.image = this.opts.image;
    if (this.opts.cpu !== undefined) body.cpu = this.opts.cpu;
    if (this.opts.memory !== undefined) body.memory = this.opts.memory;
    if (this.opts.runtimeClassName) body.runtimeClassName = this.opts.runtimeClassName;
    if (this.opts.serviceAccountName) body.serviceAccountName = this.opts.serviceAccountName;
    if (this.opts.policy) body.policy = this.opts.policy;
    const res = await this.fetch(`/boxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`k8s-bridge create failed: ${res.status} ${await res.text()}`);
    }
    const box = (await res.json()) as { id?: string; boxId?: string; box_id?: string };
    const boxId = box.box_id ?? box.boxId ?? box.id ?? "";
    if (!boxId) throw new Error("k8s-bridge create: no box id in response");
    this.logger.log(`box created ${boxId} (${body.image ?? "default"})`);
    return boxId;
  }

  private fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}${path}`;
    const headers = new Headers(init.headers);
    if (this.opts.bearerToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.opts.bearerToken}`);
    }
    return globalThis.fetch(url, { ...init, headers, redirect: "follow" });
  }
}

// ── Factory (DIP entry point) ───────────────────────────────────────

export const sandboxFactory: SandboxFactory = async (ctx, env) => {
  const baseUrl = env.K8S_BRIDGE_URL;
  if (!baseUrl) {
    throw new Error(
      "SANDBOX_PROVIDER=k8s-bridge requires K8S_BRIDGE_URL " +
      "(e.g. http://k8s-bridge:8080/api/v1)",
    );
  }
  return new K8sBridgeSandbox({
    baseUrl: `${baseUrl.replace(/\/$/, "")}/api/v1`,
    bearerToken: env.K8S_BRIDGE_TOKEN ?? "",
    sessionId: ctx.sessionId,
    image: env.SANDBOX_IMAGE,
    cpu: env.K8S_CPU ? Number(env.K8S_CPU) : undefined,
    memory: env.K8S_MEMORY ? Number(env.K8S_MEMORY) : undefined,
  });
};

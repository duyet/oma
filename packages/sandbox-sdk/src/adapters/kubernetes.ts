// KubernetesSandboxExecutor — runs agent bash commands inside a pod
// provisioned via the kubernetes-sigs **agent-sandbox** controller
// (https://github.com/kubernetes-sigs/agent-sandbox), instead of a local
// subprocess or a third-party sandbox SaaS (E2B/Daytona).
//
// ─── CRD used ───────────────────────────────────────────────────────────
//
// This adapter creates a bare `Sandbox` custom resource directly:
//   apiVersion: agents.x-k8s.io/v1alpha1
//   kind: Sandbox
//   spec.podTemplate.spec: a real corev1.PodSpec (image, command, resources,
//     runtimeClassName, serviceAccountName, ...) — see api/v1alpha1/
//     sandbox_types.go in the agent-sandbox repo.
//
// We deliberately do NOT go through `SandboxClaim` + `SandboxTemplate`
// (group `extensions.agents.x-k8s.io`) even though those are also
// installed on the target cluster. Those add templating + warm-pool
// adoption on top, but require an operator to have pre-created a
// `SandboxTemplate` object out-of-band. The bare `Sandbox` object is
// fully self-contained per session — same shape as every other adapter
// in this package (LocalSubprocess/E2B/Daytona/BoxRun all spin up their
// sandbox from adapter-local config alone, no external template
// resource). This mirrors the project's own "hello-world-sandbox"
// example, which also applies a bare `Sandbox` with an inline
// podTemplate. Operators who want warm-pool adoption for faster cold
// starts can swap this adapter for one that posts a `SandboxClaim`
// instead — the SandboxExecutor port doesn't care which CRD produced
// the pod.
//
// ─── exec mechanism — IMPORTANT ASSUMPTION ─────────────────────────────
//
// agent-sandbox's own Go/Python SDKs (clients/go/sandbox, clients/python)
// do NOT exec via the Kubernetes pods/exec subresource. They POST JSON to
// a custom `/execute` HTTP endpoint served by a "sandbox-router" process
// that must be running *inside* the pod, reached via port-forward /
// Gateway / a direct URL (see clients/go/sandbox/commands.go +
// connector.go). That router is a bespoke binary baked into each
// example's own Docker image (hello-world-sandbox, python-runtime-
// sandbox, etc.) — there is no guarantee a generic `SANDBOX_IMAGE`
// (we default to the same `oma-runtime-base` image the E2B/Daytona adapters use)
// ships it.
//
// Rather than depend on that bespoke protocol + a custom image, this
// adapter execs commands via the STANDARD Kubernetes pods/exec
// subresource — the same mechanism `kubectl exec` uses — via
// `@kubernetes/client-node`'s `Exec` helper (WebSocket-based). This works
// against any container that has `/bin/sh`, with zero in-pod agent
// required, matching the assumption our other remote adapters already
// make about the sandbox image. Trade-off: we lose agent-sandbox's own
// file-transfer API (Files()) and its Gateway/tunnel connection
// strategies; we implement read/write via base64 through the same exec
// channel instead (mirrors what the Daytona/E2B adapters do for
// binary-safe file I/O).
//
// ─── isolation ──────────────────────────────────────────────────────────
//
// agent-sandbox's actual isolation guarantee comes from the pod's
// `runtimeClassName` (gVisor `runsc` / Kata `kata-qemu`), set by the
// cluster operator's RuntimeClass objects — this adapter passes through
// `OMA_K8S_RUNTIME_CLASS` when set but assumes nothing about what
// RuntimeClasses exist on the target cluster (k3s ships none by default;
// the operator must install gVisor/Kata separately for hard isolation).
// Without it, this is "just a pod" — no stronger than LocalSubprocess
// beyond namespace/resource-quota boundaries.
//
// Driver dep: `@kubernetes/client-node` is an optional peer — this file
// compiles without it installed (dynamic import, same pattern as the
// E2B/Daytona adapters). Deploys that opt into SANDBOX_PROVIDER=k8s
// install it: `pnpm add @kubernetes/client-node`.
//
// Env config (all optional except where noted):
//   OMA_K8S_NAMESPACE        — namespace for the Sandbox object. Default "default".
//   SANDBOX_IMAGE             — container image. Default DEFAULT_SANDBOX_IMAGE
//                               (ghcr.io/duyet/oma-runtime-base:latest).
//   OMA_K8S_RUNTIME_CLASS     — RuntimeClass name (e.g. "gvisor", "kata-qemu").
//   OMA_K8S_SERVICE_ACCOUNT   — ServiceAccount for the sandbox pod.
//   OMA_K8S_CPU               — CPU request/limit (k8s quantity, e.g. "500m").
//   OMA_K8S_MEMORY            — memory request/limit (e.g. "512Mi").
//   OMA_K8S_READY_TIMEOUT_MS  — how long to wait for Sandbox Ready=True. Default 120000.
//   MEMORY_S3_*                — s3fs bucket config for mountMemoryStore (shared
//                                with the Daytona/E2B adapters — see readS3MemoryBucket).
//
// In-cluster vs local kubeconfig: KubeConfig.loadFromCluster() is used
// when KUBERNETES_SERVICE_HOST is set (main-node running as an in-cluster
// pod with RBAC for `sandboxes` + `pods/exec`); otherwise falls back to
// the default kubeconfig (~/.kube/config or $KUBECONFIG) for local dev
// against the k3s cluster.

import type { Writable as NodeWritable } from "node:stream";
import type { ProcessHandle, SandboxExecutor, SandboxFactory } from "../ports";
import { DEFAULT_SANDBOX_IMAGE, readS3MemoryBucket } from "../ports";
import { getLogger } from "@duyet/oma-observability";

const moduleLogger = getLogger("k8s-sandbox");

const GROUP = "agents.x-k8s.io";
const VERSION = "v1alpha1";
const PLURAL = "sandboxes";
const CONTAINER_NAME = "sandbox";
const OMA_MANAGED_LABEL_KEY = "agents.x-k8s.io/oma-managed";
const OMA_MANAGED_LABEL_SELECTOR = `${OMA_MANAGED_LABEL_KEY}=true`;
/** Matches clients/go/sandbox's PodNameAnnotation constant — set by the
 *  agent-sandbox controller when adopting a pod from a warm pool. Not
 *  guaranteed present for a bare (non-claimed) Sandbox; we fall back to
 *  the label selector, then to the Sandbox's own name. */
const POD_NAME_ANNOTATION = "agents.x-k8s.io/pod-name";

export interface KubernetesSandboxOptions {
  /** Per-session identifier — used to derive the Sandbox object name. */
  sessionId: string;
  /** Namespace to create the Sandbox object in. Default "default". */
  namespace?: string;
  /** Container image. Default DEFAULT_SANDBOX_IMAGE (matches E2B/Daytona defaults). */
  image?: string;
  /** Command to run in the container — must not exit, since we exec
   *  additional commands into the running container afterwards. Default
   *  `["sh", "-c", "sleep infinity"]`. */
  command?: string[];
  /** RuntimeClass for gVisor/Kata isolation (e.g. "gvisor", "kata-qemu").
   *  Passed through to podTemplate.spec.runtimeClassName. Unset = no
   *  extra isolation beyond a normal pod. */
  runtimeClassName?: string;
  /** ServiceAccount for the sandbox pod. */
  serviceAccountName?: string;
  /** CPU request+limit, k8s quantity format (e.g. "500m"). */
  cpu?: string;
  /** Memory request+limit, k8s quantity format (e.g. "512Mi"). */
  memory?: string;
  /** How long to wait for the Sandbox's Ready condition (ms). Default 120000. */
  readyTimeoutMs?: number;
  /** Default per-exec timeout (ms). Default 120000. */
  defaultTimeoutMs?: number;
  /** Optional s3 bucket config for mountMemoryStore/mountSessionOutputs
   *  (s3fs, same pattern as the Daytona adapter). */
  memoryBucket?: {
    endpoint: string;
    accessKey: string;
    secretKey: string;
    bucketName: string;
  };
  /** Logger for debug/warn output. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

// ── Structural types for @kubernetes/client-node ──────────────────────
//
// Kept structural (not imported) so this file compiles without the
// driver installed — mirrors the E2B/Daytona adapters. Matches the
// object-parameter calling convention introduced in @kubernetes/
// client-node v1.x (our peerDependency range is ^1.0.0); `Exec.exec()`
// keeps its historical positional-argument signature across both 0.x and
// 1.x since it's a low-level WebSocket helper, not a generated API method.

interface K8sExecStatusCause {
  reason?: string;
  message?: string;
}
interface K8sExecStatus {
  status?: string; // "Success" | "Failure"
  reason?: string; // e.g. "NonZeroExitCode"
  details?: { causes?: K8sExecStatusCause[] };
}
interface K8sExecLike {
  exec(
    namespace: string,
    podName: string,
    containerName: string,
    command: string[],
    stdout: NodeWritable | null,
    stderr: NodeWritable | null,
    stdin: NodeJS.ReadableStream | null,
    tty: boolean,
    statusCallback?: (status: K8sExecStatus) => void,
  ): Promise<unknown>;
}
interface K8sCustomObjectsApiLike {
  createNamespacedCustomObject(args: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    body: unknown;
  }): Promise<{ body?: unknown } | unknown>;
  getNamespacedCustomObject(args: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    name: string;
  }): Promise<{ body?: unknown } | unknown>;
  deleteNamespacedCustomObject(args: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    name: string;
  }): Promise<unknown>;
  listNamespacedCustomObject(args: {
    group: string;
    version: string;
    namespace: string;
    plural: string;
    labelSelector?: string;
  }): Promise<{ body?: unknown } | unknown>;
}
interface K8sPod {
  metadata?: { name?: string };
  status?: { phase?: string };
}
interface K8sCoreV1ApiLike {
  listNamespacedPod(args: {
    namespace: string;
    labelSelector?: string;
  }): Promise<{ items: K8sPod[] } | { body: { items: K8sPod[] } }>;
}
interface K8sKubeConfigLike {
  loadFromCluster(): void;
  loadFromDefault(): void;
  makeApiClient<T>(ctor: new (...args: never[]) => T): T;
}
interface K8sClientModule {
  KubeConfig: new () => K8sKubeConfigLike;
  CoreV1Api: new (...args: never[]) => K8sCoreV1ApiLike;
  CustomObjectsApi: new (...args: never[]) => K8sCustomObjectsApiLike;
  Exec: new (kc: K8sKubeConfigLike) => K8sExecLike;
}

interface SandboxCondition {
  type?: string;
  status?: string;
  reason?: string;
  message?: string;
}
interface SandboxCustomResource {
  metadata?: { name?: string; namespace?: string; annotations?: Record<string, string> };
  status?: {
    conditions?: SandboxCondition[];
    selector?: string;
  };
}

interface K8sClients {
  customApi: K8sCustomObjectsApiLike;
  coreApi: K8sCoreV1ApiLike;
  execClient: K8sExecLike;
}

interface PodHandle {
  podName: string;
  containerName: string;
}

export class KubernetesSandboxExecutor implements SandboxExecutor {
  private readonly namespace: string;
  private readonly name: string;
  private readonly opts: Required<
    Pick<KubernetesSandboxOptions, "image" | "command" | "readyTimeoutMs" | "defaultTimeoutMs">
  > &
    KubernetesSandboxOptions;
  private readonly logger: NonNullable<KubernetesSandboxOptions["logger"]>;

  private envVars: Record<string, string> = {};
  private commandSecrets: Array<{ prefix: string; secrets: Record<string, string> }> = [];
  private pendingCaUpload: { hostPath: string; guestPath: string } | null = null;
  private memoryBucketMounted = false;

  private clientsPromise: Promise<K8sClients> | null = null;
  private podPromise: Promise<PodHandle> | null = null;

  constructor(opts: KubernetesSandboxOptions) {
    this.namespace = opts.namespace ?? "default";
    this.name = sanitizeK8sName(opts.sessionId);
    this.opts = {
      ...opts,
      image: opts.image ?? DEFAULT_SANDBOX_IMAGE,
      command: opts.command ?? ["sh", "-c", "sleep infinity"],
      readyTimeoutMs: opts.readyTimeoutMs ?? 120_000,
      defaultTimeoutMs: opts.defaultTimeoutMs ?? 120_000,
    };
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => moduleLogger.warn({ ...(ctx as Record<string, unknown> ?? {}) }, msg),
      log: (msg) => moduleLogger.info(msg),
    };
  }

  // ── core API ─────────────────────────────────────────────────────────

  async exec(command: string, timeout?: number): Promise<string> {
    try {
      const argv = ["/bin/sh", "-c", this.applyEnv(command)];
      const { stdout, stderr, exitCode } = await this.runExec(
        argv,
        timeout ?? this.opts.defaultTimeoutMs,
      );
      // Match the other adapters' shape: combined stdout+stderr, trimmed,
      // plus an exit-code suffix the harness's bash tool parser keys off.
      const combined =
        (stdout + (stderr ? `\n${stderr}` : "")).replace(/\s+$/, "") +
        (exitCode !== 0 ? `\n[exit ${exitCode}]` : "");
      return combined;
    } catch (err) {
      return `[error: ${(err as Error).message}]`;
    }
  }

  async startProcess(_command: string): Promise<ProcessHandle | null> {
    // The k8s pods/exec subresource has no native "detach and give me a
    // handle" mode — each exec is a single WebSocket stream tied to this
    // call. Returning null (like the Daytona adapter) makes the harness's
    // startProcess callers fall back to exec() with a longer timeout;
    // correct behaviour, just no kill/getStatus primitive.
    return null;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.envVars = { ...this.envVars, ...envVars };
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.push({ prefix: commandPrefix, secrets });
  }

  async setOutboundContext(_opts?: { tenantId: string; sessionId: string }): Promise<void> {
    // Same oma-vault MITM-proxy pattern as the other remote adapters:
    // point the shell at HTTPS_PROXY + trust the vault's self-signed CA.
    // The proxy URL must be reachable from inside the cluster network
    // (ClusterIP/Service DNS works if oma-vault runs as a k8s Service;
    // a bare localhost URL from the main-node host will NOT resolve from
    // inside the sandbox pod).
    const proxyUrl = process.env.OMA_VAULT_PROXY_URL;
    const caCertPath = process.env.OMA_VAULT_CA_CERT;
    if (!proxyUrl || !caCertPath) return;
    if (proxyUrl.startsWith("http://localhost") || proxyUrl.startsWith("http://127.")) {
      this.logger.warn(
        `k8s-sandbox: OMA_VAULT_PROXY_URL points at localhost (${proxyUrl}) — ` +
        `unreachable from inside the sandbox pod's network. In the common ` +
        `self-host layout, oma-vault runs as a SIDECAR container in the ` +
        `main-node pod (not its own Deployment), so there is no separate ` +
        `"oma-vault" Service to point at — expose its port on main-node's ` +
        `OWN Service instead (add a port 14322 entry) and use that Service's ` +
        `DNS name, e.g. http://oma.oma.svc.cluster.local:14322 for a Service ` +
        `named "oma" in namespace "oma". Only use a dedicated ` +
        `"oma-vault.<ns>.svc" name if oma-vault is deployed as its own ` +
        `standalone Service.`,
      );
    }
    const inBoxCaPath = "/etc/ssl/oma-vault-ca.crt";
    this.pendingCaUpload = { hostPath: caCertPath, guestPath: inBoxCaPath };
    await this.setEnvVars({
      HTTP_PROXY: proxyUrl,
      HTTPS_PROXY: proxyUrl,
      http_proxy: proxyUrl,
      https_proxy: proxyUrl,
      NODE_EXTRA_CA_CERTS: inBoxCaPath,
      SSL_CERT_FILE: inBoxCaPath,
      CURL_CA_BUNDLE: inBoxCaPath,
    });
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.readFileBytes(path);
    return Buffer.from(bytes).toString("utf8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const { stdout, stderr, exitCode } = await this.runExec(
      ["/bin/sh", "-c", `base64 -w0 -- ${shellEscape(path)} 2>&1`],
      30_000,
    );
    if (exitCode !== 0) {
      throw new Error(`k8s-sandbox readFileBytes ${path} failed (exit ${exitCode}): ${stderr || stdout}`);
    }
    const buf = Buffer.from(stdout.trim(), "base64");
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  async writeFile(path: string, content: string): Promise<string> {
    return this.writeFileBytes(path, new TextEncoder().encode(content));
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    return this.writeFileBytesOnPod(path, bytes);
  }

  /** Backing implementation for writeFileBytes, with an optional
   *  pre-resolved pod. The CA-cert upload inside createAndWaitForPod must
   *  pass the pod it just resolved: it runs *inside* the still-pending
   *  `podPromise`, so letting it call ensurePod() again would re-await that
   *  same unresolved promise and deadlock the whole turn (no exec ever
   *  starts, so runExec's timeout never arms either). See ensurePod. */
  private async writeFileBytesOnPod(
    path: string,
    bytes: Uint8Array,
    pod?: PodHandle,
  ): Promise<string> {
    // No native file-transfer API on this transport (see module header) —
    // base64-encode and decode it back on the other side of the same
    // exec channel used for commands. Suitable for the config/script-size
    // files the harness typically writes; multi-hundred-MB payloads would
    // want a different mechanism (e.g. an s3fs-mounted memory store).
    const b64 = Buffer.from(bytes).toString("base64");
    const dir = path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/";
    const cmd =
      `mkdir -p ${shellEscape(dir)} && ` +
      `echo ${shellEscape(b64)} | base64 -d > ${shellEscape(path)}`;
    const { stdout, stderr, exitCode } = await this.runExec(["/bin/sh", "-c", cmd], 30_000, pod);
    if (exitCode !== 0) {
      throw new Error(`k8s-sandbox writeFileBytes ${path} failed (exit ${exitCode}): ${stderr || stdout}`);
    }
    return path;
  }

  /**
   * Mount a memory store at /mnt/memory/<storeName>/ via s3fs — identical
   * strategy to the Daytona adapter: mount the whole bucket once at
   * /mnt/_oma_storage, then symlink per-store prefixes underneath.
   * Requires MEMORY_S3_* env vars (see readS3MemoryBucket) and an image
   * with apt + root (or a pre-baked image with s3fs already installed).
   */
  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    const cfg = this.opts.memoryBucket;
    if (!cfg) {
      throw new Error(
        "KubernetesSandboxExecutor.mountMemoryStore: no memoryBucket config — " +
        "set MEMORY_S3_ENDPOINT/MEMORY_S3_ACCESS_KEY/MEMORY_S3_SECRET_KEY/MEMORY_S3_BUCKET " +
        "so this adapter can mount memory stores via s3fs (a k8s pod has no host " +
        "bind-mount option for adapter-local directories).",
      );
    }
    if (!this.memoryBucketMounted) {
      await this.mountMemoryBucketRoot(cfg);
      this.memoryBucketMounted = true;
    }
    const link = `/mnt/memory/${opts.storeName}`;
    const target = `/mnt/_oma_storage/${opts.storeId}`;
    const setup = opts.readOnly
      ? `mkdir -p /mnt/memory && rm -rf ${shellEscape(link)} && ln -s ${shellEscape(target)} ${shellEscape(link)} && chmod -R a-w ${shellEscape(target)} 2>/dev/null || true`
      : `mkdir -p /mnt/memory && rm -rf ${shellEscape(link)} && ln -s ${shellEscape(target)} ${shellEscape(link)}`;
    await this.runOrThrow(setup, "mountMemoryStore");
    this.logger.log(`mounted memory store ${opts.storeName} -> ${target}${opts.readOnly ? " (ro)" : ""}`);
  }

  async mountSessionOutputs(opts: { tenantId: string; sessionId: string }): Promise<void> {
    const cfg = this.opts.memoryBucket;
    if (!cfg) {
      throw new Error(
        "KubernetesSandboxExecutor.mountSessionOutputs: no s3 bucket config — " +
        "same MEMORY_S3_* env vars are reused for outputs (memory under " +
        "/<storeId>/, outputs under /session-outputs/<tenant>/<session>/).",
      );
    }
    if (!this.memoryBucketMounted) {
      await this.mountMemoryBucketRoot(cfg);
      this.memoryBucketMounted = true;
    }
    const link = `/mnt/session/outputs`;
    const target = `/mnt/_oma_storage/session-outputs/${opts.tenantId}/${opts.sessionId}`;
    await this.runOrThrow(
      `mkdir -p /mnt/session && rm -rf ${shellEscape(link)} && ln -s ${shellEscape(target)} ${shellEscape(link)}`,
      "mountSessionOutputs",
    );
    this.logger.log(`mounted session outputs -> ${target}`);
  }

  /**
   * Health check with RTT — proves the whole control path works:
   * client load → pod resolve → pods/exec subresource. We run a trivial
   * `true` with a short timeout rather than relying on a backend `ping`
   * (the agent-sandbox controller exposes no such endpoint). Without this,
   * SandboxProviderRegistry.checkHealth() falls back to
   * `{ status: "error", details: "ping not implemented" }` and the k8s
   * provider shows as Unhealthy in the console even when fully reachable.
   */
  async ping(): Promise<{ status: "ok" | "error"; latencyMs: number; details?: string }> {
    const start = Date.now();
    try {
      await this.runExec(["/bin/sh", "-c", "true"], 10_000);
      return { status: "ok", latencyMs: Date.now() - start };
    } catch (err) {
      return {
        status: "error",
        latencyMs: Date.now() - start,
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async destroy(): Promise<void> {
    // Idempotent + independent of pod readiness: delete the Sandbox
    // object even if it never became Ready. The agent-sandbox controller
    // owns cascading deletion of the backing Pod/Service.
    try {
      const { customApi } = await this.getClients();
      await customApi.deleteNamespacedCustomObject({
        group: GROUP,
        version: VERSION,
        namespace: this.namespace,
        plural: PLURAL,
        name: this.name,
      });
    } catch (err) {
      this.logger.warn(`k8s-sandbox destroy: delete Sandbox ${this.namespace}/${this.name} failed: ${(err as Error).message}`);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private async runOrThrow(command: string, opLabel: string): Promise<void> {
    const { stdout, stderr, exitCode } = await this.runExec(["/bin/sh", "-c", command], 30_000);
    if (exitCode !== 0) {
      throw new Error(`k8s-sandbox ${opLabel} failed (exit ${exitCode}): ${stderr || stdout}`);
    }
  }

  private async mountMemoryBucketRoot(
    cfg: NonNullable<KubernetesSandboxOptions["memoryBucket"]>,
  ): Promise<void> {
    const setup = [
      "set -e",
      "if ! command -v s3fs >/dev/null 2>&1; then",
      "  (apt-get update -qq && apt-get install -y -qq s3fs >/dev/null) || " +
        "(apk add --no-cache s3fs-fuse >/dev/null)",
      "fi",
      "mkdir -p /mnt/_oma_storage",
      `printf '%s:%s\\n' ${shellEscape(cfg.accessKey)} ${shellEscape(cfg.secretKey)} > /etc/passwd-s3fs`,
      "chmod 600 /etc/passwd-s3fs",
      "mountpoint -q /mnt/_oma_storage || " +
        `s3fs ${shellEscape(cfg.bucketName)} /mnt/_oma_storage ` +
        `-o url=${shellEscape(cfg.endpoint)} -o use_path_request_style -o allow_other`,
    ].join(" && ");
    await this.runOrThrow(setup, "mountMemoryBucketRoot");
    this.logger.log(`s3fs mounted bucket ${cfg.bucketName} at /mnt/_oma_storage`);
  }

  /** Prefix env-var exports + command-secret exports onto the command —
   *  the k8s pods/exec subresource (like `kubectl exec`) has no env
   *  option, so we shell-prefix instead. Matches the E2B/Daytona adapters. */
  private applyEnv(command: string): string {
    const env: Record<string, string> = { ...this.envVars };
    for (const { prefix, secrets } of this.commandSecrets) {
      if (command.startsWith(prefix)) Object.assign(env, secrets);
    }
    if (Object.keys(env).length === 0) return command;
    const exports = Object.entries(env)
      .map(([k, v]) => `export ${k}=${shellEscape(v)};`)
      .join(" ");
    return `${exports} ${command}`;
  }

  /** Run argv in the sandbox pod via the k8s pods/exec subresource,
   *  waiting for the process to exit (or the timeout to fire). */
  private async runExec(
    argv: string[],
    timeoutMs: number,
    pod?: PodHandle,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // Bound the setup phase (client load + pod provisioning) so a hang here
    // fails loud instead of wedging the turn forever. The per-exec timer
    // below only arms *after* this await resolves, so without this guard any
    // stall before the WebSocket opens (e.g. an unreachable API server, or a
    // re-entrant ensurePod deadlock) would never surface. Pod provisioning
    // legitimately runs up to readyTimeoutMs, so allow for that plus the
    // exec budget.
    const { execClient } = await this.getClients();
    const setupBudgetMs = this.opts.readyTimeoutMs + timeoutMs;
    const { podName, containerName } = pod
      ? pod
      : await withTimeout(
          this.ensurePod(),
          setupBudgetMs,
          `k8s exec: pod not ready within ${setupBudgetMs}ms`,
        );
    const { Writable } = await import("node:stream");

    return new Promise((resolvePromise, rejectPromise) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const stdoutStream = new Writable({
        write(chunk: Buffer, _enc, cb) {
          stdout += chunk.toString("utf8");
          cb();
        },
      });
      const stderrStream = new Writable({
        write(chunk: Buffer, _enc, cb) {
          stderr += chunk.toString("utf8");
          cb();
        },
      });

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        rejectPromise(new Error(`k8s exec timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const finish = (exitCode: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ stdout, stderr, exitCode });
      };

      execClient
        .exec(
          this.namespace,
          podName,
          containerName,
          argv,
          stdoutStream,
          stderrStream,
          null,
          false,
          (status: K8sExecStatus) => {
            if (status.status === "Success") {
              finish(0);
              return;
            }
            // Failure — client-node surfaces the exit code as a "cause"
            // with reason "ExitCode" on the terminal V1Status (the same
            // shape kubectl exec's client parses).
            const cause = status.details?.causes?.find((c) => c.reason === "ExitCode");
            const code = cause?.message ? parseInt(cause.message, 10) : NaN;
            finish(Number.isFinite(code) ? code : 1);
          },
        )
        .catch((err: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          rejectPromise(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  private async getClients(): Promise<K8sClients> {
    if (!this.clientsPromise) this.clientsPromise = this.loadClients();
    return this.clientsPromise;
  }

  private async loadClients(): Promise<K8sClients> {
    const mod = (await import(/* @vite-ignore */ "@kubernetes/client-node" as string).catch(
      (err) => {
        throw new Error(
          `KubernetesSandboxExecutor: failed to load '@kubernetes/client-node' — ` +
          `pnpm add @kubernetes/client-node (cause: ${String(err)})`,
        );
      },
    )) as K8sClientModule;

    const kc = new mod.KubeConfig();
    if (process.env.KUBERNETES_SERVICE_HOST) {
      kc.loadFromCluster();
    } else {
      kc.loadFromDefault();
    }
    return {
      customApi: kc.makeApiClient(mod.CustomObjectsApi),
      coreApi: kc.makeApiClient(mod.CoreV1Api),
      execClient: new mod.Exec(kc),
    };
  }

  private async ensurePod(): Promise<PodHandle> {
    if (!this.podPromise) this.podPromise = this.createAndWaitForPod();
    return this.podPromise;
  }

  private async createAndWaitForPod(): Promise<PodHandle> {
    const { customApi, coreApi } = await this.getClients();

    const resources: Record<string, Record<string, string>> = {};
    if (this.opts.cpu || this.opts.memory) {
      const quantities: Record<string, string> = {};
      if (this.opts.cpu) quantities.cpu = this.opts.cpu;
      if (this.opts.memory) quantities.memory = this.opts.memory;
      resources.requests = quantities;
      resources.limits = quantities;
    }

    const podSpec: Record<string, unknown> = {
      restartPolicy: "Never",
      containers: [
        {
          name: CONTAINER_NAME,
          image: this.opts.image,
          command: this.opts.command,
          ...(Object.keys(resources).length ? { resources } : {}),
        },
      ],
      ...(this.opts.runtimeClassName ? { runtimeClassName: this.opts.runtimeClassName } : {}),
      ...(this.opts.serviceAccountName ? { serviceAccountName: this.opts.serviceAccountName } : {}),
    };

    const body = {
      apiVersion: `${GROUP}/${VERSION}`,
      kind: "Sandbox",
      metadata: {
        name: this.name,
        namespace: this.namespace,
        labels: { [OMA_MANAGED_LABEL_KEY]: "true" },
      },
      spec: { podTemplate: { spec: podSpec } },
    };

    this.logger.log(`creating Sandbox ${this.namespace}/${this.name} (image=${this.opts.image})`);
    await customApi.createNamespacedCustomObject({
      group: GROUP,
      version: VERSION,
      namespace: this.namespace,
      plural: PLURAL,
      body,
    });

    const sandboxObj = await this.waitForReady(customApi);
    const podName = await this.resolvePodName(coreApi, sandboxObj);
    this.logger.log(`Sandbox ${this.namespace}/${this.name} ready, pod=${podName}`);

    if (this.pendingCaUpload) {
      try {
        const { promises: nodeFs } = await import("node:fs");
        const buf = await nodeFs.readFile(this.pendingCaUpload.hostPath);
        // Pass the pod we just resolved — see writeFileBytesOnPod: routing
        // through ensurePod() here would re-await this very (still-pending)
        // podPromise and deadlock the turn.
        await this.writeFileBytesOnPod(this.pendingCaUpload.guestPath, new Uint8Array(buf), {
          podName,
          containerName: CONTAINER_NAME,
        });
        this.logger.log(`uploaded vault CA cert (${buf.byteLength} bytes)`);
      } catch (err) {
        this.logger.warn(`vault CA upload failed: ${(err as Error).message} — outbound TLS through oma-vault will fail with cert errors`);
      } finally {
        this.pendingCaUpload = null;
      }
    }

    return { podName, containerName: CONTAINER_NAME };
  }

  /** Poll the Sandbox object until its `Ready` condition is True (matches
   *  SandboxConditionReady in api/v1alpha1/sandbox_types.go), or throw
   *  after readyTimeoutMs. No watch API used — a k3s-friendly poll loop
   *  keeps this adapter's client surface small. */
  private async waitForReady(customApi: K8sCustomObjectsApiLike): Promise<SandboxCustomResource> {
    const deadline = Date.now() + this.opts.readyTimeoutMs;
    let lastErr: Error | undefined;
    while (Date.now() < deadline) {
      try {
        const res = await customApi.getNamespacedCustomObject({
          group: GROUP,
          version: VERSION,
          namespace: this.namespace,
          plural: PLURAL,
          name: this.name,
        });
        const obj = unwrapBody<SandboxCustomResource>(res);
        const ready = obj.status?.conditions?.find(
          (c) => c.type === "Ready" && c.status === "True",
        );
        if (ready) return obj;
      } catch (err) {
        lastErr = err as Error;
      }
      await sleep(1_000);
    }
    throw new Error(
      `KubernetesSandboxExecutor: Sandbox ${this.namespace}/${this.name} did not become Ready within ${this.opts.readyTimeoutMs}ms` +
      (lastErr ? ` (last error: ${lastErr.message})` : ""),
    );
  }

  /** Resolve the pod backing this Sandbox. Three-tier fallback, most to
   *  least reliable — not validated against a live cluster; adjust if the
   *  installed controller version behaves differently:
   *    1. `agents.x-k8s.io/pod-name` annotation (set for warm-pool adoption).
   *    2. `status.selector` label selector (the CRD's scale subresource
   *       exposes this — see +kubebuilder:subresource:scale in
   *       api/v1alpha1/sandbox_types.go) via a pod list.
   *    3. The Sandbox's own name — the controller's common convention for
   *       freshly-created (non-adopted) sandboxes is to name the pod
   *       after the Sandbox object itself. */
  private async resolvePodName(
    coreApi: K8sCoreV1ApiLike,
    sandboxObj: SandboxCustomResource,
  ): Promise<string> {
    const annotated = sandboxObj.metadata?.annotations?.[POD_NAME_ANNOTATION];
    if (annotated) return annotated;

    const selector = sandboxObj.status?.selector;
    if (selector) {
      const res = await coreApi.listNamespacedPod({ namespace: this.namespace, labelSelector: selector });
      const items = "items" in res ? res.items : res.body.items;
      const running = items.find((p) => p.status?.phase === "Running") ?? items[0];
      if (running?.metadata?.name) return running.metadata.name;
    }

    return this.name;
  }
}

// ── module helpers ───────────────────────────────────────────────────

function unwrapBody<T>(res: { body?: unknown } | unknown): T {
  if (res && typeof res === "object" && "body" in res) return (res as { body: T }).body;
  return res as T;
}

function unwrapItems<T>(res: { body?: unknown } | unknown): T[] {
  const body = unwrapBody<{ items?: T[] }>(res);
  return body?.items ?? [];
}

/** A Sandbox is a crash orphan when its pod has definitively failed
 *  (Finished=True) and it never was — or no longer is — Ready. A sandbox
 *  still Ready=True (actively serving a session) or not yet Finished (still
 *  starting up) is left alone: without cross-referencing the sessions
 *  store, that's indistinguishable from a sandbox a live session still
 *  needs. */
function isOrphanedSandbox(obj: SandboxCustomResource): boolean {
  const conditions = obj.status?.conditions ?? [];
  const ready = conditions.find((c) => c.type === "Ready");
  const finished = conditions.find((c) => c.type === "Finished");
  return ready?.status === "False" && finished?.status === "True";
}

export interface SweepOrphanedSandboxesOptions {
  /** Namespace to sweep. Default "default" (matches KubernetesSandboxOptions). */
  namespace?: string;
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

export interface SweepOrphanedSandboxesResult {
  checked: number;
  deleted: string[];
  errors: Array<{ name: string; error: string }>;
}

/**
 * GC backstop for orphaned Sandbox CRs: a main-node crash/restart mid-session
 * skips `destroy()`, and the agent-sandbox controller applies no TTL, so a
 * failed Sandbox's CR (and its dead pod) sit forever. Intended to run once at
 * main-node startup — the same moment a crash-induced orphan would exist.
 */
export async function sweepOrphanedSandboxes(
  opts: SweepOrphanedSandboxesOptions = {},
): Promise<SweepOrphanedSandboxesResult> {
  const namespace = opts.namespace ?? "default";
  const logger = opts.logger ?? {
    warn: (msg: string, ctx?: unknown) => moduleLogger.warn({ ...(ctx as Record<string, unknown> ?? {}) }, msg),
    log: (msg: string) => moduleLogger.info(msg),
  };
  const result: SweepOrphanedSandboxesResult = { checked: 0, deleted: [], errors: [] };

  const mod = (await import(/* @vite-ignore */ "@kubernetes/client-node" as string).catch(
    (err) => {
      throw new Error(
        `sweepOrphanedSandboxes: failed to load '@kubernetes/client-node' — ${String(err)}`,
      );
    },
  )) as K8sClientModule;
  const kc = new mod.KubeConfig();
  if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
  else kc.loadFromDefault();
  const customApi = kc.makeApiClient(mod.CustomObjectsApi);

  const listed = await customApi.listNamespacedCustomObject({
    group: GROUP,
    version: VERSION,
    namespace,
    plural: PLURAL,
    labelSelector: OMA_MANAGED_LABEL_SELECTOR,
  });
  const items = unwrapItems<SandboxCustomResource>(listed);
  result.checked = items.length;

  for (const item of items) {
    const name = item.metadata?.name;
    if (!name || !isOrphanedSandbox(item)) continue;
    try {
      await customApi.deleteNamespacedCustomObject({ group: GROUP, version: VERSION, namespace, plural: PLURAL, name });
      result.deleted.push(name);
      logger.log(`sandbox-gc: deleted orphaned Sandbox ${namespace}/${name}`);
    } catch (err) {
      result.errors.push({ name, error: (err as Error).message });
      logger.warn(`sandbox-gc: failed to delete Sandbox ${namespace}/${name}: ${(err as Error).message}`);
    }
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Reject with `message` if `p` hasn't settled within `ms`. Used to bound
 *  the exec setup phase so a stall there fails loud rather than hanging the
 *  session turn indefinitely. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Kubernetes object names must be RFC 1123 DNS subdomains: lowercase
 *  alphanumerics, '-', '.', max 253 chars, start/end alphanumeric. Session
 *  ids may contain uppercase/underscores/etc — sanitize + prefix + hash
 *  suffix to avoid collisions after truncation. */
function sanitizeK8sName(sessionId: string): string {
  const cleaned = sessionId.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
  const hash = simpleHash(sessionId);
  const base = cleaned.slice(0, 40) || "session";
  return `oma-${base}-${hash}`.slice(0, 63).replace(/-+$/, "");
}

/** Tiny deterministic hash (not cryptographic) — just enough entropy to
 *  disambiguate two session ids that collide after truncation. */
function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

// ── Factory (DIP entry point) ───────────────────────────────────────

export const sandboxFactory: SandboxFactory = async (ctx, env) => {
  return new KubernetesSandboxExecutor({
    sessionId: ctx.sessionId,
    namespace: env.OMA_K8S_NAMESPACE,
    image: env.SANDBOX_IMAGE,
    runtimeClassName: env.OMA_K8S_RUNTIME_CLASS,
    serviceAccountName: env.OMA_K8S_SERVICE_ACCOUNT,
    cpu: env.OMA_K8S_CPU,
    memory: env.OMA_K8S_MEMORY,
    readyTimeoutMs: env.OMA_K8S_READY_TIMEOUT_MS ? Number(env.OMA_K8S_READY_TIMEOUT_MS) : undefined,
    memoryBucket: readS3MemoryBucket(env),
  });
};

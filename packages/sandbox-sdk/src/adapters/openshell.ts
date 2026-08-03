// OpenShellSandbox — gRPC adapter for NVIDIA OpenShell.
//
// OpenShell (https://github.com/NVIDIA/OpenShell) is a sandboxed runtime
// for autonomous AI agents: each sandbox is an isolated container/VM with
// policy-enforced egress. A single gateway (control plane) owns the
// sandbox lifecycle and exposes it as a **gRPC** service
// `openshell.v1.OpenShell` (see proto/openshell.proto in the upstream
// repo). This adapter talks to that gateway directly from the self-host
// `apps/main-node` process (Node 22, has child_process + fs + gRPC).
//
// Architecture:
//
//   [OMA main-node]
//        │ gRPC (host:port, TLS/mTLS or plaintext)  ── @grpc/grpc-js
//        ▼
//   [OpenShell gateway]
//        │ libkrun / docker / k8s driver
//        ▼
//   [OpenShell sandbox container — policy-enforced egress]
//
// Why gRPC here (not REST): the OpenShell gateway has no REST surface —
// its entire public API is the gRPC `OpenShell` service. The Python SDK
// (python/openshell/sandbox.py) is just a generated gRPC client.
//
// API surface used (gRPC → SandboxExecutor):
//   exec         →  ExecSandbox(stream)   (stdout/stderr/exit events)
//   readFile*   →  exec `base64 -w0`  (no file RPC in the API)
//   writeFile*  →  exec `printf <b64> | base64 -d > path`
//   destroy      →  DeleteSandbox
//   create       →  CreateSandbox (+ poll GetSandbox until READY)
//
// OpenShell's API has no GetFile/PutFile/AttachVolume RPCs, so file
// I/O goes through the exec channel (same base64-through-exec fallback
// the Kubernetes adapter already uses) and memory/output mounts are not
// available — they throw like the BoxRun adapter does. OpenShell manages
// its own workspace persistence and outbound credentials (via policy +
// provider bundles), so the vault outbound hooks are no-ops.
//
// Capabilities: exec + files (via exec). cfCompatible: false — this
// adapter needs Node (gRPC, fs, child_process-free but heavy native
// deps), so it lives on the self-host runtime only.

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import type { SandboxExecutor, SandboxFactory } from "../ports";
import {
  mapEnvironmentConfigToOpenShellPolicy,
  type OpenShellSandboxPolicy,
} from "./openshell-policy";
import { getLogger } from "@duyet/oma-observability";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

const moduleLogger = getLogger("openshell-sandbox");

// Minimal proto subset (only the service + messages this adapter uses).
// Field numbers MUST match proto/openshell.proto upstream or the gateway
// will mis-parse. Loaded once per process into a lazy temp file so
// @grpc/proto-loader can wire up the client stub (proto-loader needs a
// file path, not a string).
const OPENSHELL_PROTO = `syntax = "proto3";
package openshell.v1;

message ObjectMeta {
  string id = 1;
  string name = 2;
  map<string, string> labels = 3;
}

message SandboxTemplate {
  string image = 1;
}

message SandboxSpec {
  map<string, string> environment = 5;
  SandboxTemplate template = 6;
  SandboxPolicy policy = 7;
  repeated string providers = 8;
}

// Policy subset mirrored from proto/sandbox.proto
// (openshell.sandbox.v1). Only the fields the OMA egress mapping populates
// are declared; field numbers MUST match upstream or the gateway mis-parses.
// Message/package names are irrelevant to the wire format — only field
// numbers + types matter — so these live in openshell.v1 for convenience.
message FilesystemPolicy {
  bool include_workdir = 1;
  repeated string read_only = 2;
  repeated string read_write = 3;
}

message NetworkEndpoint {
  string host = 1;
  uint32 port = 2;
}

message NetworkPolicyRule {
  string name = 1;
  repeated NetworkEndpoint endpoints = 2;
}

message SandboxPolicy {
  uint32 version = 1;
  FilesystemPolicy filesystem = 2;
  map<string, NetworkPolicyRule> network_policies = 5;
}

message SandboxStatus {
  string sandbox_name = 1;
  uint32 phase = 6;
  uint32 current_policy_version = 7;
}

message Sandbox {
  ObjectMeta metadata = 1;
  SandboxSpec spec = 2;
  SandboxStatus status = 3;
}

message CreateSandboxRequest {
  SandboxSpec spec = 1;
  string name = 2;
  map<string, string> labels = 3;
}

message GetSandboxRequest {
  string name = 1;
}

message DeleteSandboxRequest {
  string name = 1;
}

message DeleteSandboxResponse {
  bool deleted = 1;
}

message ExecSandboxRequest {
  string sandbox_id = 1;
  repeated string command = 2;
  string workdir = 3;
  map<string, string> environment = 4;
  uint32 timeout_seconds = 5;
  bytes stdin = 6;
}

message ExecSandboxStdout {
  bytes data = 1;
}

message ExecSandboxStderr {
  bytes data = 1;
}

message ExecSandboxExit {
  int32 exit_code = 1;
}

message ExecSandboxEvent {
  oneof payload {
    ExecSandboxStdout stdout = 1;
    ExecSandboxStderr stderr = 2;
    ExecSandboxExit exit = 3;
  }
}

service OpenShell {
  rpc CreateSandbox(CreateSandboxRequest) returns (Sandbox);
  rpc GetSandbox(GetSandboxRequest) returns (Sandbox);
  rpc DeleteSandbox(DeleteSandboxRequest) returns (DeleteSandboxResponse);
  rpc ExecSandbox(ExecSandboxRequest) returns (stream ExecSandboxEvent);
}
`;

// SANDBOX_PHASE_* enum values from proto/openshell.proto.
const PHASE_READY = 2;
const PHASE_ERROR = 3;

// Cache the loaded package definition + client constructor per process.
let cachedClientCtor: (grpc.Client & Record<string, Function>) | null = null;
let cachedProtoPath = "";

function loadProto(): void {
  if (cachedClientCtor) return;
  const hash = createHash("sha256").update(OPENSHELL_PROTO).digest("hex").slice(0, 16);
  const protoPath = join(tmpdir(), `openshell-adapter-${hash}.proto`);
  try {
    writeFileSync(protoPath, OPENSHELL_PROTO, "utf-8");
  } catch (err) {
    throw new Error(`openshell: failed to write proto temp file: ${(err as Error).message}`);
  }
  cachedProtoPath = protoPath;
  const pkgDef = protoLoader.loadSync(protoPath, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  const proto = grpc.loadPackageDefinition(pkgDef) as unknown as {
    openshell: { v1: { OpenShell: new (...args: unknown[]) => grpc.Client } };
  };
  // Bind the client constructor. We attach the stub methods lazily per
  // instance (they live on the protobuf message descriptor), so store the
  // constructor and build the service definition at instance time.
  cachedClientCtor = proto.openshell.v1.OpenShell as unknown as grpc.Client & Record<string, Function>;
}

export interface OpenShellSandboxOptions {
  /** Gateway gRPC endpoint: `host:port` (e.g. `127.0.0.1:8080`). */
  endpoint: string;
  /** Optional bearer token — sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Sandbox container image. Defaults to the OpenShell community base. */
  image?: string;
  /** Use TLS (mTLS if cert/key supplied) instead of plaintext. */
  tls?: {
    caPath?: string;
    certPath?: string;
    keyPath?: string;
  };
  /** Used to name the sandbox for operator visibility. */
  sessionId?: string;
  /** Downstream OpenShell SandboxPolicy (egress allowlist + filesystem),
   *  mapped from the OMA environment config. Attached to CreateSandbox's
   *  `spec.policy`. When unset, no policy is sent and the gateway applies its
   *  built-in default policy. */
  policy?: OpenShellSandboxPolicy;
  /** Logger. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

interface ExecResult {
  exit: number | null;
  stdout: string;
  stderr: string;
}

export class OpenShellSandbox implements SandboxExecutor {
  private sandboxNamePromise: Promise<string> | null = null;
  private envVars: Record<string, string> = {};
  private client: grpc.Client | null = null;
  private logger: NonNullable<OpenShellSandboxOptions["logger"]>;

  constructor(private opts: OpenShellSandboxOptions) {
    if (!opts.endpoint) throw new Error("OpenShellSandbox: endpoint required");
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => moduleLogger.warn({ ...(ctx as Record<string, unknown> ?? {}) }, msg),
      log: (msg) => moduleLogger.info(msg),
    };
  }

  // ── gRPC client ──────────────────────────────────────────────────────

  private getClient(): grpc.Client {
    if (this.client) return this.client;
    loadProto();
    if (!cachedClientCtor) {
      throw new Error("OpenShellSandbox: proto failed to load");
    }
    const credentials = this.buildCredentials();
    const ClientCtor = cachedClientCtor;
    // grpc.Client subclasses take (address, credentials, options).
    this.client = new (ClientCtor as unknown as new (addr: string, creds: grpc.ChannelCredentials, options?: object) => grpc.Client)(
      this.opts.endpoint,
      credentials,
      { "grpc.max_receive_message_length": -1, "grpc.max_send_message_length": -1 },
    );
    return this.client;
  }

  private buildCredentials(): grpc.ChannelCredentials {
    const tls = this.opts.tls;
    if (!tls) return grpc.credentials.createInsecure();
    // Lazy-import fs so the plaintext path never touches it.
    const { readFileSync } = require("node:fs") as typeof import("node:fs");
    const rootCert = tls.caPath ? readFileSync(tls.caPath) : undefined;
    const privateKey = tls.keyPath ? readFileSync(tls.keyPath) : undefined;
    const certChain = tls.certPath ? readFileSync(tls.certPath) : undefined;
    return grpc.credentials.createSsl(rootCert, privateKey, certChain);
  }

  private callMetadata(): grpc.Metadata {
    const md = new grpc.Metadata();
    if (this.opts.token) md.set("authorization", `Bearer ${this.opts.token}`);
    return md;
  }

  // ── core API ─────────────────────────────────────────────────────────

  private async ensureSandbox(): Promise<string> {
    if (!this.sandboxNamePromise) this.sandboxNamePromise = this.createSandbox();
    return this.sandboxNamePromise;
  }

  private async createSandbox(): Promise<string> {
    const client = this.getClient() as unknown as {
      CreateSandbox: (req: unknown, md: grpc.Metadata, cb: (e: Error | null, r: Record<string, unknown> | null) => void) => void;
    };
    const name = this.opts.sessionId ? `oma-${this.opts.sessionId.slice(0, 30)}` : "";
    const spec: Record<string, unknown> = {
      environment: this.envVars,
      template: { image: this.opts.image ?? "ghcr.io/nvidia/openshell-community/sandboxes/base:latest" },
    };
    // Attach the mapped SandboxPolicy (egress allowlist + filesystem) when the
    // OMA environment config produced one; otherwise leave it unset so the
    // gateway applies its built-in default policy.
    if (this.opts.policy) spec.policy = this.opts.policy;
    const sandboxName = await new Promise<string>((resolve, reject) => {
      client.CreateSandbox({ spec, name, labels: {} }, this.callMetadata(), (err, res) => {
        if (err || !res) {
          reject(new Error(`openshell CreateSandbox failed: ${err?.message ?? "no response"}`));
          return;
        }
        const meta = (res.metadata as { id?: string; name?: string }) ?? {};
        const sandboxName = meta.name ?? meta.id ?? "";
        if (!sandboxName) {
          reject(new Error("openshell CreateSandbox returned empty sandbox name"));
          return;
        }
        resolve(sandboxName);
      });
    });
    this.logger.log(`openshell sandbox created ${sandboxName}`);
    await this.waitReady(sandboxName);
    return sandboxName;
  }

  private async waitReady(sandboxName: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    // Poll GetSandbox until phase === READY (2).
    while (Date.now() < deadline) {
      const status = await this.getStatus(sandboxName);
      if (status === PHASE_READY) return;
      if (status === PHASE_ERROR) {
        throw new Error(`openshell sandbox ${sandboxName} entered ERROR phase`);
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`openshell sandbox ${sandboxName} was not READY within ${timeoutMs}ms`);
  }

  private async getStatus(sandboxName: string): Promise<number | null> {
    const client = this.getClient() as unknown as {
      GetSandbox: (req: unknown, md: grpc.Metadata, cb: (e: Error | null, r: Record<string, unknown> | null) => void) => void;
    };
    return new Promise<number | null>((resolve, reject) => {
      client.GetSandbox({ name: sandboxName }, this.callMetadata(), (err, res) => {
        if (err || !res) {
          reject(new Error(`openshell GetSandbox failed: ${err?.message ?? "no response"}`));
          return;
        }
        const status = (res.status as { phase?: number }) ?? {};
        resolve(typeof status.phase === "number" ? status.phase : null);
      });
    });
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const sandboxName = await this.ensureSandbox();
    const client = this.getClient() as unknown as {
      ExecSandbox: (req: unknown, md: grpc.Metadata) => grpc.ClientReadableStream<Record<string, unknown>>;
    };
    const timeoutSeconds = Math.ceil((timeout ?? 600) / 1000);
    const req = {
      sandbox_id: sandboxName,
      command: ["/bin/sh", "-c", command],
      environment: this.envVars,
      timeout_seconds: timeoutSeconds,
      stdin: Buffer.alloc(0),
    };

    const result = await new Promise<ExecResult>((resolve, reject) => {
      const stream = client.ExecSandbox(req, this.callMetadata());
      const out: ExecResult = { exit: null, stdout: "", stderr: "" };
      stream.on("data", (ev: Record<string, unknown>) => {
        if (ev.stdout && typeof (ev.stdout as { data?: Uint8Array }).data !== "undefined") {
          out.stdout += Buffer.from((ev.stdout as { data: Uint8Array }).data).toString("utf-8");
        } else if (ev.stderr && typeof (ev.stderr as { data?: Uint8Array }).data !== "undefined") {
          out.stderr += Buffer.from((ev.stderr as { data: Uint8Array }).data).toString("utf-8");
        } else if (ev.exit && typeof (ev.exit as { exit_code?: number }).exit_code !== "undefined") {
          out.exit = (ev.exit as { exit_code: number }).exit_code;
        }
      });
      stream.on("end", () => resolve(out));
      stream.on("error", (err: Error) => reject(err));
    });

    let str = `exit=${result.exit ?? "?"}\n${result.stdout}`;
    if (result.stderr.trim().length > 0) str += `[stderr:${result.stderr}]`;
    return str;
  }

  async readFile(path: string): Promise<string> {
    const bytes = await this.readFileBytes(path);
    return new TextDecoder().decode(bytes);
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    // No file RPC in the OpenShell API — read via base64 through exec.
    const out = await this.exec(`base64 -w0 -- "${path}" 2>/dev/null`, 30_000);
    const { stdout } = parseExecResult(out);
    const trimmed = stdout.trim();
    if (!trimmed) throw new Error(`openshell readFile ${path} returned empty (missing?): ${out}`);
    return new Uint8Array(Buffer.from(trimmed, "base64"));
  }

  async writeFile(path: string, content: string): Promise<string> {
    return this.writeFileBytes(path, new TextEncoder().encode(content));
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const b64 = Buffer.from(bytes).toString("base64");
    // mkdir -p the dir, then decode base64 into the file. base64 payload
    // is safe to inline as a single-quoted shell argument.
    const cmd =
      `set -e; D=$(dirname -- "${path}"); B=$(basename -- "${path}"); ` +
      `mkdir -p -- "$D"; printf '%s' '${b64}' | base64 -d > "$D/$B"`;
    await this.exec(cmd, 30_000);
    return path;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    // Merged into every exec request via the environment map.
    this.envVars = { ...this.envVars, ...envVars };
  }

  async destroy(): Promise<void> {
    if (!this.sandboxNamePromise) {
      this.client?.close();
      this.client = null;
      return;
    }
    let sandboxName: string;
    try {
      sandboxName = await this.sandboxNamePromise;
    } catch {
      this.client?.close();
      this.client = null;
      return;
    }
    try {
      const client = this.getClient() as unknown as {
        DeleteSandbox: (req: unknown, md: grpc.Metadata, cb: (e: Error | null, r: Record<string, unknown> | null) => void) => void;
      };
      await new Promise<void>((resolve) => {
        client.DeleteSandbox({ name: sandboxName }, this.callMetadata(), () => resolve());
      });
    } catch (err) {
      this.logger.warn(`openshell destroy error: ${(err as Error).message}`);
    } finally {
      this.client?.close();
      this.client = null;
      this.sandboxNamePromise = null;
    }
  }

  async ping(): Promise<{ status: "ok" | "error"; latencyMs: number; details?: string }> {
    const start = performance.now();
    try {
      await this.exec("true", 10_000);
      return { status: "ok", latencyMs: Math.round(performance.now() - start) };
    } catch (err) {
      return {
        status: "error",
        latencyMs: Math.round(performance.now() - start),
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ── unsupported optionals (OpenShell has no mount/backup RPC) ──────

  async mountMemoryStore(_opts: { storeName: string; storeId: string; readOnly: boolean }): Promise<void> {
    throw new Error(
      "OpenShellSandbox.mountMemoryStore: not supported — OpenShell's gRPC API has " +
      "no volume-mount primitive. Use a custom image with s3fs preinstalled, or " +
      "switch to another provider for managed /mnt/memory mounts.",
    );
  }

  async mountSessionOutputs(_opts: { tenantId: string; sessionId: string }): Promise<void> {
    throw new Error(
      "OpenShellSandbox.mountSessionOutputs: not supported — OpenShell has no " +
      "host-bind primitive. Use writeFile / readFile to surface outputs.",
    );
  }

  async createWorkspaceBackup(_opts: { name?: string; ttlSec: number }): Promise<{ id: string; dir: string; localBucket?: boolean } | null> {
    throw new Error(
      "OpenShellSandbox.createWorkspaceBackup: not supported — OpenShell persists " +
      "its own workspace; OMA cannot snapshot it. The sandbox outlives the agent turn.",
    );
  }

  async restoreWorkspaceBackup(_handle: { id: string; dir: string; localBucket?: boolean }): Promise<{ ok: boolean; error?: string }> {
    throw new Error("OpenShellSandbox.restoreWorkspaceBackup: not supported (see createWorkspaceBackup).");
  }

  // OpenShell manages outbound credentials (policy + provider bundles) and
  // its own workspace persistence, so the vault outbound hooks are no-ops.
  async setOutboundContext(_opts?: { tenantId: string; sessionId: string }): Promise<void> {
    return Promise.resolve();
  }
  async setBackupContext(_opts?: { tenantId: string; environmentId: string; sessionId: string }): Promise<void> {
    return Promise.resolve();
  }
  async snapshotWorkspaceNow?(): Promise<void> {
    return Promise.resolve();
  }
  async renewActivityTimeout?(): Promise<void> {
    return Promise.resolve();
  }
  registerCommandSecrets?(_prefix: string, _secrets: Record<string, string>): void {
    // no-op
  }
}

// Parse the combined `exit=N\n<stdout>\n[stderr:...]` shape shared with
// the BoxRun adapter.
function parseExecResult(out: string): ExecResult {
  const nl = out.indexOf("\n");
  const first = nl === -1 ? out : out.slice(0, nl);
  const rest = nl === -1 ? "" : out.slice(nl + 1);
  const exitMatch = /^exit=(\d+|\?)/.exec(first);
  const exit = exitMatch && exitMatch[1] !== "?" ? Number(exitMatch[1]) : null;
  let stdout = rest;
  let stderr = "";
  const stderrIdx = rest.lastIndexOf("[stderr:");
  if (stderrIdx !== -1) {
    const tail = rest.slice(stderrIdx);
    const m = /^\[stderr:(.*)\]$/s.exec(tail);
    if (m) {
      stderr = m[1];
      stdout = rest.slice(0, stderrIdx);
    }
  }
  return { exit, stdout, stderr };
}

// ── Factory (DIP entry point) ───────────────────────────────────────
//
// Host code (apps/main-node) only knows the provider name → import path
// map and never reads OPENSHELL_* env vars itself.

/**
 * Parse the OPENSHELL_GATEWAY_TLS / _CA_PATH / _CERT_PATH / _KEY_PATH env
 * vars into the `tls` option `OpenShellSandbox` and `probeOpenShellGateway`
 * both accept. Extracted out of `sandboxFactory` so main-node's
 * auto-detection probe (see `resolveDefaultLocalSandboxProvider` in
 * ../provider-config.ts) builds credentials the exact same way the real
 * adapter does — a probe that used different TLS settings than the
 * adapter it's predicting for would be worse than no probe at all.
 */
export function resolveOpenShellTlsFromEnv(
  env: Record<string, string | undefined>,
): OpenShellSandboxOptions["tls"] {
  const tlsEnabled = (env.OPENSHELL_GATEWAY_TLS ?? "").toLowerCase() === "1" ||
    !!(env.OPENSHELL_GATEWAY_CA_PATH || env.OPENSHELL_GATEWAY_CERT_PATH);
  if (!tlsEnabled) return undefined;
  return {
    caPath: env.OPENSHELL_GATEWAY_CA_PATH || undefined,
    certPath: env.OPENSHELL_GATEWAY_CERT_PATH || undefined,
    keyPath: env.OPENSHELL_GATEWAY_KEY_PATH || undefined,
  };
}

export const sandboxFactory: SandboxFactory = async (ctx, env) => {
  const endpoint = env.OPENSHELL_GATEWAY_ENDPOINT;
  if (!endpoint) {
    throw new Error(
      "SANDBOX_PROVIDER=openshell requires OPENSHELL_GATEWAY_ENDPOINT " +
        "(e.g. 127.0.0.1:8080)",
    );
  }

  // Map the session's environment config (networking/packages) to a downstream
  // OpenShell egress policy. The MCP-proxy host is deployment-specific; on
  // self-host it's optional (OPENSHELL_MCP_PROXY_HOST), and a missing one just
  // warns rather than failing.
  const mcpProxyHosts = env.OPENSHELL_MCP_PROXY_HOST
    ? [env.OPENSHELL_MCP_PROXY_HOST]
    : undefined;
  const { policy, warnings } = mapEnvironmentConfigToOpenShellPolicy(
    ctx.environmentConfig,
    { mcpProxyHosts },
  );
  for (const w of warnings) {
    moduleLogger.warn({ session_id: ctx.sessionId, op: "openshell.policy.map" }, w);
  }

  return new OpenShellSandbox({
    endpoint,
    token: env.OPENSHELL_TOKEN,
    image: env.OPENSHELL_IMAGE,
    tls: resolveOpenShellTlsFromEnv(env),
    sessionId: ctx.sessionId,
    policy,
  });
};

/**
 * probeOpenShellGateway — cheap reachability check for the OpenShell
 * gateway. Opens a bare gRPC channel (no proto, no RPC call) and waits
 * for it to reach READY (TCP + HTTP/2 handshake) within `timeoutMs`.
 * Never throws — any failure (bad endpoint, connection refused, no
 * gateway listening, timeout) resolves `false`. Used by main-node's
 * default-sandbox-provider auto-detection
 * (`resolveDefaultLocalSandboxProvider` in ../provider-config.ts) to
 * decide whether to prefer OpenShell over the "subprocess" fallback when
 * neither an environment nor SANDBOX_PROVIDER pins a provider explicitly.
 */
export async function probeOpenShellGateway(
  endpoint: string,
  tls?: OpenShellSandboxOptions["tls"],
  timeoutMs = 1500,
): Promise<boolean> {
  if (!endpoint) return false;
  let client: grpc.Client | null = null;
  try {
    const credentials = tls
      ? (() => {
          const { readFileSync } = require("node:fs") as typeof import("node:fs");
          const rootCert = tls.caPath ? readFileSync(tls.caPath) : undefined;
          const privateKey = tls.keyPath ? readFileSync(tls.keyPath) : undefined;
          const certChain = tls.certPath ? readFileSync(tls.certPath) : undefined;
          return grpc.credentials.createSsl(rootCert, privateKey, certChain);
        })()
      : grpc.credentials.createInsecure();
    client = new grpc.Client(endpoint, credentials);
    const deadline = Date.now() + timeoutMs;
    return await new Promise<boolean>((resolve) => {
      client!.waitForReady(deadline, (err) => resolve(!err));
    });
  } catch {
    return false;
  } finally {
    try { client?.close(); } catch { /* ignore */ }
  }
}

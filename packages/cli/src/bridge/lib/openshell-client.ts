/**
 * Lean OpenShell gRPC client for the bridge daemon.
 *
 * This is a deliberate VENDORED COPY of the core of
 * `packages/sandbox/src/adapters/openshell.ts` (`OpenShellSandbox` +
 * `probeOpenShellGateway`). Keep the two in sync — the proto string in
 * particular is covered by an agreement test
 * (`openshell-client.test.ts`), because a field-number drift is the kind
 * of divergence that silently corrupts the wire format.
 *
 * Why a copy and not an import: `@getoma/cli` publishes a single
 * esbuild bundle with ZERO runtime dependencies, and the internal
 * `@duyet/oma-*` packages are private (never published), so a published
 * CLI could never resolve `@duyet/oma-sandbox` at runtime. The adapter
 * also pulls `@duyet/oma-observability` at module scope, which drags
 * hono middleware and a dynamic `import("pino")` into the bundle.
 * `@grpc/grpc-js` + `@grpc/proto-loader` are pure-JS devDependencies and
 * get bundled.
 *
 * Differences from the adapter, all intentional:
 *   - no `SandboxPolicy` mapping: the relay protocol carries no
 *     environment config, so egress is whatever default policy the
 *     gateway itself enforces (see bridge-sandbox.ts for the note).
 *   - logger is a plain injectable object, no observability package.
 *   - `exec` takes a REQUIRED timeout in ms. The adapter's `?? 600`
 *     default is 600ms (an upstream typo for 600_000); never rely on it.
 */

import * as grpc from "@grpc/grpc-js";
import * as protoLoader from "@grpc/proto-loader";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

// Minimal proto subset (only the service + messages this client uses).
// MUST stay byte-identical to OPENSHELL_PROTO in
// packages/sandbox/src/adapters/openshell.ts — asserted by a test.
export const OPENSHELL_PROTO = `syntax = "proto3";
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

/** Default gateway address when neither config nor env pins one. */
export const DEFAULT_OPENSHELL_ENDPOINT = "127.0.0.1:8080";

/** SANDBOX_PHASE_* enum values from proto/openshell.proto. */
const PHASE_READY = 2;
const PHASE_ERROR = 3;

const DEFAULT_IMAGE = "ghcr.io/nvidia/openshell-community/sandboxes/base:latest";

let cachedClientCtor: (grpc.Client & Record<string, Function>) | null = null;

function loadProto(): void {
  if (cachedClientCtor) return;
  const hash = createHash("sha256").update(OPENSHELL_PROTO).digest("hex").slice(0, 16);
  const protoPath = join(tmpdir(), `openshell-bridge-${hash}.proto`);
  try {
    writeFileSync(protoPath, OPENSHELL_PROTO, "utf-8");
  } catch (err) {
    throw new Error(`openshell: failed to write proto temp file: ${(err as Error).message}`);
  }
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
  cachedClientCtor = proto.openshell.v1.OpenShell as unknown as grpc.Client & Record<string, Function>;
}

export interface OpenShellTls {
  caPath?: string;
  certPath?: string;
  keyPath?: string;
}

export interface OpenShellClientOptions {
  /** Gateway gRPC endpoint: `host:port` (e.g. `127.0.0.1:8080`). */
  endpoint: string;
  /** Optional bearer token — sent as `Authorization: Bearer <token>`. */
  token?: string;
  /** Sandbox container image. Defaults to the OpenShell community base. */
  image?: string;
  /** Use TLS (mTLS if cert/key supplied) instead of plaintext. */
  tls?: OpenShellTls;
  /** Names the sandbox for operator visibility. */
  sessionId?: string;
  logger?: { warn: (msg: string) => void; log: (msg: string) => void };
}

function buildCredentials(tls?: OpenShellTls): grpc.ChannelCredentials {
  if (!tls) return grpc.credentials.createInsecure();
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const rootCert = tls.caPath ? readFileSync(tls.caPath) : undefined;
  const privateKey = tls.keyPath ? readFileSync(tls.keyPath) : undefined;
  const certChain = tls.certPath ? readFileSync(tls.certPath) : undefined;
  return grpc.credentials.createSsl(rootCert, privateKey, certChain);
}

interface ExecResult {
  exit: number | null;
  stdout: string;
  stderr: string;
}

/**
 * One OpenShell sandbox, created lazily on the first op. Mirrors
 * `OpenShellSandbox`'s exec-based file I/O (the gateway API has no file
 * RPC), so `readFile`/`writeFile` go through `base64` in the box.
 */
export class OpenShellClient {
  #opts: OpenShellClientOptions;
  #client: grpc.Client | null = null;
  #sandboxNamePromise: Promise<string> | null = null;
  #envVars: Record<string, string> = {};
  #logger: NonNullable<OpenShellClientOptions["logger"]>;

  constructor(opts: OpenShellClientOptions) {
    if (!opts.endpoint) throw new Error("OpenShellClient: endpoint required");
    this.#opts = opts;
    this.#logger = opts.logger ?? { warn: () => {}, log: () => {} };
  }

  // ── gRPC plumbing ────────────────────────────────────────────────────

  #getClient(): grpc.Client {
    if (this.#client) return this.#client;
    loadProto();
    if (!cachedClientCtor) throw new Error("OpenShellClient: proto failed to load");
    const Ctor = cachedClientCtor as unknown as new (
      addr: string,
      creds: grpc.ChannelCredentials,
      options?: object,
    ) => grpc.Client;
    this.#client = new Ctor(this.#opts.endpoint, buildCredentials(this.#opts.tls), {
      "grpc.max_receive_message_length": -1,
      "grpc.max_send_message_length": -1,
    });
    return this.#client;
  }

  #metadata(): grpc.Metadata {
    const md = new grpc.Metadata();
    if (this.#opts.token) md.set("authorization", `Bearer ${this.#opts.token}`);
    return md;
  }

  // ── lifecycle ────────────────────────────────────────────────────────

  #ensureSandbox(): Promise<string> {
    if (!this.#sandboxNamePromise) this.#sandboxNamePromise = this.#createSandbox();
    return this.#sandboxNamePromise;
  }

  async #createSandbox(): Promise<string> {
    const client = this.#getClient() as unknown as {
      CreateSandbox: (
        req: unknown,
        md: grpc.Metadata,
        cb: (e: Error | null, r: Record<string, unknown> | null) => void,
      ) => void;
    };
    const name = this.#opts.sessionId ? `oma-${this.#opts.sessionId.slice(0, 30)}` : "";
    // No `policy` here: the relay protocol carries no environment config, so
    // there is nothing to map. The gateway's own default policy applies.
    const spec = {
      environment: this.#envVars,
      template: { image: this.#opts.image ?? DEFAULT_IMAGE },
    };
    const sandboxName = await new Promise<string>((resolve, reject) => {
      client.CreateSandbox({ spec, name, labels: {} }, this.#metadata(), (err, res) => {
        if (err || !res) {
          reject(new Error(`openshell CreateSandbox failed: ${err?.message ?? "no response"}`));
          return;
        }
        const meta = (res.metadata as { id?: string; name?: string }) ?? {};
        const resolved = meta.name ?? meta.id ?? "";
        if (!resolved) {
          reject(new Error("openshell CreateSandbox returned empty sandbox name"));
          return;
        }
        resolve(resolved);
      });
    });
    this.#logger.log(`openshell sandbox created ${sandboxName}`);
    await this.#waitReady(sandboxName);
    return sandboxName;
  }

  async #waitReady(sandboxName: string, timeoutMs = 120_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const phase = await this.#getPhase(sandboxName);
      if (phase === PHASE_READY) return;
      if (phase === PHASE_ERROR) throw new Error(`openshell sandbox ${sandboxName} entered ERROR phase`);
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`openshell sandbox ${sandboxName} was not READY within ${timeoutMs}ms`);
  }

  #getPhase(sandboxName: string): Promise<number | null> {
    const client = this.#getClient() as unknown as {
      GetSandbox: (
        req: unknown,
        md: grpc.Metadata,
        cb: (e: Error | null, r: Record<string, unknown> | null) => void,
      ) => void;
    };
    return new Promise<number | null>((resolve, reject) => {
      client.GetSandbox({ name: sandboxName }, this.#metadata(), (err, res) => {
        if (err || !res) {
          reject(new Error(`openshell GetSandbox failed: ${err?.message ?? "no response"}`));
          return;
        }
        const status = (res.status as { phase?: number }) ?? {};
        resolve(typeof status.phase === "number" ? status.phase : null);
      });
    });
  }

  // ── executor surface ─────────────────────────────────────────────────

  /** Run a command in the box. `timeoutMs` is required — see file header. */
  async exec(command: string, timeoutMs: number): Promise<string> {
    const sandboxName = await this.#ensureSandbox();
    const client = this.#getClient() as unknown as {
      ExecSandbox: (req: unknown, md: grpc.Metadata) => grpc.ClientReadableStream<Record<string, unknown>>;
    };
    const req = {
      sandbox_id: sandboxName,
      command: ["/bin/sh", "-c", command],
      environment: this.#envVars,
      timeout_seconds: Math.max(1, Math.ceil(timeoutMs / 1000)),
      stdin: Buffer.alloc(0),
    };
    const result = await new Promise<ExecResult>((resolve, reject) => {
      const stream = client.ExecSandbox(req, this.#metadata());
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
    return new TextDecoder().decode(await this.readFileBytes(path));
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const out = await this.exec(`base64 -w0 -- "${path}" 2>/dev/null`, 30_000);
    const trimmed = stdoutOf(out).trim();
    if (!trimmed) throw new Error(`openshell readFile ${path} returned empty (missing?): ${out}`);
    return new Uint8Array(Buffer.from(trimmed, "base64"));
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.writeFileBytes(path, new TextEncoder().encode(content));
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
    const b64 = Buffer.from(bytes).toString("base64");
    const cmd =
      `set -e; D=$(dirname -- "${path}"); B=$(basename -- "${path}"); ` +
      `mkdir -p -- "$D"; printf '%s' '${b64}' | base64 -d > "$D/$B"`;
    await this.exec(cmd, 30_000);
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.#envVars = { ...this.#envVars, ...envVars };
  }

  async ping(): Promise<void> {
    await this.exec("true", 10_000);
  }

  async destroy(): Promise<void> {
    const pending = this.#sandboxNamePromise;
    this.#sandboxNamePromise = null;
    if (!pending) {
      this.#closeChannel();
      return;
    }
    let sandboxName: string;
    try {
      sandboxName = await pending;
    } catch {
      this.#closeChannel();
      return;
    }
    try {
      const client = this.#getClient() as unknown as {
        DeleteSandbox: (
          req: unknown,
          md: grpc.Metadata,
          cb: (e: Error | null, r: Record<string, unknown> | null) => void,
        ) => void;
      };
      await new Promise<void>((resolve) => {
        client.DeleteSandbox({ name: sandboxName }, this.#metadata(), () => resolve());
      });
    } catch (err) {
      this.#logger.warn(`openshell destroy error: ${(err as Error).message}`);
    } finally {
      this.#closeChannel();
    }
  }

  #closeChannel(): void {
    try { this.#client?.close(); } catch { /* already closed */ }
    this.#client = null;
  }
}

/** Extract the stdout section of the `exit=N\n<stdout>[stderr:…]` shape. */
function stdoutOf(out: string): string {
  const nl = out.indexOf("\n");
  const rest = nl === -1 ? "" : out.slice(nl + 1);
  const idx = rest.lastIndexOf("[stderr:");
  return idx === -1 ? rest : rest.slice(0, idx);
}

/**
 * Cheap reachability check — opens a bare gRPC channel (no proto, no RPC)
 * and waits for it to reach READY. Never throws; any failure is `false`.
 * Vendored from `probeOpenShellGateway` in the sandbox adapter.
 */
export async function probeOpenShellGateway(
  endpoint: string,
  tls?: OpenShellTls,
  timeoutMs = 1500,
): Promise<boolean> {
  if (!endpoint) return false;
  let client: grpc.Client | null = null;
  try {
    client = new grpc.Client(endpoint, buildCredentials(tls));
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

/**
 * Parse OPENSHELL_GATEWAY_TLS / _CA_PATH / _CERT_PATH / _KEY_PATH the same
 * way `resolveOpenShellTlsFromEnv` does in the sandbox adapter, so the
 * daemon's probe and its real client agree on credentials.
 */
export function resolveOpenShellTlsFromEnv(
  env: Record<string, string | undefined>,
): OpenShellTls | undefined {
  const tlsEnabled = (env.OPENSHELL_GATEWAY_TLS ?? "").toLowerCase() === "1" ||
    !!(env.OPENSHELL_GATEWAY_CA_PATH || env.OPENSHELL_GATEWAY_CERT_PATH);
  if (!tlsEnabled) return undefined;
  return {
    caPath: env.OPENSHELL_GATEWAY_CA_PATH || undefined,
    certPath: env.OPENSHELL_GATEWAY_CERT_PATH || undefined,
    keyPath: env.OPENSHELL_GATEWAY_KEY_PATH || undefined,
  };
}

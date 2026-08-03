// KubernetesRemoteSandbox — pure-fetch adapter for a remote k8s sandbox
// gateway (Part B of issue #78).
//
// The in-cluster Kubernetes adapter (`adapters/kubernetes.ts`,
// `KubernetesSandboxExecutor`) creates a `Sandbox` CRD and execs via the
// pods/exec WebSocket subresource using `@kubernetes/client-node`. It is
// `cfCompatible: false`: a Worker is a single-file V8 isolate with no
// `node:child_process`, no kubeconfig/filesystem, no Node streams, and no
// WebSocket-exec client — the native SDK simply cannot run there.
//
// This adapter instead talks to a small **HTTP gateway** that runs *in*
// the cluster (Part A) and front-ends the same k8s pod create/exec/files
// lifecycle over plain HTTP. The gateway reuses `KubernetesSandboxExecutor`
// internally and exposes a boxrun-shaped API:
//
//   POST   /boxes                → { box_id }            (create Sandbox CRD, wait Ready)
//   POST   /boxes/:id/exec       → { execution_id }
//   GET    /boxes/:id/executions/:execId/output  (SSE: stdout/stderr/exit, base64)
//   GET/PUT /boxes/:id/files?path=  via application/x-tar
//   DELETE /boxes/:id
//
// Architecture:
//
//   [OMA Worker, no kubeconfig]
//        │ HTTP (globalThis.fetch)
//        ▼
//   [k8s-sandbox-gateway, in-cluster]
//        │ KubernetesSandboxExecutor (in-cluster RBAC, WebSocket exec)
//        ▼
//   [k8s pod with agent's bash subprocess]
//
// Driver dep: zero — uses globalThis.fetch only. No Node builtins are
// imported anywhere in this file, so it bundles cleanly into a Worker.
//
// API surface (HTTP → SandboxExecutor):
//   exec        →  POST /boxes/{id}/exec  (start)
//                  GET  /boxes/{id}/executions/{exec_id}/output (SSE)
//   readFile    →  GET  /boxes/{id}/files?path=...  (tar archive)
//   writeFile*  →  PUT  /boxes/{id}/files?path=...  (tar archive)
//   destroy     →  DELETE /boxes/{id}
//
// Box lifecycle: lazy-create on first exec/readFile/writeFile. The
// configured-but-not-started state from the gateway's POST /boxes is fine
// — POST /exec auto-starts the pod if needed. Cached `boxId` per-instance.

import type { SandboxExecutor, SandboxFactory } from "../ports";
import { DEFAULT_SANDBOX_IMAGE } from "../ports";
import { getLogger } from "@duyet/oma-observability";

const moduleLogger = getLogger("k8s-remote-sandbox");

export interface KubernetesRemoteSandboxOptions {
  /** Gateway base URL. Example: `https://k8s-gateway.oma.internal/v1/default`.
   *  The trailing `/boxes/...` path is appended by this adapter. */
  baseUrl: string;
  /** Container image. Default: DEFAULT_SANDBOX_IMAGE, matching the other
   *  image-accepting adapters so agent bash scripts behave the same. */
  image?: string;
  /** Optional pod resource limits — passed straight to the gateway's
   *  CreateBoxRequest. */
  cpus?: number;
  memoryMib?: number;
  /** Optional Bearer token for the gateway's auth. If omitted, no
   *  Authorization header is sent (matches a no-auth dev gateway). */
  bearerToken?: string;
  /** Default exec timeout (s). The gateway applies it server-side. */
  defaultTimeoutSecs?: number;
  /** Used to name the box for operator visibility — boxes named
   *  `oma-<sessionId>` are easy to spot. Optional. */
  sessionId?: string;
  /** Logger. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

export class KubernetesRemoteSandbox implements SandboxExecutor {
  private boxIdPromise: Promise<string> | null = null;
  private envVars: Record<string, string> = {};
  private logger: NonNullable<KubernetesRemoteSandboxOptions["logger"]>;

  constructor(private opts: KubernetesRemoteSandboxOptions) {
    if (!opts.baseUrl) throw new Error("KubernetesRemoteSandbox: baseUrl required");
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => moduleLogger.warn({ ...(ctx as Record<string, unknown> ?? {}) }, msg),
      log: (msg) => moduleLogger.info(msg),
    };
  }

  // ── core API ─────────────────────────────────────────────────────────

  async exec(command: string, timeout?: number): Promise<string> {
    const boxId = await this.ensureBox();
    // Run via /bin/sh -c so agent's pipe / && / && commands work unchanged.
    const startRes = await this.fetch(`/boxes/${boxId}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        command: "/bin/sh",
        args: ["-c", command],
        env: this.envVars,
        timeout_seconds: (timeout ?? this.opts.defaultTimeoutSecs ?? 600),
      }),
    });
    if (!startRes.ok) {
      throw new Error(`k8s-remote exec start failed: ${startRes.status} ${await startRes.text()}`);
    }
    const { execution_id: execId } = (await startRes.json()) as { execution_id: string };

    // Stream stdout+stderr via SSE; collect into one combined string.
    const outRes = await this.fetch(
      `/boxes/${boxId}/executions/${execId}/output`,
      { headers: { Accept: "text/event-stream" } },
    );
    if (!outRes.ok || !outRes.body) {
      throw new Error(`k8s-remote exec stream failed: ${outRes.status}`);
    }

    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    const reader = outRes.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      // Parse SSE: events separated by \n\n; fields are `event: foo\ndata: {...}`.
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseSseBlock(block);
        if (!ev) continue;
        if (ev.type === "stdout" || ev.type === "stderr") {
          const data = base64Decode(String(ev.payload.data ?? ""));
          if (ev.type === "stdout") stdout += data;
          else stderr += data;
        } else if (ev.type === "exit") {
          exitCode = (ev.payload.exit_code as number | undefined) ?? null;
        }
      }
    }

    // Match LocalSubprocess shape: "exit=N\n<stdout>\n[stderr:...]".
    let result = `exit=${exitCode ?? "?"}\n${stdout}`;
    if (stderr.trim().length > 0) result += `[stderr:${stderr}]`;
    return result;
  }

  async readFile(path: string): Promise<string> {
    const fileBytes = await this.readFileBytes(path);
    return new TextDecoder().decode(fileBytes);
  }

  async writeFile(path: string, content: string): Promise<string> {
    return this.writeFileBytes(path, new TextEncoder().encode(content));
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const boxId = await this.ensureBox();
    // Pack a 1-file tar with the relative basename, upload to dirname.
    const slash = path.lastIndexOf("/");
    const dir = slash >= 0 ? path.slice(0, slash) : "/";
    const name = slash >= 0 ? path.slice(slash + 1) : path;
    const tar = packSingleFileTar(name, bytes);
    const res = await this.fetch(
      `/boxes/${boxId}/files?path=${encodeURIComponent(dir)}&overwrite=true`,
      {
        method: "PUT",
        headers: { "content-type": "application/x-tar" },
        body: tar,
      },
    );
    if (!res.ok) {
      throw new Error(`k8s-remote writeFile ${path} failed: ${res.status} ${await res.text()}`);
    }
    return path;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    // Stored locally; merged into every exec request via env field.
    // The gateway currently re-sends env on each exec call (no per-box
    // global-env store). Cheap (small map).
    this.envVars = { ...this.envVars, ...envVars };
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const boxId = await this.ensureBox();
    const res = await this.fetch(
      `/boxes/${boxId}/files?path=${encodeURIComponent(path)}`,
      { headers: { Accept: "application/x-tar" } },
    );
    if (!res.ok) {
      throw new Error(`k8s-remote readFileBytes ${path} failed: ${res.status}`);
    }
    // The gateway returns a tar archive even for single-file reads. We
    // unpack just the first regular-file entry — sufficient for the
    // harness's read-one-file pattern.
    const tarBytes = new Uint8Array(await res.arrayBuffer());
    return extractFirstRegularFile(tarBytes);
  }

  async destroy(): Promise<void> {
    // Idempotent — DELETE on a never-created box returns 404 which we
    // treat as already-gone. Best-effort: log warnings, don't throw.
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
        this.logger.warn(`k8s-remote destroy non-OK: ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      this.logger.warn(`k8s-remote destroy error: ${(err as Error).message}`);
    } finally {
      this.boxIdPromise = null;
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private ensureBox(): Promise<string> {
    if (!this.boxIdPromise) this.boxIdPromise = this.createBox();
    return this.boxIdPromise;
  }

  private async createBox(): Promise<string> {
    const body: Record<string, unknown> = {
      image: this.opts.image ?? DEFAULT_SANDBOX_IMAGE,
    };
    if (this.opts.sessionId) body.name = `oma-${this.opts.sessionId.slice(0, 30)}`;
    if (this.opts.cpus) body.cpus = this.opts.cpus;
    if (this.opts.memoryMib) body.memory_mib = this.opts.memoryMib;
    const res = await this.fetch(`/boxes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`k8s-remote create failed: ${res.status} ${await res.text()}`);
    }
    const box = (await res.json()) as { box_id: string };
    this.logger.log(`k8s box created ${box.box_id} (${body.image})`);
    return box.box_id;
  }

  private fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}${path}`;
    const headers = new Headers(init.headers);
    if (this.opts.bearerToken && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.opts.bearerToken}`);
    }
    return globalThis.fetch(url, { ...init, headers });
  }
}

// ── tiny tar helpers (no dep) ────────────────────────────────────────

interface SseEvent {
  type: string;
  payload: Record<string, unknown>;
}

function parseSseBlock(block: string): SseEvent | null {
  let type = "message";
  let dataStr = "";
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) type = line.slice(6).trim();
    else if (line.startsWith("data:")) dataStr += line.slice(5).trim();
  }
  if (!dataStr) return null;
  try {
    return { type, payload: JSON.parse(dataStr) };
  } catch {
    return null;
  }
}

function base64Decode(s: string): string {
  // Browser-y; works in Node 22+ and in Workers (no Buffer needed).
  if (typeof Buffer !== "undefined") return Buffer.from(s, "base64").toString("utf-8");
  return atob(s);
}

/**
 * Pack a single regular file into a USTAR-format tar archive.
 * Just enough format for the gateway's PUT /files to accept it.
 */
function packSingleFileTar(name: string, content: Uint8Array): Uint8Array {
  const header = new Uint8Array(512);
  const enc = new TextEncoder();
  // name (100)
  const nameBytes = enc.encode(name).slice(0, 100);
  header.set(nameBytes, 0);
  // mode (8) — "0000644 \0"
  header.set(enc.encode("0000644 "), 100);
  // uid (8) gid (8) — "0000000 \0" each
  header.set(enc.encode("0000000 "), 108);
  header.set(enc.encode("0000000 "), 116);
  // size (12) — octal, padded with NULs, NUL-terminated
  const sizeOctal = content.length.toString(8).padStart(11, "0") + "\0";
  header.set(enc.encode(sizeOctal), 124);
  // mtime (12) — current time octal
  const mtimeOctal = Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0";
  header.set(enc.encode(mtimeOctal), 136);
  // chksum (8) — fill with spaces first, compute, then write
  for (let i = 148; i < 156; i++) header[i] = 32;
  // typeflag (1) — '0' regular file
  header[156] = 48;
  // magic (6) "ustar\0"
  header.set(enc.encode("ustar\0"), 257);
  // version (2) "00"
  header.set(enc.encode("00"), 263);
  // checksum
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  const sumOctal = sum.toString(8).padStart(6, "0") + "\0 ";
  header.set(enc.encode(sumOctal), 148);

  // Body padded to 512.
  const padded = Math.ceil(content.length / 512) * 512;
  const out = new Uint8Array(512 + padded + 1024);
  out.set(header, 0);
  out.set(content, 512);
  // Trailing 2 zero blocks already zeroed by Uint8Array default.
  return out;
}

/**
 * Extract the first regular file (typeflag '0' or '\0') from a USTAR
 * tar archive. Returns its byte content. Throws if no regular file
 * found within the first ~20 entries.
 */
function extractFirstRegularFile(tar: Uint8Array): Uint8Array {
  let off = 0;
  for (let i = 0; i < 20 && off + 512 <= tar.length; i++) {
    const header = tar.subarray(off, off + 512);
    // Empty block = end of archive.
    if (header.every((b) => b === 0)) break;
    const sizeStr = new TextDecoder().decode(header.subarray(124, 136)).trim().replace(/\0+$/, "");
    const size = parseInt(sizeStr, 8) || 0;
    const typeflag = String.fromCharCode(header[156] || 48);
    off += 512;
    if (typeflag === "0" || typeflag === "\0" || header[156] === 0) {
      return tar.subarray(off, off + size);
    }
    off += Math.ceil(size / 512) * 512;
  }
  throw new Error("k8s-remote readFile: tar archive contained no regular file");
}

// ── Factory (DIP entry point) ───────────────────────────────────────
//
// Host code (apps/agent/src/runtime/sandbox.ts on CF, apps/main-node)
// only knows the provider name → import path map and never reads
// K8S_SANDBOX_GATEWAY_URL itself. Each env var this adapter cares about is
// read here, in the adapter's own file.

export const sandboxFactory: SandboxFactory = async (ctx, env) => {
  const baseUrl = env.K8S_SANDBOX_GATEWAY_URL;
  if (!baseUrl) {
    throw new Error(
      "SANDBOX_PROVIDER=k8s-remote requires K8S_SANDBOX_GATEWAY_URL " +
        "(e.g. https://k8s-gateway.oma.internal/v1/default)",
    );
  }
  return new KubernetesRemoteSandbox({
    baseUrl,
    image: env.SANDBOX_IMAGE,
    cpus: env.K8S_SANDBOX_CPUS ? Number(env.K8S_SANDBOX_CPUS) : undefined,
    memoryMib: env.K8S_SANDBOX_MEMORY_MIB ? Number(env.K8S_SANDBOX_MEMORY_MIB) : undefined,
    bearerToken: env.K8S_SANDBOX_TOKEN,
    sessionId: ctx.sessionId,
  });
};

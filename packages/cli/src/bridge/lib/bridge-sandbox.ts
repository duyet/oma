/**
 * BridgeSandboxManager — executes relayed sandbox ops on the local machine.
 *
 * The Cloudflare deployment can't spawn `child_process` inside a Worker, so an
 * agent with a *local* environment (`sandbox_provider: "subprocess"`) has its
 * sandbox ops relayed here over the daemon WebSocket. This mirrors the
 * self-host `LocalSubprocessSandbox` (packages/sandbox) with a lean,
 * dependency-free implementation (node builtins only) so it doesn't bloat the
 * published CLI bundle.
 *
 * Protocol (see apps/agent/src/runtime/bridge-relay.ts + apps/main
 * runtime-room.ts):
 *
 *   in   { type: "sandbox.op", op, request_id, session_id, tenant_id?, ...args }
 *   out  { type: "sandbox.result", request_id, session_id, tenant_id?, ok, result?, error? }
 *
 * SECURITY: the default subprocess backend, like LocalSubprocessSandbox, has
 * ZERO process isolation — it runs on the user's host filesystem. That is the
 * whole point of a "local" environment: the user opted their own machine in
 * via `oma bridge setup`. Per-session workdirs live under <baseDir>/<sessionId>/.
 *
 * The optional `openshell` backend (explicit opt-in — see sandbox-backend.ts)
 * runs the same ops inside an OpenShell sandbox on this machine instead:
 * isolated and egress-policed, but EMPTY — none of the user's repos, tools,
 * or CLI auth are visible. Known limitations of that backend:
 *   - the relay carries no environment config (there is no `createBox` op),
 *     so OMA's env→policy mapping cannot be applied; egress is whatever
 *     default policy the gateway enforces.
 *   - a daemon crash leaks boxes on the gateway (clean shutdown destroys them).
 *   - ACP agents (lib/session-manager.ts) still spawn on the host either way;
 *     this only changes sandbox-op execution.
 */

import { spawn } from "node:child_process";
import { promises as fs, mkdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { OpenShellClient, type OpenShellClientOptions } from "./openshell-client.js";

export type SandboxSend = (msg: Record<string, unknown>) => void;

export interface SandboxOpRequest {
  type?: string;
  op?: string;
  request_id?: string;
  session_id?: string;
  tenant_id?: string;
  command?: string;
  timeout?: number;
  path?: string;
  content?: string;
  base64?: string;
  envVars?: Record<string, string>;
}

/**
 * The executor surface behind ONE relayed session. All 8 relay ops — do not
 * trim this down to the k8s-bridge's `BoxExecutor` (5 ops): dropping
 * readFileBytes/writeFileBytes would silently break binary file relay.
 */
export interface RelaySandboxExecutor {
  exec(command: string, timeoutMs: number): Promise<string>;
  readFile(path: string): Promise<string>;
  readFileBytes(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  writeFileBytes(path: string, bytes: Uint8Array): Promise<void>;
  setEnvVars(envVars: Record<string, string>): Promise<void>;
  ping(): Promise<void>;
  destroy(): Promise<void>;
}

/** Mints one executor per relayed session. */
export interface RelaySandboxBackend {
  kind: string;
  create(sessionId: string): RelaySandboxExecutor;
}

const DEFAULT_TIMEOUT_MS = 120_000;
/** Bound on how long daemon shutdown waits for remote box teardown. */
const DESTROY_ALL_TIMEOUT_MS = 10_000;

export function defaultSandboxBaseDir(): string {
  // XDG-ish location under the user's home, isolated from bridge config state.
  return join(homedir(), ".local", "share", "oma", "sandboxes");
}

export class BridgeSandboxManager {
  #send: SandboxSend;
  #backend: RelaySandboxBackend;
  #boxes = new Map<string, RelaySandboxExecutor>();

  constructor(send: SandboxSend, opts?: { baseDir?: string; backend?: RelaySandboxBackend }) {
    this.#send = send;
    this.#backend = opts?.backend ?? createSubprocessBackend(opts?.baseDir);
  }

  /** Which backend is executing ops — surfaced by `oma bridge status`. */
  get backendKind(): string {
    return this.#backend.kind;
  }

  /** Re-point the sender after a WS reconnect (mirrors SessionManager.setSender). */
  setSend(send: SandboxSend): void {
    this.#send = send;
    // Boxes deliberately survive a reconnect — a network blip must not wipe a
    // session's workspace (subprocess) or tear down its sandbox (openshell).
  }

  /** Handle one relayed op frame: execute locally, then send the result. */
  async handle(req: SandboxOpRequest): Promise<void> {
    const requestId = req.request_id;
    const sessionId = req.session_id;
    if (!requestId || !sessionId) return; // malformed — nothing to correlate
    try {
      const result = await this.#exec(sessionId, req);
      this.#reply(req, { ok: true, result });
    } catch (err) {
      this.#reply(req, { ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Best-effort teardown of every session box. Called on daemon stop.
   * Awaits the destroys (openshell's is an async gRPC DeleteSandbox) under a
   * bounded timeout so a hung gateway can't block shutdown past launchd's
   * ExitTimeOut — a slow gateway leaks its own boxes rather than wedging us.
   */
  async destroyAll(): Promise<void> {
    const boxes = [...this.#boxes.values()];
    this.#boxes.clear();
    if (boxes.length === 0) return;
    await Promise.race([
      Promise.allSettled(boxes.map((b) => b.destroy())),
      new Promise((r) => setTimeout(r, DESTROY_ALL_TIMEOUT_MS)),
    ]);
  }

  // ── op dispatch ──────────────────────────────────────────────────────────

  async #exec(sessionId: string, req: SandboxOpRequest): Promise<Record<string, unknown>> {
    const box = this.#ensureBox(sessionId);
    switch (req.op) {
      case "exec": {
        // Always an explicit ms timeout — OpenShellClient.exec requires one.
        const output = await box.exec(req.command ?? "", req.timeout ?? DEFAULT_TIMEOUT_MS);
        return { output };
      }
      case "readFile": {
        const content = await box.readFile(req.path ?? "");
        return { content };
      }
      case "readFileBytes": {
        const bytes = await box.readFileBytes(req.path ?? "");
        return { base64: Buffer.from(bytes).toString("base64") };
      }
      case "writeFile": {
        await box.writeFile(req.path ?? "", req.content ?? "");
        return {};
      }
      case "writeFileBytes": {
        await box.writeFileBytes(req.path ?? "", new Uint8Array(Buffer.from(req.base64 ?? "", "base64")));
        return {};
      }
      case "setEnvVars": {
        await box.setEnvVars(req.envVars ?? {});
        return {};
      }
      case "ping": {
        await box.ping();
        return {};
      }
      case "destroy": {
        this.#boxes.delete(sessionId);
        await box.destroy();
        return {};
      }
      default:
        throw new Error(`unknown sandbox op "${req.op}"`);
    }
  }

  #ensureBox(sessionId: string): RelaySandboxExecutor {
    let box = this.#boxes.get(sessionId);
    if (!box) {
      box = this.#backend.create(sessionId);
      this.#boxes.set(sessionId, box);
    }
    return box;
  }

  #reply(req: SandboxOpRequest, payload: { ok: boolean; result?: Record<string, unknown>; error?: string }): void {
    const msg: Record<string, unknown> = {
      type: "sandbox.result",
      request_id: req.request_id,
      session_id: req.session_id,
      ok: payload.ok,
    };
    if (req.tenant_id) msg.tenant_id = req.tenant_id;
    if (payload.result !== undefined) msg.result = payload.result;
    if (payload.error !== undefined) msg.error = payload.error;
    try {
      this.#send(msg);
    } catch { /* socket died; relay op will time out */ }
  }
}

// ── subprocess backend (default) ───────────────────────────────────────────

export function createSubprocessBackend(baseDirOpt?: string): RelaySandboxBackend {
  const baseDir = baseDirOpt ? resolve(baseDirOpt) : defaultSandboxBaseDir();
  return {
    kind: "subprocess",
    create: (sessionId) => new SubprocessSandbox(join(baseDir, sanitizeSessionId(sessionId))),
  };
}

class SubprocessSandbox implements RelaySandboxExecutor {
  #workdir: string;
  #envVars: Record<string, string> = {};

  constructor(workdir: string) {
    this.#workdir = workdir;
    mkdirSync(workdir, { recursive: true });
  }

  exec(command: string, timeoutMs: number): Promise<string> {
    const workdir = this.#workdir;
    const envVars = this.#envVars;
    return new Promise<string>((resolveExec) => {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: workdir,
        env: { ...(process.env as Record<string, string>), ...envVars, PWD: workdir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf8"); });
      child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf8"); });

      const killer = setTimeout(() => {
        try {
          child.kill("SIGTERM");
          setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } }, 1_000);
        } catch { /* gone */ }
      }, timeoutMs);

      child.on("close", (code, signal) => {
        clearTimeout(killer);
        const exit = signal ? `signal=${signal}` : `exit=${code}`;
        const combined =
          (stdout + (stderr ? `\n${stderr}` : "")).replace(/\s+$/, "") +
          (code !== 0 ? `\n[exit ${exit}]` : "");
        resolveExec(combined);
      });
      child.on("error", (err) => {
        clearTimeout(killer);
        resolveExec(`[error: ${err.message}]`);
      });
    });
  }

  async readFile(path: string): Promise<string> {
    return fs.readFile(this.#resolvePath(path), "utf8");
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    return new Uint8Array(await fs.readFile(this.#resolvePath(path)));
  }

  async writeFile(path: string, content: string): Promise<void> {
    const full = this.#resolvePath(path);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, content, "utf8");
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
    const full = this.#resolvePath(path);
    await fs.mkdir(dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.from(bytes));
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.#envVars = { ...this.#envVars, ...envVars };
  }

  async ping(): Promise<void> {
    /* the host is always reachable */
  }

  async destroy(): Promise<void> {
    try {
      rmSync(this.#workdir, { recursive: true, force: true });
    } catch { /* best-effort */ }
  }

  /**
   * Resolve a sandbox-relative path into the session workdir. The harness emits
   * `/workspace/...` conventions; rewrite that to the workdir root so tools
   * land somewhere real. Absolute paths outside /workspace are the caller's
   * responsibility (mirrors LocalSubprocessSandbox).
   */
  #resolvePath(p: string): string {
    let normalised = p;
    if (normalised.startsWith("/workspace/")) normalised = normalised.slice("/workspace/".length);
    else if (normalised === "/workspace") normalised = "";
    else if (isAbsolute(normalised)) return normalised;
    return join(this.#workdir, normalised);
  }
}

// ── openshell backend (opt-in) ─────────────────────────────────────────────

/**
 * One OpenShell box per relayed session.
 *
 * Paths are passed through VERBATIM — no `/workspace` rewriting. Inside a box
 * `/workspace` is a real container path, unlike the subprocess backend where
 * it has to be mapped onto a host workdir.
 *
 * Exec output is passed through verbatim too: OpenShell returns
 * `exit=N\n<stdout>` where the subprocess backend returns combined output plus
 * `[exit …]`. The other bridge consumers (boxrun, k8s-bridge) already speak the
 * `exit=N` shape, so normalising it here would break their `parseExecResult`.
 */
export function createOpenShellBackend(
  opts: Omit<OpenShellClientOptions, "sessionId">,
): RelaySandboxBackend {
  return {
    kind: "openshell",
    create: (sessionId) => new OpenShellClient({ ...opts, sessionId }),
  };
}

function sanitizeSessionId(sid: string): string {
  return sid.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 128) || "session";
}

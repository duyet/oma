/**
 * BridgeRelaySandbox — a SandboxExecutor that relays sandbox operations to a
 * user-paired local machine (the `oma bridge daemon`) over the RuntimeRoom
 * Durable Object's WebSocket.
 *
 * This is the SANDBOX sibling of AcpProxyHarness's AGENT relay. An agent on
 * the Cloudflare deployment configured with a *local* environment
 * (`sandbox_provider: "subprocess"` / `"local"`) can't run `child_process`
 * inside a Worker — so instead of hard-failing, we forward each sandbox op
 * (exec, read/write files, setEnvVars, destroy) to the daemon, which executes
 * it locally exactly like the self-host `LocalSubprocessSandbox` does, and
 * returns the result over the same socket.
 *
 * Wire protocol (all frames are JSON objects with a `type` field):
 *
 *   relay → daemon   { type: "sandbox.op", op, request_id, session_id, tenant_id?, ...args }
 *   daemon → relay   { type: "sandbox.result", request_id, session_id, ok, result?, error? }
 *
 * Correlation is by `request_id` (monotonic per instance). The RuntimeRoom DO
 * forwards `sandbox.*` frames between the relay's harness-style WS (tagged
 * `sandbox:<sid>`) and the daemon WS, injecting `tenant_id` from the session
 * pin — the same mechanics the ACP `session.*` path already uses.
 *
 * Runtime selection: the tenant's most-recently-heartbeated online runtime
 * (`runtimes` JOIN `runtime_tenants`). When none is online we throw
 * SandboxProviderUnavailableError with a clear "run bridge setup" message —
 * fail loud, never silently substitute a different sandbox.
 *
 * NOTE ON CREDENTIALS: unlike CloudflareSandbox, there is no outbound MITM
 * proxy on the user's machine, so `setOutboundContext` is a no-op here — the
 * agent's outbound HTTP from the local box is not vault-injected. Documented
 * in docs/runtimes.md.
 */

import type { SandboxExecutor, ProcessHandle } from "../harness/interface";
import type { Env } from "@duyet/oma-shared";
import { SandboxProviderUnavailableError } from "./sandbox";

/** How recently a runtime must have heartbeated to be considered online.
 *  Matches the daemon's 25s heartbeat with generous slack for isolate/network
 *  hiccups. */
const RUNTIME_ONLINE_WINDOW_SEC = 120;

/** Default per-op reply timeout (ms). exec overrides with command timeout. */
const DEFAULT_OP_TIMEOUT_MS = 30_000;

const NO_RUNTIME_MESSAGE =
  "no bridge runtime connected — run `npx @getoma/cli bridge setup` on your " +
  "machine and start the daemon (`oma bridge daemon`) so this local " +
  "environment can execute there.";

interface AttachedWs {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    event: "message" | "close" | "error",
    listener: (event: MessageEvent | CloseEvent | Event) => void,
  ): void;
}

interface SandboxResult {
  request_id?: string;
  ok?: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

interface PendingCall {
  resolve: (result: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Pick the tenant's most-recently-heartbeated online runtime id of a given
 * `kind`, or null when none is online. `kind` filters by `runtimes.kind`
 * (`"daemon"` for a paired local machine, `"browser-vm"` for a browser tab
 * hosting a WASM VM) so a browser-vm session never relays to a daemon and
 * vice versa. Exported for unit testing the selection query independent of
 * the WebSocket machinery.
 */
export async function pickOnlineRuntimeId(
  db: Env["MAIN_DB"],
  tenantId: string,
  kind: string = "daemon",
): Promise<string | null> {
  const { results } = await db
    .prepare(
      `SELECT r.id AS id
       FROM "runtimes" r
       JOIN "runtime_tenants" rt ON rt.runtime_id = r.id
       WHERE rt.tenant_id = ?
         AND rt.revoked_at IS NULL
         AND r.status = 'online'
         AND r.kind = ?
         AND r.last_heartbeat IS NOT NULL
         AND r.last_heartbeat > (unixepoch() - ?)
       ORDER BY r.last_heartbeat DESC
       LIMIT 1`,
    )
    .bind(tenantId, kind, RUNTIME_ONLINE_WINDOW_SEC)
    .all<{ id: string }>();
  return results?.[0]?.id ?? null;
}

export class BridgeRelaySandbox implements SandboxExecutor {
  #env: Env;
  #sessionId: string;
  #tenantId: string;
  #connectPromise: Promise<AttachedWs> | null = null;
  #ws: AttachedWs | null = null;
  #pending = new Map<string, PendingCall>();
  #reqSeq = 0;
  #runtimeId = "";

  constructor(env: Env, sessionId: string, tenantId: string | undefined) {
    this.#env = env;
    this.#sessionId = sessionId;
    this.#tenantId = tenantId ?? "";
  }

  // ── SandboxExecutor surface ────────────────────────────────────────────

  async exec(command: string, timeout?: number): Promise<string> {
    const timeoutMs = timeout ?? 120_000;
    const r = await this.#call("exec", { command, timeout: timeoutMs }, timeoutMs + 15_000);
    return typeof r.output === "string" ? r.output : "";
  }

  async readFile(path: string): Promise<string> {
    const r = await this.#call("readFile", { path });
    return typeof r.content === "string" ? r.content : "";
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const r = await this.#call("readFileBytes", { path });
    return b64ToBytes(typeof r.base64 === "string" ? r.base64 : "");
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.#call("writeFile", { path, content });
    return "ok";
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    await this.#call("writeFileBytes", { path, base64: bytesToB64(bytes) });
    return "ok";
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    await this.#call("setEnvVars", { envVars });
  }

  /** No outbound MITM proxy on the user's machine — see file header. */
  async setOutboundContext(_opts: { tenantId: string; sessionId: string }): Promise<void> {
    /* no-op */
  }

  async startProcess(_command: string): Promise<ProcessHandle | null> {
    // Background processes aren't relayed — the harness falls back to exec.
    return null;
  }

  async ping(): Promise<{ status: "ok" | "error"; latencyMs: number; details?: string }> {
    const start = Date.now();
    try {
      await this.#call("ping", {}, 10_000);
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
    try {
      await this.#call("destroy", {}, 10_000);
    } catch {
      /* best-effort — box may already be gone */
    }
    this.#rejectAll(new Error("sandbox destroyed"));
    try {
      this.#ws?.close(1000, "destroy");
    } catch {
      /* already closed */
    }
    this.#ws = null;
    this.#connectPromise = null;
  }

  // ── relay plumbing ─────────────────────────────────────────────────────

  async #call(
    op: string,
    args: Record<string, unknown>,
    timeoutMs = DEFAULT_OP_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    const ws = await this.#connect();
    const requestId = `sbx_${++this.#reqSeq}_${Date.now()}`;
    const frame = {
      type: "sandbox.op",
      op,
      request_id: requestId,
      session_id: this.#sessionId,
      ...args,
    };
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new Error(`bridge sandbox op "${op}" timed out after ${timeoutMs}ms (runtime ${this.#runtimeId})`));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
      try {
        ws.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  #connect(): Promise<AttachedWs> {
    if (this.#ws) return Promise.resolve(this.#ws);
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#doConnect().catch((err) => {
      // Reset so a later op can retry (e.g. daemon reconnects between turns).
      this.#connectPromise = null;
      throw err;
    });
    return this.#connectPromise;
  }

  async #doConnect(): Promise<AttachedWs> {
    if (!this.#tenantId) {
      throw new SandboxProviderUnavailableError(NO_RUNTIME_MESSAGE);
    }
    const env = this.#env as unknown as {
      MAIN_DB?: Env["MAIN_DB"];
      RUNTIME_ROOM?: DurableObjectNamespace;
    };
    if (!env.MAIN_DB || !env.RUNTIME_ROOM) {
      throw new SandboxProviderUnavailableError(
        "local (bridge) environments require the MAIN_DB and RUNTIME_ROOM bindings on the agent worker",
      );
    }

    const runtimeId = await pickOnlineRuntimeId(env.MAIN_DB, this.#tenantId);
    if (!runtimeId) throw new SandboxProviderUnavailableError(NO_RUNTIME_MESSAGE);
    this.#runtimeId = runtimeId;

    const ws = await this.#openSandboxWs(env.RUNTIME_ROOM, runtimeId);
    if (!ws) throw new SandboxProviderUnavailableError(NO_RUNTIME_MESSAGE);

    // The DO's synthetic handshake reports whether the daemon socket is live.
    const attached = await waitForFrame(ws, (m) => m.type === "attached", 5_000).catch(() => null);
    if (!attached || attached.daemon_online === false) {
      try {
        ws.close(1000, "daemon offline");
      } catch {
        /* ignore */
      }
      throw new SandboxProviderUnavailableError(
        `bridge runtime ${runtimeId} is registered but its daemon socket is not attached — ${NO_RUNTIME_MESSAGE}`,
      );
    }

    ws.addEventListener("message", (ev) => this.#onMessage(ev));
    ws.addEventListener("close", () => this.#onDisconnect(new Error("bridge runtime WS closed")));
    ws.addEventListener("error", () => this.#onDisconnect(new Error("bridge runtime WS error")));

    this.#ws = ws;
    return ws;
  }

  #onMessage(ev: MessageEvent | CloseEvent | Event): void {
    const data = (ev as MessageEvent).data;
    if (typeof data !== "string") return;
    let parsed: SandboxResult & { type?: string };
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (parsed.type !== "sandbox.result") return;
    const requestId = parsed.request_id;
    if (!requestId) return;
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    this.#pending.delete(requestId);
    clearTimeout(pending.timer);
    if (parsed.ok) {
      pending.resolve(parsed.result ?? {});
    } else {
      pending.reject(new Error(parsed.error ?? "bridge sandbox op failed"));
    }
  }

  #onDisconnect(err: Error): void {
    this.#ws = null;
    this.#connectPromise = null;
    this.#rejectAll(err);
  }

  #rejectAll(err: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }

  async #openSandboxWs(
    runtimeRoom: DurableObjectNamespace,
    runtimeId: string,
  ): Promise<AttachedWs | null> {
    try {
      const stub = runtimeRoom.get(runtimeRoom.idFromName(runtimeId));
      const headers: Record<string, string> = {
        Upgrade: "websocket",
        "x-attach-role": "sandbox",
        "x-session-id": this.#sessionId,
      };
      if (this.#tenantId) headers["x-harness-tenant"] = this.#tenantId;
      const res = await stub.fetch(
        new Request("http://runtime-room/_attach_sandbox", { headers }),
      );
      if (res.status !== 101 || !res.webSocket) return null;
      res.webSocket.accept();
      return res.webSocket as unknown as AttachedWs;
    } catch {
      return null;
    }
  }
}

interface ParsedFrame {
  type?: string;
  daemon_online?: boolean;
  [k: string]: unknown;
}

function waitForFrame(
  ws: AttachedWs,
  pred: (msg: ParsedFrame) => boolean,
  timeoutMs: number,
): Promise<ParsedFrame> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for frame (${timeoutMs}ms)`)), timeoutMs);
    const onMessage = (ev: MessageEvent | CloseEvent | Event) => {
      const data = (ev as MessageEvent).data;
      if (typeof data !== "string") return;
      let parsed: ParsedFrame;
      try {
        parsed = JSON.parse(data);
      } catch {
        return;
      }
      if (!pred(parsed)) return;
      clearTimeout(timer);
      resolve(parsed);
    };
    const onClose = () => {
      clearTimeout(timer);
      reject(new Error("WS closed while waiting for frame"));
    };
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
  });
}

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK) as unknown as number[]);
  }
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

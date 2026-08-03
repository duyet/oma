/**
 * BrowserVmRelaySandbox — a SandboxExecutor that relays sandbox operations to
 * a browser tab hosting a WASM VM (WebContainers / CheerpX) over the
 * RuntimeRoom Durable Object's WebSocket.
 *
 * This is the browser-tab twin of BridgeRelaySandbox
 * (apps/agent/src/runtime/bridge-relay.ts): instead of forwarding each op to a
 * paired `oma bridge daemon` process, a `browser-vm` environment forwards it
 * to a browser tab that runs the agent's shell commands entirely client-side.
 * Neither the OMA worker nor any server ever executes them. The tab attaches
 * to the RuntimeRoom with role "daemon" (the sandbox relay path is
 * peer-agnostic — the DO needs no routing changes to carry a browser peer).
 *
 * Wire protocol (frozen, shared with BrowserVmSandbox / bridge-relay):
 *
 *   relay → tab   { type: "sandbox.op", op, request_id, session_id, ...args }
 *   tab → relay   { type: "sandbox.result", request_id, ok, result?, error? }
 *
 * The frame plumbing + correlation lives in BrowserVmSandbox (frozen adapter in
 * @getoma/sandbox-sdk/adapters/browser-vm). This file's job is purely the
 * transport: pick the tenant's online browser-vm runtime, open the RuntimeRoom
 * sandbox WS, complete the `attached` handshake, wrap the live socket in a
 * BrowserVmTransport, and construct the inner adapter against it. All
 * SandboxExecutor methods delegate to that inner adapter.
 *
 * Runtime selection: the tenant's most-recently-heartbeated online runtime of
 * kind `browser-vm` (`pickOnlineRuntimeId(db, tenantId, "browser-vm")`). When
 * none is online we throw SandboxProviderUnavailableError with a clear "open
 * your sandbox tab" message — fail loud, never silently substitute a different
 * sandbox.
 *
 * NOTE ON CREDENTIALS: like the bridge relay, there is no outbound MITM proxy
 * on the browser tab, so `setOutboundContext` is a no-op — outbound HTTP from
 * the tab is not vault-injected yet.
 */

import type { SandboxExecutor, ProcessHandle } from "../harness/interface";
import type { Env } from "@duyet/oma-shared";
import {
  BrowserVmSandbox,
  type BrowserVmTransport,
} from "@getoma/sandbox-sdk/adapters/browser-vm";
import { pickOnlineRuntimeId } from "./bridge-relay";
import { SandboxProviderUnavailableError } from "./sandbox";

/**
 * How long a connect waits for a browser-vm tab to come online before
 * failing. The Console opens the tab from the send-message click handler, so
 * a fresh session normally races a tab that is still pairing and booting its
 * WASM VM; without this window every such turn would fail on the spot. Kept
 * short enough that a genuinely absent tab still fails loudly and visibly.
 */
const WAIT_FOR_TAB_MS = 45_000;
const WAIT_POLL_MS = 1_500;

const NO_TAB_MESSAGE =
  "no browser sandbox tab connected — open your workspace's sandbox tab from " +
  "the Console so this browser-vm environment can execute there.";

interface AttachedWs {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    event: "message" | "close" | "error",
    listener: (event: MessageEvent | CloseEvent | Event) => void,
  ): void;
}

/**
 * Adapts the live RuntimeRoom WebSocket to BrowserVmSandbox's injectable
 * transport seam. BrowserVmSandbox registers exactly one message handler in
 * its constructor; we forward every string frame from the socket to it.
 */
class RuntimeRoomTransport implements BrowserVmTransport {
  #ws: AttachedWs;
  #handler: ((frame: string) => void) | null = null;

  constructor(ws: AttachedWs) {
    this.#ws = ws;
    this.#ws.addEventListener("message", (ev) => {
      const data = (ev as MessageEvent).data;
      if (typeof data === "string" && this.#handler) this.#handler(data);
    });
  }

  send(frame: string): void {
    this.#ws.send(frame);
  }

  onMessage(handler: (frame: string) => void): void {
    this.#handler = handler;
  }

  close(): void {
    try {
      this.#ws.close(1000, "browser-vm relay close");
    } catch {
      /* already closed */
    }
  }
}

export class BrowserVmRelaySandbox implements SandboxExecutor {
  #env: Env;
  #sessionId: string;
  #tenantId: string;
  #connectPromise: Promise<BrowserVmSandbox> | null = null;
  #sandbox: BrowserVmSandbox | null = null;
  #ws: AttachedWs | null = null;
  #runtimeId = "";
  #waitForTabMs: number;
  #closed = false;

  constructor(
    env: Env,
    sessionId: string,
    tenantId: string | undefined,
    waitForTabMs = WAIT_FOR_TAB_MS,
  ) {
    this.#env = env;
    this.#sessionId = sessionId;
    this.#tenantId = tenantId ?? "";
    this.#waitForTabMs = waitForTabMs;
  }

  // ── SandboxExecutor surface (delegates to the inner adapter) ────────────

  async exec(command: string, timeout?: number): Promise<string> {
    const sandbox = await this.#connect();
    return sandbox.exec(command, timeout);
  }

  async readFile(path: string): Promise<string> {
    const sandbox = await this.#connect();
    return sandbox.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<string> {
    const sandbox = await this.#connect();
    return sandbox.writeFile(path, content);
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    const sandbox = await this.#connect();
    await sandbox.setEnvVars(envVars);
  }

  /** No outbound MITM proxy on the browser tab — see file header. */
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
      const sandbox = await this.#connect();
      return await sandbox.ping();
    } catch (err) {
      return {
        status: "error",
        latencyMs: Date.now() - start,
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async destroy(): Promise<void> {
    // Stop any in-flight wait-for-tab poll immediately — teardown must not
    // sit out the full window waiting for a tab nobody is going to open.
    this.#closed = true;
    // Join a connect that's still in flight. Dropping the promise instead
    // would let it finish after us and leave an orphaned RuntimeRoom socket
    // open with nobody holding a reference to close it. Bounded by the 5s
    // handshake timeout inside #doConnect.
    if (this.#connectPromise) {
      await this.#connectPromise.catch(() => null);
    }
    // Only destroy an already-live tab — never connect just to tear down.
    const sandbox = this.#sandbox;
    this.#sandbox = null;
    this.#connectPromise = null;
    this.#ws = null;
    if (!sandbox) return;
    try {
      await sandbox.destroy();
    } catch {
      /* best-effort — tab may already be gone */
    }
  }

  // ── relay plumbing ─────────────────────────────────────────────────────

  #connect(): Promise<BrowserVmSandbox> {
    if (this.#sandbox) return Promise.resolve(this.#sandbox);
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#doConnect().catch((err) => {
      // Reset so a later op can retry (e.g. the tab reconnects between turns).
      this.#connectPromise = null;
      throw err;
    });
    return this.#connectPromise;
  }

  async #doConnect(): Promise<BrowserVmSandbox> {
    if (!this.#tenantId) {
      throw new SandboxProviderUnavailableError(NO_TAB_MESSAGE);
    }
    const env = this.#env as unknown as {
      MAIN_DB?: Env["MAIN_DB"];
      RUNTIME_ROOM?: DurableObjectNamespace;
    };
    if (!env.MAIN_DB || !env.RUNTIME_ROOM) {
      throw new SandboxProviderUnavailableError(
        "browser-vm environments require the MAIN_DB and RUNTIME_ROOM bindings on the agent worker",
      );
    }

    const runtimeId = await this.#waitForRuntimeId(env.MAIN_DB);
    if (!runtimeId) throw new SandboxProviderUnavailableError(NO_TAB_MESSAGE);
    this.#runtimeId = runtimeId;

    const ws = await this.#openSandboxWs(env.RUNTIME_ROOM, runtimeId);
    if (!ws) throw new SandboxProviderUnavailableError(NO_TAB_MESSAGE);

    // The DO's synthetic handshake reports whether the tab socket is live.
    const attached = await waitForFrame(ws, (m) => m.type === "attached", 5_000).catch(() => null);
    if (!attached || attached.daemon_online === false) {
      try {
        ws.close(1000, "tab offline");
      } catch {
        /* ignore */
      }
      throw new SandboxProviderUnavailableError(
        `browser-vm runtime ${runtimeId} is registered but its tab socket is not attached — ${NO_TAB_MESSAGE}`,
      );
    }

    // Drop the inner sandbox + connect promise on close/error so the next op
    // reconnects, and fail whatever was in flight — a tab that goes away
    // mid-op can never answer, so waiting out the per-op timeout would just
    // stall the turn (up to exec's timeout + 15s).
    ws.addEventListener("close", () => this.#onDisconnect(new Error("browser-vm tab WS closed")));
    ws.addEventListener("error", () => this.#onDisconnect(new Error("browser-vm tab WS error")));

    const transport = new RuntimeRoomTransport(ws);
    const sandbox = new BrowserVmSandbox({ transport, sessionId: this.#sessionId });
    this.#ws = ws;
    this.#sandbox = sandbox;
    return sandbox;
  }

  /**
   * Poll for an online browser-vm runtime, up to `waitForTabMs`. The first
   * lookup is immediate, so a tab that is already paired costs nothing extra.
   * Aborts as soon as `destroy()` is called so teardown never blocks on a
   * tab that is never going to show up.
   */
  async #waitForRuntimeId(db: NonNullable<Env["MAIN_DB"]>): Promise<string | null> {
    const deadline = Date.now() + this.#waitForTabMs;
    for (;;) {
      const id = await pickOnlineRuntimeId(db, this.#tenantId, "browser-vm");
      if (id) return id;
      if (this.#closed || Date.now() + WAIT_POLL_MS > deadline) return null;
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
      if (this.#closed) return null;
    }
  }

  #onDisconnect(err: Error): void {
    const sandbox = this.#sandbox;
    this.#ws = null;
    this.#sandbox = null;
    this.#connectPromise = null;
    sandbox?.rejectPending(err);
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

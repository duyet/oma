// BrowserVmSandbox — relay adapter for a WASM VM running inside a user's
// browser tab (WebContainers / CheerpX).
//
// This is the browser-side sibling of BridgeRelaySandbox
// (apps/agent/src/runtime/bridge-relay.ts): instead of relaying sandbox ops
// to a local `oma bridge daemon` process over the RuntimeRoom WebSocket, a
// "browser-vm" environment relays them to a browser tab that hosts a WASM
// VM. Neither the OMA worker nor any server ever runs the agent's shell
// commands — the tab does, entirely client-side.
//
// The transport (real WebSocket wiring to the RuntimeRoom Durable Object) is
// only available inside apps/agent, which this package doesn't depend on.
// So this file defines a small `BrowserVmTransport` seam the adapter is
// built against, and the runtime injects a concrete transport when it
// constructs `BrowserVmSandbox` directly. The standalone `sandboxFactory`
// export exists only to satisfy the SandboxFactory contract (and the
// registry's factoryPath lookup) — it always throws, because the registry
// has no way to hand it a live transport. Same shape as how "subprocess" is
// bridge-resolved outside the registry on the Cloudflare deployment.
//
// Wire protocol (all frames are JSON objects with a `type` field), matching
// bridge-relay.ts's sandbox.* convention:
//
//   relay → tab   { type: "sandbox.op", op, request_id, session_id, ...args }
//   tab → relay   { type: "sandbox.result", request_id, ok, result?, error? }
//
// Correlation is by `request_id` — a monotonic per-instance counter, never
// Date.now() (concurrent calls in the same millisecond would collide).

import type { SandboxExecutor, SandboxFactory } from "../ports";
import { getLogger } from "@duyet/oma-observability";

const moduleLogger = getLogger("browser-vm-sandbox");

/** Default per-op reply timeout (ms). exec overrides with its own timeout. */
const DEFAULT_OP_TIMEOUT_MS = 120_000;

/**
 * Injectable message transport so BrowserVmSandbox is unit-testable without
 * a real WebSocket/RuntimeRoom. The agent runtime supplies a concrete
 * implementation wrapping the attached RuntimeRoom socket; tests supply a
 * MockTransport.
 */
export interface BrowserVmTransport {
  send(frame: string): void;
  onMessage(handler: (frame: string) => void): void;
  close?(): void;
}

export interface BrowserVmSandboxOptions {
  transport: BrowserVmTransport;
  sessionId: string;
  /** Default per-op reply timeout (ms). Default 120000. */
  defaultTimeoutMs?: number;
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

interface SandboxResultFrame {
  type?: string;
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

export class BrowserVmSandbox implements SandboxExecutor {
  #transport: BrowserVmTransport;
  #sessionId: string;
  #defaultTimeoutMs: number;
  #logger: NonNullable<BrowserVmSandboxOptions["logger"]>;
  #reqSeq = 0;
  #pending = new Map<string, PendingCall>();
  #envVars: Record<string, string> = {};

  constructor(opts: BrowserVmSandboxOptions) {
    this.#transport = opts.transport;
    this.#sessionId = opts.sessionId;
    this.#defaultTimeoutMs = opts.defaultTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS;
    this.#logger = opts.logger ?? {
      warn: (msg, ctx) => moduleLogger.warn({ ...(ctx as Record<string, unknown> ?? {}) }, msg),
      log: (msg) => moduleLogger.info(msg),
    };
    this.#transport.onMessage((frame) => this.#onMessage(frame));
  }

  // ── SandboxExecutor surface ────────────────────────────────────────────

  async exec(command: string, timeout?: number): Promise<string> {
    const timeoutMs = timeout ?? this.#defaultTimeoutMs;
    // timeout_seconds is the in-VM command budget; the pending-call timer
    // gets extra slack for the host's post-exec output collection round
    // trips (mirrors bridge-relay's `timeoutMs + 15_000`).
    const r = await this.#call(
      "exec",
      { command, timeout_seconds: Math.ceil(timeoutMs / 1000) },
      timeoutMs + 15_000,
    );
    const stdout = typeof r.stdout === "string" ? r.stdout : "";
    const stderr = typeof r.stderr === "string" ? r.stderr : "";
    const exitCode = typeof r.exit_code === "number" || typeof r.exit_code === "string"
      ? r.exit_code
      : "?";
    // Match boxrun/bridge-relay's return shape: "exit=N\n<stdout>[stderr:...]".
    let result = `exit=${exitCode}\n${stdout}`;
    if (stderr.trim().length > 0) result += `[stderr:${stderr}]`;
    return result;
  }

  async readFile(path: string): Promise<string> {
    const r = await this.#call("readFile", { path });
    return typeof r.content === "string" ? r.content : "";
  }

  async writeFile(path: string, content: string): Promise<string> {
    await this.#call("writeFile", { path, content });
    return path;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    await this.#call("setEnvVars", { envVars });
    this.#envVars = { ...this.#envVars, ...envVars };
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

  async destroy(): Promise<void> {
    try {
      await this.#call("destroy", {}, 10_000);
    } catch (err) {
      this.#logger.warn(`browser-vm destroy error: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      this.#transport.close?.();
    } catch {
      /* already closed */
    }
    // Any op still in flight can never be answered once the transport is
    // closed — fail them now instead of letting each wait out its own
    // timeout. Mirrors BridgeRelaySandbox's #rejectAll on destroy.
    this.rejectPending(new Error("browser-vm sandbox destroyed"));
  }

  /**
   * Fail every in-flight op. The transport owner calls this when the
   * underlying socket drops: the tab can never answer a request sent over a
   * dead socket, and without this each pending call sits until its own
   * timeout fires (up to `exec`'s timeout + 15s), stalling the turn.
   * Mirrors BridgeRelaySandbox's #rejectAll on disconnect.
   */
  rejectPending(err: Error): void {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.#pending.clear();
  }

  // ── relay plumbing ─────────────────────────────────────────────────────

  #call(
    op: string,
    args: Record<string, unknown>,
    timeoutMs = this.#defaultTimeoutMs,
  ): Promise<Record<string, unknown>> {
    const requestId = `req_${++this.#reqSeq}`;
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
        reject(new Error(`browser-vm sandbox op "${op}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
      try {
        this.#transport.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  #onMessage(frame: string): void {
    let parsed: SandboxResultFrame;
    try {
      parsed = JSON.parse(frame);
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
      pending.reject(new Error(parsed.error ?? "browser-vm sandbox op failed"));
    }
  }
}

// ── Factory (DIP entry point) ───────────────────────────────────────
//
// Unlike every other adapter's factory, this one cannot construct a working
// BrowserVmSandbox: the real transport is a WebSocket attached to the
// RuntimeRoom Durable Object, which only apps/agent knows how to open (this
// package has no cloudflare:workers dependency). The agent runtime
// constructs `BrowserVmSandbox` directly with a live transport instead of
// going through this factory / the standalone registry.

export const sandboxFactory: SandboxFactory = async () => {
  throw new Error(
    "browser-vm sandbox requires a RuntimeRoom relay transport — resolved by the agent runtime, not the standalone registry",
  );
};

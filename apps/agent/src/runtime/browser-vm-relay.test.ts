// Unit tests for BrowserVmRelaySandbox — the relay-backed SandboxExecutor that
// forwards sandbox ops to a browser tab hosting a WASM VM over the RuntimeRoom
// Durable Object WebSocket. Covers: kind-filtered runtime selection (a
// `daemon` runtime must NOT satisfy a browser-vm session and vice versa), the
// no-tab-online error, the attached/daemon_online handshake, an exec
// round-trip asserting the frozen browser-vm frame shape, and the per-op
// timeout path. Runs in the Workers pool so `WebSocketPair` is real.

import { describe, it, expect, afterEach, vi } from "vitest";
import type { Env } from "@duyet/oma-shared";
import { BrowserVmRelaySandbox } from "./browser-vm-relay";
import { pickOnlineRuntimeId } from "./bridge-relay";
import { SandboxProviderUnavailableError } from "./sandbox";

// Track every sandbox created so we can tear down its WS after each test —
// leaked-open sockets aggravate the miniflare worker-teardown flake.
const created: BrowserVmRelaySandbox[] = [];
function track(s: BrowserVmRelaySandbox): BrowserVmRelaySandbox {
  created.push(s);
  return s;
}
afterEach(async () => {
  for (const s of created.splice(0)) {
    try { await s.destroy(); } catch { /* best-effort */ }
  }
});

/** Minimal D1-shaped stub returning fixed rows for `.all()`. */
function fakeDb(rows: Array<{ id: string }>): Env["MAIN_DB"] {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: rows }),
      }),
    }),
  } as unknown as Env["MAIN_DB"];
}

/**
 * D1-shaped stub that honors the `kind` bind param the way the real query's
 * `AND r.kind = ?` filter does — pickOnlineRuntimeId binds (tenantId, kind,
 * window), so index 1 is the kind. Returns only the rows registered under
 * that kind. Lets us prove the kind plumbing without a live SQLite.
 */
function fakeDbByKind(rowsByKind: Record<string, Array<{ id: string }>>): Env["MAIN_DB"] {
  return {
    prepare: () => ({
      bind: (...args: unknown[]) => {
        const kind = typeof args[1] === "string" ? (args[1] as string) : "daemon";
        return { all: async () => ({ results: rowsByKind[kind] ?? [] }) };
      },
    }),
  } as unknown as Env["MAIN_DB"];
}

/**
 * Fake RUNTIME_ROOM namespace whose DO fetch upgrades to a WebSocket and runs
 * a scripted "tab": `run(serverSide)` is invoked with the DO/tab end of the
 * pair so a test can drive replies.
 */
function fakeRuntimeRoom(run: (server: WebSocket) => void): DurableObjectNamespace {
  return {
    idFromName: (n: string) => n as unknown as DurableObjectId,
    get: () => ({
      fetch: async () => {
        const pair = new WebSocketPair();
        const [client, server] = Object.values(pair);
        (server as unknown as { accept(): void }).accept();
        run(server);
        return new Response(null, { status: 101, webSocket: client });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

function envWith(opts: {
  rows?: Array<{ id: string }>;
  db?: Env["MAIN_DB"];
  run?: (server: WebSocket) => void;
}): Env {
  return {
    MAIN_DB: opts.db ?? fakeDb(opts.rows ?? [{ id: "rt_tab" }]),
    RUNTIME_ROOM: opts.run ? fakeRuntimeRoom(opts.run) : undefined,
  } as unknown as Env;
}

/**
 * A scripted browser tab: acks the handshake, records every op frame it
 * receives (so tests can assert the wire shape), and replies with the frozen
 * browser-vm result shape ({exit_code,stdout,stderr} for exec).
 */
function browserTab(received: Array<Record<string, unknown>>): (server: WebSocket) => void {
  return (server: WebSocket) => {
    server.send(JSON.stringify({ type: "attached", daemon_online: true }));
    server.addEventListener("message", (ev: MessageEvent) => {
      const m = JSON.parse(ev.data as string) as Record<string, unknown>;
      if (m.type !== "sandbox.op") return;
      received.push(m);
      const result =
        m.op === "exec" ? { exit_code: 0, stdout: `out:${m.command}`, stderr: "" } :
        m.op === "readFile" ? { content: "hello" } :
        {};
      server.send(JSON.stringify({
        type: "sandbox.result",
        request_id: m.request_id,
        ok: true,
        result,
      }));
    });
  };
}

describe("pickOnlineRuntimeId (kind filter)", () => {
  it("returns a browser-vm runtime for a browser-vm pick", async () => {
    const db = fakeDbByKind({ "browser-vm": [{ id: "rt_tab" }], daemon: [{ id: "rt_daemon" }] });
    expect(await pickOnlineRuntimeId(db, "t1", "browser-vm")).toBe("rt_tab");
  });

  it("a daemon-only tenant yields no browser-vm runtime", async () => {
    const db = fakeDbByKind({ daemon: [{ id: "rt_daemon" }] });
    expect(await pickOnlineRuntimeId(db, "t1", "browser-vm")).toBeNull();
  });

  it("a browser-vm-only tenant yields no daemon runtime", async () => {
    const db = fakeDbByKind({ "browser-vm": [{ id: "rt_tab" }] });
    expect(await pickOnlineRuntimeId(db, "t1", "daemon")).toBeNull();
    // The default kind is daemon, so an unqualified call is daemon-scoped too.
    expect(await pickOnlineRuntimeId(db, "t1")).toBeNull();
  });
});

describe("BrowserVmRelaySandbox", () => {
  it("round-trips exec through the frozen browser-vm frame shape", async () => {
    const received: Array<Record<string, unknown>> = [];
    const sandbox = track(new BrowserVmRelaySandbox(envWith({ run: browserTab(received) }), "sess_1", "t1"));
    const out = await sandbox.exec("echo hi");
    // Adapter formats {exit_code,stdout,stderr} → "exit=0\n<stdout>".
    expect(out).toBe("exit=0\nout:echo hi");
    // The op frame carries `timeout_seconds` (browser-vm convention), not `timeout`.
    const execFrame = received.find((f) => f.op === "exec")!;
    expect(execFrame).toBeDefined();
    expect(typeof execFrame.timeout_seconds).toBe("number");
    expect(execFrame).not.toHaveProperty("timeout");
    expect(execFrame.command).toBe("echo hi");
  });

  it("multiplexes concurrent ops by request_id", async () => {
    const received: Array<Record<string, unknown>> = [];
    const sandbox = track(new BrowserVmRelaySandbox(envWith({ run: browserTab(received) }), "sess_1", "t1"));
    const [a, b] = await Promise.all([sandbox.exec("one"), sandbox.readFile("/workspace/x")]);
    expect(a).toBe("exit=0\nout:one");
    expect(b).toBe("hello");
  });

  it("throws SandboxProviderUnavailableError when no browser-vm runtime is online", async () => {
    const received: Array<Record<string, unknown>> = [];
    const sandbox = track(new BrowserVmRelaySandbox(
      envWith({ rows: [], run: browserTab(received) }),
      "sess_1",
      "t1",
    ));
    await expect(sandbox.exec("echo hi")).rejects.toBeInstanceOf(SandboxProviderUnavailableError);
    await expect(sandbox.exec("echo hi")).rejects.toThrow(/sandbox tab/);
  });

  it("does not relay to a daemon runtime for a browser-vm session", async () => {
    const received: Array<Record<string, unknown>> = [];
    // Only a daemon runtime exists — the browser-vm pick must come up empty.
    const db = fakeDbByKind({ daemon: [{ id: "rt_daemon" }] });
    const sandbox = track(new BrowserVmRelaySandbox(
      envWith({ db, run: browserTab(received) }),
      "sess_1",
      "t1",
    ));
    await expect(sandbox.exec("echo hi")).rejects.toBeInstanceOf(SandboxProviderUnavailableError);
    expect(received).toHaveLength(0);
  });

  it("throws SandboxProviderUnavailableError when the session has no tenant", async () => {
    const received: Array<Record<string, unknown>> = [];
    const sandbox = track(new BrowserVmRelaySandbox(envWith({ run: browserTab(received) }), "sess_1", ""));
    await expect(sandbox.exec("echo hi")).rejects.toBeInstanceOf(SandboxProviderUnavailableError);
  });

  it("fails when the tab socket is not attached (daemon_online=false)", async () => {
    const sandbox = track(new BrowserVmRelaySandbox(
      envWith({ run: (s) => s.send(JSON.stringify({ type: "attached", daemon_online: false })) }),
      "sess_1",
      "t1",
    ));
    await expect(sandbox.exec("echo hi")).rejects.toBeInstanceOf(SandboxProviderUnavailableError);
  });

  it("times out an op when the tab acks the handshake but never replies", async () => {
    const sandbox = track(new BrowserVmRelaySandbox(
      envWith({
        run: (server) => {
          server.send(JSON.stringify({ type: "attached", daemon_online: true }));
          // Never reply to the op.
        },
      }),
      "sess_1",
      "t1",
    ));
    // A short per-op timeout (ms) so the test doesn't wait the 120s default.
    await expect(sandbox.exec("slow", 50)).rejects.toThrow(/timed out/);
  });

  it("rejects an in-flight op when the tab disconnects mid-op", async () => {
    const sandbox = track(new BrowserVmRelaySandbox(
      envWith({
        run: (server) => {
          server.send(JSON.stringify({ type: "attached", daemon_online: true }));
          // Tab goes away mid-op: the op frame lands, then the socket drops
          // with no reply. Without a disconnect-driven rejection the caller
          // would sit here for exec's timeout + 15s.
          server.addEventListener("message", () => {
            try { server.close(1001, "tab gone"); } catch { /* already closing */ }
          });
        },
      }),
      "sess_1",
      "t1",
    ));
    await expect(sandbox.exec("echo hi")).rejects.toThrow(/WS closed/);
  });

  it("destroy() during an in-flight connect closes the relay socket", async () => {
    let serverClosed = false;
    const sandbox = new BrowserVmRelaySandbox(
      envWith({
        run: (server) => {
          server.addEventListener("close", () => { serverClosed = true; });
          server.send(JSON.stringify({ type: "attached", daemon_online: true }));
          server.addEventListener("message", (ev: MessageEvent) => {
            const m = JSON.parse(ev.data as string) as Record<string, unknown>;
            // Ack only destroy — the exec stays in flight so we can assert
            // it's rejected rather than left hanging.
            if (m.op !== "destroy") return;
            server.send(JSON.stringify({ type: "sandbox.result", request_id: m.request_id, ok: true, result: {} }));
          });
        },
      }),
      "sess_1",
      "t1",
    );
    // Kick off the connect but don't await it — destroy() lands while
    // #connectPromise is still pending. Dropping that promise would let the
    // connect finish afterwards and orphan an open RuntimeRoom socket.
    const op = sandbox.exec("echo hi");
    await sandbox.destroy();
    await expect(op).rejects.toThrow(/destroyed/);
    // The close frame reaches the tab end asynchronously.
    await vi.waitFor(() => expect(serverClosed).toBe(true));
  });

  it("propagates a tab error result as a rejected op", async () => {
    const sandbox = track(new BrowserVmRelaySandbox(
      envWith({
        run: (server) => {
          server.send(JSON.stringify({ type: "attached", daemon_online: true }));
          server.addEventListener("message", (ev: MessageEvent) => {
            const m = JSON.parse(ev.data as string);
            server.send(JSON.stringify({
              type: "sandbox.result",
              request_id: m.request_id,
              ok: false,
              error: "boom",
            }));
          });
        },
      }),
      "sess_1",
      "t1",
    ));
    await expect(sandbox.exec("echo hi")).rejects.toThrow(/boom/);
  });
});

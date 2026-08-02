// BridgeSandboxManager driving a non-subprocess backend. A fake executor
// stands in for OpenShellClient — no gRPC, no gateway. What we assert is the
// contract the real client depends on: all 8 ops routed, one box per session,
// base64 ↔ bytes conversion, verbatim paths, verbatim exec output, and an
// explicit ms timeout on every exec.

import { describe, it, expect, beforeEach } from "vitest";
import {
  BridgeSandboxManager,
  type RelaySandboxBackend,
  type RelaySandboxExecutor,
} from "./bridge-sandbox.js";

interface Call { op: string; args: unknown[] }

class FakeExecutor implements RelaySandboxExecutor {
  calls: Call[] = [];
  files = new Map<string, Uint8Array>();
  destroyed = 0;
  destroyDelayMs = 0;

  constructor(public sessionId: string) {}

  async exec(command: string, timeoutMs: number): Promise<string> {
    this.calls.push({ op: "exec", args: [command, timeoutMs] });
    return `exit=0\n${command}-out`;
  }
  async readFile(path: string): Promise<string> {
    this.calls.push({ op: "readFile", args: [path] });
    return new TextDecoder().decode(this.#get(path));
  }
  async readFileBytes(path: string): Promise<Uint8Array> {
    this.calls.push({ op: "readFileBytes", args: [path] });
    return this.#get(path);
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.calls.push({ op: "writeFile", args: [path, content] });
    this.files.set(path, new TextEncoder().encode(content));
  }
  async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.calls.push({ op: "writeFileBytes", args: [path, bytes] });
    this.files.set(path, bytes);
  }
  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.calls.push({ op: "setEnvVars", args: [envVars] });
  }
  async ping(): Promise<void> {
    this.calls.push({ op: "ping", args: [] });
  }
  async destroy(): Promise<void> {
    this.calls.push({ op: "destroy", args: [] });
    if (this.destroyDelayMs) await new Promise((r) => setTimeout(r, this.destroyDelayMs));
    this.destroyed += 1;
  }
  #get(path: string): Uint8Array {
    const v = this.files.get(path);
    if (!v) throw new Error(`no such file ${path}`);
    return v;
  }
}

let created: FakeExecutor[];
let backend: RelaySandboxBackend;
let sent: Array<Record<string, unknown>>;
let mgr: BridgeSandboxManager;

beforeEach(() => {
  created = [];
  backend = {
    kind: "openshell",
    create: (sessionId) => {
      const e = new FakeExecutor(sessionId);
      created.push(e);
      return e;
    },
  };
  sent = [];
  mgr = new BridgeSandboxManager((m) => sent.push(m), { backend });
});

function req(op: string, extra: Record<string, unknown> = {}) {
  return { type: "sandbox.op", op, request_id: `r_${op}`, session_id: "sess_1", ...extra };
}

describe("BridgeSandboxManager with an injected backend", () => {
  it("reports the backend kind", () => {
    expect(mgr.backendKind).toBe("openshell");
  });

  it("routes all 8 relay ops to the executor", async () => {
    await mgr.handle(req("writeFile", { path: "/workspace/a.txt", content: "x" }));
    await mgr.handle(req("readFile", { path: "/workspace/a.txt" }));
    await mgr.handle(req("writeFileBytes", { path: "/workspace/b.bin", base64: "AAE=" }));
    await mgr.handle(req("readFileBytes", { path: "/workspace/b.bin" }));
    await mgr.handle(req("exec", { command: "echo hi" }));
    await mgr.handle(req("setEnvVars", { envVars: { A: "1" } }));
    await mgr.handle(req("ping"));
    await mgr.handle(req("destroy"));
    expect(created).toHaveLength(1);
    expect(created[0].calls.map((c) => c.op)).toEqual([
      "writeFile",
      "readFile",
      "writeFileBytes",
      "readFileBytes",
      "exec",
      "setEnvVars",
      "ping",
      "destroy",
    ]);
    expect(sent.every((m) => m.ok === true)).toBe(true);
  });

  it("passes paths through verbatim — no /workspace rewriting", async () => {
    await mgr.handle(req("writeFile", { path: "/workspace/deep/a.txt", content: "x" }));
    expect(created[0].calls[0].args[0]).toBe("/workspace/deep/a.txt");
  });

  it("passes exec output through verbatim (exit=N shape preserved)", async () => {
    await mgr.handle(req("exec", { command: "true" }));
    expect((sent[0].result as { output: string }).output).toBe("exit=0\ntrue-out");
  });

  it("always passes an explicit ms timeout, defaulting to 120s", async () => {
    await mgr.handle(req("exec", { command: "a" }));
    await mgr.handle(req("exec", { command: "b", timeout: 5_000 }));
    expect(created[0].calls[0].args[1]).toBe(120_000);
    expect(created[0].calls[1].args[1]).toBe(5_000);
  });

  it("round-trips binary bytes through base64 at the relay boundary", async () => {
    const b64 = Buffer.from([0, 1, 2, 250, 255]).toString("base64");
    await mgr.handle(req("writeFileBytes", { path: "/workspace/b.bin", base64: b64 }));
    expect(created[0].calls[0].args[1]).toBeInstanceOf(Uint8Array);
    await mgr.handle(req("readFileBytes", { path: "/workspace/b.bin" }));
    expect((sent[1].result as { base64: string }).base64).toBe(b64);
  });

  it("creates one box per session", async () => {
    await mgr.handle({ ...req("ping"), session_id: "s_a" });
    await mgr.handle({ ...req("ping"), session_id: "s_b" });
    await mgr.handle({ ...req("ping"), session_id: "s_a" });
    expect(created.map((e) => e.sessionId)).toEqual(["s_a", "s_b"]);
  });

  it("applies setEnvVars before the first exec creates the box", async () => {
    // The executor is minted on the FIRST op, so env vars set up front reach
    // the box before it is created on the gateway.
    await mgr.handle(req("setEnvVars", { envVars: { FOO: "bar" } }));
    await mgr.handle(req("exec", { command: "echo" }));
    expect(created).toHaveLength(1);
    expect(created[0].calls[0]).toEqual({ op: "setEnvVars", args: [{ FOO: "bar" }] });
  });

  it("keeps boxes across a WS reconnect (setSend)", async () => {
    await mgr.handle(req("ping"));
    mgr.setSend((m) => sent.push(m));
    await mgr.handle(req("ping"));
    expect(created).toHaveLength(1);
    expect(created[0].destroyed).toBe(0);
  });

  it("destroyAll awaits every box destroy", async () => {
    await mgr.handle({ ...req("ping"), session_id: "s_a" });
    await mgr.handle({ ...req("ping"), session_id: "s_b" });
    created[0].destroyDelayMs = 20;
    await mgr.destroyAll();
    expect(created.map((e) => e.destroyed)).toEqual([1, 1]);
  });

  it("surfaces an executor failure as ok:false", async () => {
    await mgr.handle(req("readFile", { path: "/workspace/missing" }));
    expect(sent[0]).toMatchObject({ ok: false });
    expect(sent[0].error).toMatch(/no such file/);
  });
});

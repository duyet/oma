// Unit tests for BrowserVmSandbox — the relay adapter that forwards sandbox
// ops to a browser tab hosting a WASM VM (WebContainers / CheerpX) over an
// injectable transport. No real WebSocket/RuntimeRoom involved: MockTransport
// captures sent frames and lets the test push back sandbox.result replies,
// exercising the request_id correlation the same way the real RuntimeRoom
// relay would.

import { describe, it, expect } from "vitest";
import { BrowserVmSandbox, type BrowserVmTransport } from "../src/adapters/browser-vm";

/** Captures every frame sent by the adapter and lets the test push replies
 *  back through the registered onMessage handler. */
class MockTransport implements BrowserVmTransport {
  sent: Array<Record<string, unknown>> = [];
  #handler: ((frame: string) => void) | null = null;
  closed = false;

  send(frame: string): void {
    this.sent.push(JSON.parse(frame));
  }

  onMessage(handler: (frame: string) => void): void {
    this.#handler = handler;
  }

  close(): void {
    this.closed = true;
  }

  /** Simulate the browser tab replying with a sandbox.result frame. */
  reply(requestId: string, payload: { ok: boolean; result?: Record<string, unknown>; error?: string }): void {
    this.#handler?.(JSON.stringify({ type: "sandbox.result", request_id: requestId, ...payload }));
  }

  /** Convenience: reply to the most recently sent frame. */
  replyToLast(payload: { ok: boolean; result?: Record<string, unknown>; error?: string }): void {
    const last = this.sent[this.sent.length - 1];
    this.reply(last.request_id as string, payload);
  }

  /** Push an arbitrary raw frame straight through to the handler — used to
   *  simulate malformed / off-protocol messages in edge-case tests. */
  onMessageForTest(rawFrame: string): void {
    this.#handler?.(rawFrame);
  }
}

describe("BrowserVmSandbox", () => {
  it("exec() success returns the exit=N\\n<stdout> shape", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const execPromise = sandbox.exec("echo hi");
    transport.replyToLast({ ok: true, result: { exit_code: 0, stdout: "hi\n", stderr: "" } });

    const result = await execPromise;
    expect(result).toBe("exit=0\nhi\n");
  });

  it("exec() appends [stderr:...] when stderr is non-empty", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const execPromise = sandbox.exec("false");
    transport.replyToLast({ ok: true, result: { exit_code: 1, stdout: "out\n", stderr: "boom\n" } });

    const result = await execPromise;
    expect(result).toBe("exit=1\nout\n[stderr:boom\n]");
  });

  it("exec() sends the sandbox.op wire frame with command + timeout_seconds", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_42" });

    const execPromise = sandbox.exec("echo hi", 5_000);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toMatchObject({
      type: "sandbox.op",
      op: "exec",
      session_id: "sess_42",
      command: "echo hi",
      timeout_seconds: 5,
    });
    expect(typeof transport.sent[0].request_id).toBe("string");

    transport.replyToLast({ ok: true, result: { exit_code: 0, stdout: "", stderr: "" } });
    await execPromise;
  });

  it("exec() failure (ok:false) rejects with the error message", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const execPromise = sandbox.exec("bad-command");
    transport.replyToLast({ ok: false, error: "vm crashed" });

    await expect(execPromise).rejects.toThrow("vm crashed");
  });

  it("exec() rejects with a timeout message when no reply arrives", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1", defaultTimeoutMs: 50 });

    // The pending-call timer is the command budget plus 15s slack for the
    // host's post-exec output collection (mirrors bridge-relay).
    await expect(sandbox.exec("sleep 100")).rejects.toThrow(/timed out after 15050ms/);
  });

  it("readFile() returns result.content", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const readPromise = sandbox.readFile("/workspace/hello.txt");
    expect(transport.sent[0]).toMatchObject({ op: "readFile", path: "/workspace/hello.txt" });
    transport.replyToLast({ ok: true, result: { content: "hello world" } });

    expect(await readPromise).toBe("hello world");
  });

  it("writeFile() returns the path on ok", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const writePromise = sandbox.writeFile("/workspace/out.txt", "content");
    expect(transport.sent[0]).toMatchObject({
      op: "writeFile",
      path: "/workspace/out.txt",
      content: "content",
    });
    transport.replyToLast({ ok: true });

    expect(await writePromise).toBe("/workspace/out.txt");
  });

  it("setEnvVars() resolves on ok", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const setPromise = sandbox.setEnvVars({ FOO: "bar" });
    expect(transport.sent[0]).toMatchObject({ op: "setEnvVars", envVars: { FOO: "bar" } });
    transport.replyToLast({ ok: true });

    await expect(setPromise).resolves.toBeUndefined();
  });

  it("ping() never throws — returns ok on a successful exec", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const pingPromise = sandbox.ping();
    transport.replyToLast({ ok: true, result: { exit_code: 0, stdout: "", stderr: "" } });

    const result = await pingPromise;
    expect(result.status).toBe("ok");
    expect(typeof result.latencyMs).toBe("number");
  });

  it("ping() returns error status (not a throw) when the op fails", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const pingPromise = sandbox.ping();
    transport.replyToLast({ ok: false, error: "vm unreachable" });

    const result = await pingPromise;
    expect(result.status).toBe("error");
    expect(result.details).toBe("vm unreachable");
  });

  it("destroy() sends the destroy op and closes the transport", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const destroyPromise = sandbox.destroy();
    expect(transport.sent[0]).toMatchObject({ op: "destroy" });
    transport.replyToLast({ ok: true });

    await destroyPromise;
    expect(transport.closed).toBe(true);
  });

  it("destroy() is best-effort — swallows a failed destroy op and still closes", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const destroyPromise = sandbox.destroy();
    transport.replyToLast({ ok: false, error: "already gone" });

    await expect(destroyPromise).resolves.toBeUndefined();
    expect(transport.closed).toBe(true);
  });

  it("correlates concurrent exec calls by request_id regardless of reply order", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const p1 = sandbox.exec("echo one");
    const p2 = sandbox.exec("echo two");
    expect(transport.sent).toHaveLength(2);

    const [req1, req2] = transport.sent.map((f) => f.request_id as string);
    expect(req1).not.toBe(req2);

    // Reply out of order: second call resolves first.
    transport.reply(req2, { ok: true, result: { exit_code: 0, stdout: "two\n", stderr: "" } });
    transport.reply(req1, { ok: true, result: { exit_code: 0, stdout: "one\n", stderr: "" } });

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toBe("exit=0\none\n");
    expect(r2).toBe("exit=0\ntwo\n");
  });

  it("ignores frames without a matching pending request_id", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const execPromise = sandbox.exec("echo hi");
    // Unrelated / stale frame — must be ignored, not crash or resolve wrongly.
    transport.reply("req_does_not_exist", { ok: true, result: { exit_code: 0, stdout: "wrong\n", stderr: "" } });
    transport.replyToLast({ ok: true, result: { exit_code: 0, stdout: "hi\n", stderr: "" } });

    expect(await execPromise).toBe("exit=0\nhi\n");
  });

  it("rejectPending() fails every in-flight op", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const p1 = sandbox.exec("one");
    const p2 = sandbox.readFile("/workspace/x");

    // Attach both rejection handlers *before* rejecting. rejectPending()
    // settles every pending op synchronously, so awaiting the assertions one
    // at a time would leave the second rejection unhandled for a microtask
    // tick — Vitest reports that as an unhandled error and exits non-zero even
    // though every assertion passes.
    const rejected1 = expect(p1).rejects.toThrow(/tab WS closed/);
    const rejected2 = expect(p2).rejects.toThrow(/tab WS closed/);

    // The transport owner (BrowserVmRelaySandbox) calls this when the tab's
    // socket drops — a request sent over a dead socket can never be answered,
    // so waiting out the per-op timeout would just stall the turn.
    sandbox.rejectPending(new Error("browser-vm tab WS closed"));

    await rejected1;
    await rejected2;

    // A late reply for a rejected request must not throw or double-settle.
    transport.reply(transport.sent[0].request_id as string, {
      ok: true,
      result: { exit_code: 0, stdout: "late\n", stderr: "" },
    });
  });

  it("destroy() rejects ops still in flight instead of leaving them hanging", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const execPromise = sandbox.exec("slow");
    // Handler attached before destroy() rejects it, for the same
    // unhandled-rejection reason as the rejectPending() case above.
    const stranded = expect(execPromise).rejects.toThrow(/destroyed/);
    const destroyPromise = sandbox.destroy();
    // Ack only the destroy op — the exec is the one left stranded.
    transport.replyToLast({ ok: true, result: {} });

    await destroyPromise;
    await stranded;
    expect(transport.closed).toBe(true);
  });

  it("ignores frames of the wrong type", async () => {
    const transport = new MockTransport();
    const sandbox = new BrowserVmSandbox({ transport, sessionId: "sess_1" });

    const execPromise = sandbox.exec("echo hi");
    const requestId = transport.sent[0].request_id as string;

    // A frame with the right request_id but the wrong `type` must be ignored
    // — the pending call should still be waiting afterwards.
    transport.onMessageForTest(JSON.stringify({ type: "sandbox.progress", request_id: requestId }));

    // Now send the real reply — the call must still resolve normally.
    transport.reply(requestId, { ok: true, result: { exit_code: 0, stdout: "hi\n", stderr: "" } });

    expect(await execPromise).toBe("exit=0\nhi\n");
  });
});

// Daemon-side tests for BridgeSandboxManager — local execution of relayed
// sandbox ops. Uses a real temp workdir (no mocks) and a capturing sender to
// assert the reply frames.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BridgeSandboxManager } from "./bridge-sandbox.js";

let baseDir: string;
let sent: Array<Record<string, unknown>>;
let mgr: BridgeSandboxManager;

beforeEach(() => {
  baseDir = mkdtempSync(join(tmpdir(), "oma-sbx-"));
  sent = [];
  // credentialProxy off: these tests drive ops with a no-op sender, so a
  // credential lookup would have nothing to answer it. Injection itself is
  // covered in credential-proxy.test.ts.
  mgr = new BridgeSandboxManager((m) => sent.push(m), { baseDir, credentialProxy: false });
});

afterEach(() => {
  mgr.destroyAll();
  try { rmSync(baseDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

function req(op: string, extra: Record<string, unknown> = {}) {
  return { type: "sandbox.op", op, request_id: `r_${op}_${Math.random()}`, session_id: "sess_1", ...extra };
}

describe("BridgeSandboxManager", () => {
  it("echoes request_id + session_id and marks ok on a successful op", async () => {
    const r = req("exec", { command: "echo hello" });
    await mgr.handle(r);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: "sandbox.result", request_id: r.request_id, session_id: "sess_1", ok: true });
  });

  it("runs a command and returns combined output", async () => {
    await mgr.handle(req("exec", { command: "printf abc" }));
    expect((sent[0].result as { output: string }).output).toBe("abc");
  });

  it("surfaces a non-zero exit in the output", async () => {
    await mgr.handle(req("exec", { command: "exit 3" }));
    expect((sent[0].result as { output: string }).output).toMatch(/exit 3|exit=3/);
  });

  it("write then read a file round-trips through the session workdir", async () => {
    await mgr.handle(req("writeFile", { path: "/workspace/a.txt", content: "data-123" }));
    expect(sent[0]).toMatchObject({ ok: true });
    await mgr.handle(req("readFile", { path: "/workspace/a.txt" }));
    expect((sent[1].result as { content: string }).content).toBe("data-123");
  });

  it("round-trips binary bytes via base64", async () => {
    const b64 = Buffer.from([0, 1, 2, 250, 255]).toString("base64");
    await mgr.handle(req("writeFileBytes", { path: "/workspace/b.bin", base64: b64 }));
    await mgr.handle(req("readFileBytes", { path: "/workspace/b.bin" }));
    expect((sent[1].result as { base64: string }).base64).toBe(b64);
  });

  it("applies setEnvVars to later commands in the same session", async () => {
    await mgr.handle(req("setEnvVars", { envVars: { FOO: "bar42" } }));
    await mgr.handle(req("exec", { command: "echo $FOO" }));
    expect((sent[1].result as { output: string }).output).toBe("bar42");
  });

  it("isolates workdirs per session", async () => {
    await mgr.handle({ ...req("writeFile", { path: "x.txt", content: "one" }), session_id: "s_a" });
    await mgr.handle({ ...req("readFile", { path: "x.txt" }), session_id: "s_b" });
    // s_b has no x.txt → error result
    expect(sent[1]).toMatchObject({ ok: false });
  });

  it("propagates the tenant_id back on the result when present", async () => {
    await mgr.handle(req("exec", { command: "true", tenant_id: "t_9" }));
    expect(sent[0].tenant_id).toBe("t_9");
  });

  it("returns ok:false with an error for an unknown op", async () => {
    await mgr.handle(req("frobnicate"));
    expect(sent[0]).toMatchObject({ ok: false });
    expect(sent[0].error).toMatch(/unknown sandbox op/);
  });

  it("destroy removes the session workdir", async () => {
    await mgr.handle(req("writeFile", { path: "keep.txt", content: "x" }));
    const dir = join(baseDir, "sess_1");
    expect(existsSync(dir)).toBe(true);
    await mgr.handle(req("destroy"));
    expect(existsSync(dir)).toBe(false);
  });

  it("ignores frames missing request_id or session_id", async () => {
    await mgr.handle({ type: "sandbox.op", op: "exec", command: "true" } as never);
    expect(sent).toHaveLength(0);
  });
});

describe("outbound credential lookup relay (issue #318)", () => {
  it("asks the platform over the relay socket and settles on the reply", async () => {
    const pending = mgr.resolveCredential("sess_1", "github.com");
    const frame = sent.at(-1)!;
    expect(frame).toMatchObject({
      type: "sandbox.outbound.credential",
      session_id: "sess_1",
      host: "github.com",
    });
    // The request frame carries no credential material — it is a question.
    expect(JSON.stringify(frame)).not.toContain("Bearer");

    mgr.handleCredentialResult({
      request_id: frame.request_id as string,
      ok: true,
      token: "fake-token-not-a-real-credential",
    });
    await expect(pending).resolves.toBe("fake-token-not-a-real-credential");
  });

  it("resolves null when no credential matches the host", async () => {
    const pending = mgr.resolveCredential("sess_1", "example.com");
    mgr.handleCredentialResult({ request_id: sent.at(-1)!.request_id as string, ok: true, token: null });
    await expect(pending).resolves.toBeNull();
  });

  it("rejects (so the proxy can log + fail open) when the platform cannot answer", async () => {
    const pending = mgr.resolveCredential("sess_1", "github.com");
    mgr.handleCredentialResult({
      request_id: sent.at(-1)!.request_id as string,
      ok: false,
      error: "credential resolution unavailable on this deployment",
    });
    await expect(pending).rejects.toThrow("unavailable on this deployment");
  });
});

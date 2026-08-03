/**
 * @file FakeSandbox — an in-memory, zero-I/O implementation of the full
 * SandboxExecutor surface, for unit tests that need to drive the harness
 * (or any SandboxExecutor consumer) without a real container.
 *
 * Every method is stubbed: file reads/writes hit an in-memory Map, exec
 * records its command and returns a configurable string, mounts and
 * lifecycle calls are no-ops that append to a `calls` log so tests can
 * assert call order and arguments. There is no network, no fork, no
 * filesystem — deterministic by construction.
 *
 * Intended for `@getoma/sandbox-sdk/test` consumers; pair with
 * RecordingSandbox when you need to capture results from a real executor
 * and diff them against a fake.
 */

import type { SandboxExecutor, ProcessHandle, SandboxCapacity } from "../src/ports";

export class FakeSandbox implements SandboxExecutor {
  /** In-memory file map: absolute path → string contents. */
  files = new Map<string, string>();
  /** Every command passed to exec() and startProcess(), in call order. */
  commands: string[] = [];
  /** Merged env vars from setEnvVars(); readable for assertions. */
  env: Record<string, string> = {};
  /** True once destroy() has been called. */
  destroyed = false;
  /** Append-only log of every non-file op, for call-order assertions. */
  calls: Array<{ op: string; args: unknown[] }> = [];

  // ── configurable stubs ────────────────────────────────────────────────

  private nextExecResult: string | null = null;
  private nextExecError: Error | null = null;
  private capacity: SandboxCapacity | null = null;
  private backupCounter = 0;

  /** Set the stdout that the *next* exec() returns. One-shot: clears after
   *  the call so subsequent execs go back to the empty-string default. */
  setExecResult(output: string): void {
    this.nextExecResult = output;
    this.nextExecError = null;
  }

  /** Make the *next* exec() throw `err`. One-shot, like setExecResult. */
  setExecError(err: Error): void {
    this.nextExecError = err;
    this.nextExecResult = null;
  }

  /** Override what getCapacity() returns (null by default). */
  setCapacity(cap: SandboxCapacity | null): void {
    this.capacity = cap;
  }

  // ── call-log assertions ───────────────────────────────────────────────

  /** Throws if no recorded call has op === `op`. */
  assertCalled(op: string): void {
    if (!this.calls.some((c) => c.op === op)) {
      throw new Error(`FakeSandbox.assertCalled: op "${op}" was never called`);
    }
  }

  /** Throws unless some recorded call matches `op` and deep-equals `args`
   *  (element-wise JSON.stringify comparison; lengths must match). */
  assertCalledWith(op: string, argsPartial: unknown[]): void {
    const hit = this.calls.some((c) => {
      if (c.op !== op) return false;
      if (c.args.length !== argsPartial.length) return false;
      return c.args.every((a, i) => JSON.stringify(a) === JSON.stringify(argsPartial[i]));
    });
    if (!hit) {
      throw new Error(
        `FakeSandbox.assertCalledWith: no call matched op="${op}" args=${JSON.stringify(argsPartial)}`,
      );
    }
  }

  // ── SandboxExecutor: exec + processes ─────────────────────────────────

  async exec(command: string, _timeout?: number): Promise<string> {
    // Record the command in both the convenience log and the calls log.
    this.commands.push(command);
    this.calls.push({ op: "exec", args: [command] });
    if (this.nextExecError) {
      const e = this.nextExecError;
      this.nextExecError = null;
      throw e;
    }
    const out = this.nextExecResult ?? "";
    this.nextExecResult = null;
    return out;
  }

  async startProcess(command: string): Promise<ProcessHandle | null> {
    this.commands.push(command);
    this.calls.push({ op: "startProcess", args: [command] });
    // Minimal handle — no real process, so kill/getLogs/getStatus are inert.
    const handle: ProcessHandle = {
      id: `proc_${Math.random().toString(36).slice(2)}`,
      pid: Math.floor(Math.random() * 100000),
      kill: async () => {},
      getLogs: async () => ({ stdout: "", stderr: "" }),
      getStatus: async () => "running",
    };
    return handle;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.calls.push({ op: "setEnvVars", args: [envVars] });
    this.env = { ...this.env, ...envVars };
  }

  async gitCheckout(
    repoUrl: string,
    options: { branch?: string; targetDir?: string },
  ): Promise<unknown> {
    this.calls.push({ op: "gitCheckout", args: [repoUrl, options] });
    return undefined;
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    // Sync on the interface; recorded with both args so replay is faithful.
    this.calls.push({ op: "registerCommandSecrets", args: [commandPrefix, secrets] });
  }

  async setOutboundContext(opts: { tenantId: string; sessionId: string }): Promise<void> {
    this.calls.push({ op: "setOutboundContext", args: [opts] });
  }

  async setBackupContext(opts: {
    tenantId: string;
    environmentId: string;
    sessionId: string;
  }): Promise<void> {
    this.calls.push({ op: "setBackupContext", args: [opts] });
  }

  async snapshotWorkspaceNow(): Promise<void> {
    this.calls.push({ op: "snapshotWorkspaceNow", args: [] });
  }

  // ── files ─────────────────────────────────────────────────────────────

  async readFile(path: string): Promise<string> {
    const v = this.files.get(path);
    if (v === undefined) {
      throw new Error(`FakeSandbox.readFile: no file at "${path}"`);
    }
    return v;
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const v = this.files.get(path);
    if (v === undefined) {
      throw new Error(`FakeSandbox.readFileBytes: no file at "${path}"`);
    }
    return new TextEncoder().encode(v);
  }

  async writeFile(path: string, content: string): Promise<string> {
    // Parent dirs are implicit — the Map is flat by path key.
    this.files.set(path, content);
    return path;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    this.files.set(path, new TextDecoder().decode(bytes));
    return path;
  }

  // ── mounts + workspace backups ────────────────────────────────────────

  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    this.calls.push({ op: "mountMemoryStore", args: [opts] });
  }

  async mountSessionOutputs(opts: { tenantId: string; sessionId: string }): Promise<void> {
    this.calls.push({ op: "mountSessionOutputs", args: [opts] });
  }

  async createWorkspaceBackup(opts: {
    name?: string;
    ttlSec: number;
  }): Promise<{ id: string; dir: string; localBucket?: boolean } | null> {
    this.calls.push({ op: "createWorkspaceBackup", args: [opts] });
    const id = `backup-${this.backupCounter++}`;
    return { id, dir: "/workspace", localBucket: false };
  }

  async restoreWorkspaceBackup(handle: {
    id: string;
    dir: string;
    localBucket?: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    this.calls.push({ op: "restoreWorkspaceBackup", args: [handle] });
    return { ok: true };
  }

  // ── lifecycle + observability ─────────────────────────────────────────

  async destroy(): Promise<void> {
    this.calls.push({ op: "destroy", args: [] });
    this.destroyed = true;
  }

  async renewActivityTimeout(): Promise<void> {
    this.calls.push({ op: "renewActivityTimeout", args: [] });
  }

  async ping(): Promise<{ status: "ok" | "error"; latencyMs: number; details?: string }> {
    this.calls.push({ op: "ping", args: [] });
    return { status: "ok", latencyMs: 0 };
  }

  async getCapacity(): Promise<SandboxCapacity | null> {
    this.calls.push({ op: "getCapacity", args: [] });
    return this.capacity;
  }
}

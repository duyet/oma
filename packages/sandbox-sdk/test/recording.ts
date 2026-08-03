/**
 * @file RecordingSandbox — a transparent wrapper around a SandboxExecutor
 * that records every call (op name, args, resolved result, or thrown
 * error) for after-the-fact assertion and replay.
 *
 * Unlike FakeSandbox (which replaces the executor entirely), this wraps a
 * real one — production adapter, fake, or mock — and observes what flows
 * through. Use it to assert "the harness called setEnvVars before exec"
 * against a real adapter, or to capture a live call sequence and replay
 * it against a FakeSandbox for deterministic diff testing.
 *
 * Every method is implemented explicitly rather than via a JS Proxy: a
 * Proxy can't tighten optional-method signatures, can't be statically
 * type-checked, and hides the surface from IDE goto-definition. Explicit
 * per-method proxies keep the wrapper fully typed.
 */

import type { SandboxExecutor, ProcessHandle, SandboxCapacity } from "../src/ports";

export interface SandboxRecording {
  op: string;
  args: unknown[];
  /** Resolved value on success. Omitted when the call threw. */
  result?: unknown;
  /** Error message on failure; `"not implemented"` when the inner executor
   *  doesn't define that optional method. Omitted on success. */
  error?: string;
  /** Unix epoch millis at call time. */
  ts: number;
}

export class RecordingSandbox implements SandboxExecutor {
  /** Ordered, append-only recording log. Publicly readable for assertions. */
  readonly recordings: SandboxRecording[] = [];

  constructor(public readonly inner: SandboxExecutor) {}

  // ── recording mechanics ───────────────────────────────────────────────
  //
  // Every async method funnels through `record`: push a fresh recording,
  // run the inner call, then mutate that recording in place with either
  // `result` or `error`. Re-throws on failure so the wrapper is invisible
  // to the caller — only observability changes, never control flow.

  private async record<T>(op: string, args: unknown[], fn: () => Promise<T>): Promise<T> {
    const r: SandboxRecording = { op, args, ts: Date.now() };
    this.recordings.push(r);
    try {
      const result = await fn();
      r.result = result;
      return result;
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  /** Mark a call as unsupported without throwing — for optional methods
   *  whose declared return type is nullable (void / unknown / T | null). */
  private notImplemented(op: string, args: unknown[]): void {
    this.recordings.push({ op, args, error: "not implemented", ts: Date.now() });
  }

  // ── assertions ────────────────────────────────────────────────────────

  /** Throws if no recording has op === `op`. */
  assertCalled(op: string): void {
    if (!this.recordings.some((r) => r.op === op)) {
      throw new Error(`RecordingSandbox.assertCalled: op "${op}" was never recorded`);
    }
  }

  /** Throws unless exactly `n` recordings have op === `op`. */
  assertCalledTimes(op: string, n: number): void {
    const count = this.recordings.filter((r) => r.op === op).length;
    if (count !== n) {
      throw new Error(
        `RecordingSandbox.assertCalledTimes: op "${op}" recorded ${count}×, expected ${n}`,
      );
    }
  }

  /** Throws unless some recording matches `op` AND deep-equals `args`.
   *  Comparison is JSON-based (`JSON.stringify` of each arg), so undefined
   *  keys, functions, and symbol-keyed properties won't compare equal —
   *  pass plain JSON-shaped args. Element counts must match exactly. */
  assertCalledWith(op: string, args: unknown[]): void {
    const hit = this.recordings.some((r) => {
      if (r.op !== op) return false;
      if (r.args.length !== args.length) return false;
      return r.args.every((a, i) => JSON.stringify(a) === JSON.stringify(args[i]));
    });
    if (!hit) {
      throw new Error(
        `RecordingSandbox.assertCalledWith: no recording matched op="${op}" args=${JSON.stringify(args)}`,
      );
    }
  }

  /** Clear all recordings (does not touch the inner executor). */
  reset(): void {
    this.recordings.length = 0;
  }

  /** Deep copy of the recordings array, so callers can capture a before/
   *  after diff without the live log mutating under them. */
  snapshot(): SandboxRecording[] {
    return JSON.parse(JSON.stringify(this.recordings)) as SandboxRecording[];
  }

  // ── required methods (always present on inner, no guard needed) ───────

  exec(command: string, timeout?: number): Promise<string> {
    return this.record("exec", [command, timeout], () => this.inner.exec(command, timeout));
  }

  readFile(path: string): Promise<string> {
    return this.record("readFile", [path], () => this.inner.readFile(path));
  }

  writeFile(path: string, content: string): Promise<string> {
    return this.record("writeFile", [path, content], () => this.inner.writeFile(path, content));
  }

  // ── optional methods ──────────────────────────────────────────────────
  //
  // Each optional method first binds the inner impl to a local. Methods
  // are stored as instance properties on `this.inner`, so extracting
  // `this.inner.foo` detaches `this` — we restore it with `.call`. When
  // the inner doesn't implement the method, we record "not implemented"
  // and either return a type-correct null/undefined or throw for
  // non-nullable return types (can't fabricate a Uint8Array honestly).

  async startProcess(command: string): Promise<ProcessHandle | null> {
    const fn = this.inner.startProcess;
    if (!fn) {
      this.notImplemented("startProcess", [command]);
      return null;
    }
    return this.record("startProcess", [command], () => fn.call(this.inner, command));
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    const fn = this.inner.setEnvVars;
    if (!fn) {
      this.notImplemented("setEnvVars", [envVars]);
      return;
    }
    return this.record("setEnvVars", [envVars], () => fn.call(this.inner, envVars));
  }

  async gitCheckout(
    repoUrl: string,
    options: { branch?: string; targetDir?: string },
  ): Promise<unknown> {
    const fn = this.inner.gitCheckout;
    if (!fn) {
      this.notImplemented("gitCheckout", [repoUrl, options]);
      return undefined;
    }
    return this.record("gitCheckout", [repoUrl, options], () =>
      fn.call(this.inner, repoUrl, options),
    );
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    // Sync method — inline the recording instead of going through the
    // async `record` helper; result is always undefined for a void call.
    const fn = this.inner.registerCommandSecrets;
    const r: SandboxRecording = {
      op: "registerCommandSecrets",
      args: [commandPrefix, secrets],
      ts: Date.now(),
    };
    this.recordings.push(r);
    if (!fn) {
      r.error = "not implemented";
      return;
    }
    try {
      fn.call(this.inner, commandPrefix, secrets);
      r.result = undefined;
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async setOutboundContext(opts: { tenantId: string; sessionId: string }): Promise<void> {
    const fn = this.inner.setOutboundContext;
    if (!fn) {
      this.notImplemented("setOutboundContext", [opts]);
      return;
    }
    return this.record("setOutboundContext", [opts], () => fn.call(this.inner, opts));
  }

  async setBackupContext(opts: {
    tenantId: string;
    environmentId: string;
    sessionId: string;
  }): Promise<void> {
    const fn = this.inner.setBackupContext;
    if (!fn) {
      this.notImplemented("setBackupContext", [opts]);
      return;
    }
    return this.record("setBackupContext", [opts], () => fn.call(this.inner, opts));
  }

  async snapshotWorkspaceNow(): Promise<void> {
    const fn = this.inner.snapshotWorkspaceNow;
    if (!fn) {
      this.notImplemented("snapshotWorkspaceNow", []);
      return;
    }
    return this.record("snapshotWorkspaceNow", [], () => fn.call(this.inner));
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const fn = this.inner.readFileBytes;
    if (!fn) {
      // Non-nullable return type — can't fabricate bytes, throw honestly.
      this.notImplemented("readFileBytes", [path]);
      throw new Error("readFileBytes not implemented by inner sandbox");
    }
    return this.record("readFileBytes", [path], () => fn.call(this.inner, path));
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const fn = this.inner.writeFileBytes;
    if (!fn) {
      this.notImplemented("writeFileBytes", [path, bytes]);
      throw new Error("writeFileBytes not implemented by inner sandbox");
    }
    return this.record("writeFileBytes", [path, bytes], () => fn.call(this.inner, path, bytes));
  }

  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    const fn = this.inner.mountMemoryStore;
    if (!fn) {
      this.notImplemented("mountMemoryStore", [opts]);
      return;
    }
    return this.record("mountMemoryStore", [opts], () => fn.call(this.inner, opts));
  }

  async mountSessionOutputs(opts: { tenantId: string; sessionId: string }): Promise<void> {
    const fn = this.inner.mountSessionOutputs;
    if (!fn) {
      this.notImplemented("mountSessionOutputs", [opts]);
      return;
    }
    return this.record("mountSessionOutputs", [opts], () => fn.call(this.inner, opts));
  }

  async createWorkspaceBackup(opts: {
    name?: string;
    ttlSec: number;
  }): Promise<{ id: string; dir: string; localBucket?: boolean } | null> {
    const fn = this.inner.createWorkspaceBackup;
    if (!fn) {
      this.notImplemented("createWorkspaceBackup", [opts]);
      return null;
    }
    return this.record("createWorkspaceBackup", [opts], () => fn.call(this.inner, opts));
  }

  async restoreWorkspaceBackup(handle: {
    id: string;
    dir: string;
    localBucket?: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    const fn = this.inner.restoreWorkspaceBackup;
    if (!fn) {
      this.notImplemented("restoreWorkspaceBackup", [handle]);
      throw new Error("restoreWorkspaceBackup not implemented by inner sandbox");
    }
    return this.record("restoreWorkspaceBackup", [handle], () => fn.call(this.inner, handle));
  }

  async destroy(): Promise<void> {
    const fn = this.inner.destroy;
    if (!fn) {
      this.notImplemented("destroy", []);
      return;
    }
    return this.record("destroy", [], () => fn.call(this.inner));
  }

  async renewActivityTimeout(): Promise<void> {
    const fn = this.inner.renewActivityTimeout;
    if (!fn) {
      this.notImplemented("renewActivityTimeout", []);
      return;
    }
    return this.record("renewActivityTimeout", [], () => fn.call(this.inner));
  }

  async ping(): Promise<{ status: "ok" | "error"; latencyMs: number; details?: string }> {
    const fn = this.inner.ping;
    if (!fn) {
      this.notImplemented("ping", []);
      // ping's contract is "does not throw" — return a healthy default
      // rather than fabricating an error when the inner skips it.
      return { status: "ok", latencyMs: 0 };
    }
    return this.record("ping", [], () => fn.call(this.inner));
  }

  async getCapacity(): Promise<SandboxCapacity | null> {
    const fn = this.inner.getCapacity;
    if (!fn) {
      this.notImplemented("getCapacity", []);
      return null;
    }
    return this.record("getCapacity", [], () => fn.call(this.inner));
  }
}

/**
 * Re-invoke each recording against `target`. Skips recordings that
 * originally threw (`error` set) — they can't be meaningfully replayed.
 * Used for "record against a real executor, replay against a fake" diff
 * testing: capture a live sequence, then assert the fake produces the
 * same side effects when the sequence is replayed.
 *
 * Methods absent on `target` are silently skipped via optional chaining,
 * so a recording taken against a full adapter can be replayed against a
 * minimal fake without per-op branching at the call site.
 */
export async function replayRecordings(
  target: SandboxExecutor,
  recordings: SandboxRecording[],
): Promise<void> {
  for (const r of recordings) {
    if (r.error) continue;
    switch (r.op) {
      case "exec":
        await target.exec(r.args[0] as string, r.args[1] as number | undefined);
        break;
      case "readFile":
        await target.readFile(r.args[0] as string);
        break;
      case "writeFile":
        await target.writeFile(r.args[0] as string, r.args[1] as string);
        break;
      case "startProcess":
        await target.startProcess?.(r.args[0] as string);
        break;
      case "setEnvVars":
        await target.setEnvVars?.(r.args[0] as Record<string, string>);
        break;
      case "gitCheckout":
        await target.gitCheckout?.(
          r.args[0] as string,
          r.args[1] as { branch?: string; targetDir?: string },
        );
        break;
      case "registerCommandSecrets":
        target.registerCommandSecrets?.(
          r.args[0] as string,
          r.args[1] as Record<string, string>,
        );
        break;
      case "setOutboundContext":
        await target.setOutboundContext?.(r.args[0] as { tenantId: string; sessionId: string });
        break;
      case "setBackupContext":
        await target.setBackupContext?.(
          r.args[0] as { tenantId: string; environmentId: string; sessionId: string },
        );
        break;
      case "snapshotWorkspaceNow":
        await target.snapshotWorkspaceNow?.();
        break;
      case "readFileBytes":
        await target.readFileBytes?.(r.args[0] as string);
        break;
      case "writeFileBytes":
        await target.writeFileBytes?.(r.args[0] as string, r.args[1] as Uint8Array);
        break;
      case "mountMemoryStore":
        await target.mountMemoryStore?.(
          r.args[0] as { storeName: string; storeId: string; readOnly: boolean },
        );
        break;
      case "mountSessionOutputs":
        await target.mountSessionOutputs?.(r.args[0] as { tenantId: string; sessionId: string });
        break;
      case "createWorkspaceBackup":
        await target.createWorkspaceBackup?.(r.args[0] as { name?: string; ttlSec: number });
        break;
      case "restoreWorkspaceBackup":
        await target.restoreWorkspaceBackup?.(
          r.args[0] as { id: string; dir: string; localBucket?: boolean },
        );
        break;
      case "destroy":
        await target.destroy?.();
        break;
      case "renewActivityTimeout":
        await target.renewActivityTimeout?.();
        break;
      case "ping":
        await target.ping?.();
        break;
      case "getCapacity":
        await target.getCapacity?.();
        break;
      default:
        // Unknown op — ignore so new methods don't break old recordings.
        break;
    }
  }
}

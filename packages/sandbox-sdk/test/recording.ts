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

  // ── required methods (always present on inner, no guard needed) ───────

  exec!: (command: string, timeout?: number) => Promise<string>;
  readFile!: (path: string) => Promise<string>;
  writeFile!: (path: string, content: string) => Promise<string>;

  // ── optional methods ──────────────────────────────────────────────────
  //
  // Declared as optional instance properties (not prototype methods) so that
  // `typeof wrapped.startProcess === "function"` is false when the inner
  // executor doesn't implement it. Presence-of-method capability probes that
  // callers use to decide whether to invoke an optional method will correctly
  // see `undefined` on the wrapper — mirroring the inner's surface exactly.
  startProcess?: (command: string) => Promise<ProcessHandle | null>;
  setEnvVars?: (envVars: Record<string, string>) => Promise<void>;
  gitCheckout?: (
    repoUrl: string,
    options: { branch?: string; targetDir?: string },
  ) => Promise<unknown>;
  registerCommandSecrets?: (commandPrefix: string, secrets: Record<string, string>) => void;
  setOutboundContext?: (opts: { tenantId: string; sessionId: string }) => Promise<void>;
  setBackupContext?: (opts: {
    tenantId: string;
    environmentId: string;
    sessionId: string;
  }) => Promise<void>;
  snapshotWorkspaceNow?: () => Promise<void>;
  readFileBytes?: (path: string) => Promise<Uint8Array>;
  writeFileBytes?: (path: string, bytes: Uint8Array) => Promise<string>;
  mountMemoryStore?: (opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }) => Promise<void>;
  mountSessionOutputs?: (opts: { tenantId: string; sessionId: string }) => Promise<void>;
  createWorkspaceBackup?: (opts: {
    name?: string;
    ttlSec: number;
  }) => Promise<{ id: string; dir: string; localBucket?: boolean } | null>;
  restoreWorkspaceBackup?: (handle: {
    id: string;
    dir: string;
    localBucket?: boolean;
  }) => Promise<{ ok: boolean; error?: string }>;
  destroy?: () => Promise<void>;
  renewActivityTimeout?: () => Promise<void>;
  ping?: () => Promise<{ status: "ok" | "error"; latencyMs: number; details?: string }>;
  getCapacity?: () => Promise<SandboxCapacity | null>;

  constructor(public readonly inner: SandboxExecutor) {
    this.install();
  }

  // ── recording mechanics ───────────────────────────────────────────────

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

  /** Wire up required methods (always present on the interface) and attach
   *  wrapped versions of each optional method that the inner executor
   *  actually defines. Methods absent on the inner stay `undefined` so that
   *  `typeof wrapped.<method>` probes reflect the inner's real capability. */
  private install(): void {
    // Required methods — always bound and recording.
    this.exec = (command, timeout) =>
      this.record("exec", [command, timeout], () => this.inner.exec(command, timeout));
    this.readFile = (path) =>
      this.record("readFile", [path], () => this.inner.readFile(path));
    this.writeFile = (path, content) =>
      this.record("writeFile", [path, content], () => this.inner.writeFile(path, content));

    // Optional methods — only attached when the inner provides them.
    this.installOptional("startProcess", async (command: string) => {
      return this.record("startProcess", [command], () =>
        this.inner.startProcess!.call(this.inner, command));
    });
    this.installOptional("setEnvVars", async (envVars: Record<string, string>) => {
      await this.record("setEnvVars", [envVars], () =>
        this.inner.setEnvVars!.call(this.inner, envVars));
    });
    this.installOptional("gitCheckout", async (repoUrl: string, options: { branch?: string; targetDir?: string }) => {
      return this.record("gitCheckout", [repoUrl, options], () =>
        this.inner.gitCheckout!.call(this.inner, repoUrl, options));
    });
    this.installOptional("snapshotWorkspaceNow", async () => {
      await this.record("snapshotWorkspaceNow", [], () => this.inner.snapshotWorkspaceNow!.call(this.inner));
    });
    this.installOptional("readFileBytes", async (path: string) => {
      return this.record("readFileBytes", [path], () => this.inner.readFileBytes!.call(this.inner, path));
    });
    this.installOptional("writeFileBytes", async (path: string, bytes: Uint8Array) => {
      return this.record("writeFileBytes", [path, bytes], () => this.inner.writeFileBytes!.call(this.inner, path, bytes));
    });
    this.installOptional("mountMemoryStore", async (opts: { storeName: string; storeId: string; readOnly: boolean }) => {
      await this.record("mountMemoryStore", [opts], () => this.inner.mountMemoryStore!.call(this.inner, opts));
    });
    this.installOptional("mountSessionOutputs", async (opts: { tenantId: string; sessionId: string }) => {
      await this.record("mountSessionOutputs", [opts], () => this.inner.mountSessionOutputs!.call(this.inner, opts));
    });
    this.installOptional("createWorkspaceBackup", async (opts: { name?: string; ttlSec: number }) => {
      return this.record("createWorkspaceBackup", [opts], () => this.inner.createWorkspaceBackup!.call(this.inner, opts));
    });
    this.installOptional("restoreWorkspaceBackup", async (handle: { id: string; dir: string; localBucket?: boolean }) => {
      return this.record("restoreWorkspaceBackup", [handle], () => this.inner.restoreWorkspaceBackup!.call(this.inner, handle));
    });
    this.installOptional("destroy", async () => {
      await this.record("destroy", [], () => this.inner.destroy!.call(this.inner));
    });
    this.installOptional("renewActivityTimeout", async () => {
      await this.record("renewActivityTimeout", [], () => this.inner.renewActivityTimeout!.call(this.inner));
    });
    this.installOptional("ping", async () => {
      return this.record("ping", [], () => this.inner.ping!.call(this.inner));
    });
    this.installOptional("getCapacity", async () => {
      return this.record("getCapacity", [], () => this.inner.getCapacity!.call(this.inner));
    });

    // Sync optional method — handled separately because it can't go through
    // the async `record` helper. Conditionally attached same as above.
    if (typeof this.inner.registerCommandSecrets === "function") {
      this.registerCommandSecrets = (commandPrefix: string, secrets: Record<string, string>) => {
        const r: SandboxRecording = {
          op: "registerCommandSecrets",
          args: [commandPrefix, secrets],
          ts: Date.now(),
        };
        this.recordings.push(r);
        try {
          this.inner.registerCommandSecrets!.call(this.inner, commandPrefix, secrets);
          r.result = undefined;
        } catch (e) {
          r.error = e instanceof Error ? e.message : String(e);
          throw e;
        }
      };
    }

    // setOutboundContext and setBackupContext — always attach if present on inner.
    this.installOptional("setOutboundContext", async (opts: { tenantId: string; sessionId: string }) => {
      await this.record("setOutboundContext", [opts], () => this.inner.setOutboundContext!.call(this.inner, opts));
    });
    this.installOptional("setBackupContext", async (opts: { tenantId: string; environmentId: string; sessionId: string }) => {
      await this.record("setBackupContext", [opts], () => this.inner.setBackupContext!.call(this.inner, opts));
    });
  }

  /** Attach a wrapped optional method only when the inner implements it.
   *  When the inner lacks the method, the property stays `undefined` —
   *  preserving `typeof` probe honesty. */
  private installOptional<K extends keyof SandboxExecutor>(
    key: K,
    wrapper: (...args: unknown[]) => Promise<unknown>,
  ): void {
    if (typeof this.inner[key] === "function") {
      (this as Record<string, unknown>)[key as string] = wrapper;
    }
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

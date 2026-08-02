// DynamicWorkerSandbox — Cloudflare Dynamic Workers adapter.
//
// Dynamic Workers (Worker Loader binding) spin up an ephemeral V8 isolate
// at runtime to execute arbitrary, untrusted code. It is a JS/Wasm/Python
// *eval* surface — NOT a Linux exec+filesystem box: no shell, no POSIX
// filesystem, no child_process, no package installs, nothing persists
// between calls. So this adapter honestly implements only what fits:
//
//   exec()      →  interpret the command as a JS module, run it in a fresh
//                  isolate via `LOADER.get(id, ...).getEntrypoint().fetch()`,
//                  return its stdout-equivalent (the returned value).
//   readFile /  →  throw a clear "not supported by dynamic-workers" error.
//   writeFile /     A JS-eval isolate has no filesystem to read or write.
//   startProcess/
//   gitCheckout
//
// Availability is a *binding*, not an env var: `env.LOADER` must be bound
// (declared via `worker_loaders` in the agent worker's wrangler.jsonc).
// The gate lives in the caller (apps/agent/src/runtime/sandbox.ts's
// resolveCfSandbox), which fails clearly when the binding is absent — the
// same discipline as boxrun's missing-BOXRUN_URL path. This is a
// Cloudflare-only primitive; on the self-host Node runtime it fails clearly
// too (nodeCompatible: false in provider-config.ts).
//
// This mirrors the `run_dynamic_worker` agent tool
// (apps/agent/src/harness/tools.ts) but at the *sandbox provider* layer:
// the whole environment is a JS-eval surface, selectable per-environment
// via `config.sandbox_provider: "dynamic-workers"`.

import type { SandboxExecutor, ProcessHandle } from "../ports";
import type { WorkerLoader, DynamicWorkerCode } from "@duyet/oma-shared";

const DEFAULT_COMPAT_DATE = "2026-04-13";
const DEFAULT_CPU_MS = 30_000;
const MAX_CPU_MS = 60_000;

let counter = 0;
function nextWorkerId(sessionId: string): string {
  counter = (counter + 1) % 1_000_000;
  return `oma-dwsbx-${sessionId.slice(0, 24)}-${counter}`;
}

/**
 * Wrap a bare JS snippet into a fetch-handler module when it isn't already a
 * full ES module. A bare snippet runs inside an async function and may
 * `return` a value; the return value is surfaced as `{ result }`. A snippet
 * that already `export default`s is passed through untouched. Mirrors
 * wrapDynamicWorkerJs in apps/agent/src/harness/tools.ts.
 */
function wrapJs(code: string): string {
  if (/export\s+default/.test(code)) return code;
  return (
    "export default {\n" +
    "  async fetch() {\n" +
    "    const __run = async () => {\n" +
    code +
    "\n    };\n" +
    "    const result = await __run();\n" +
    "    return Response.json({ result: result ?? null });\n" +
    "  }\n" +
    "};\n"
  );
}

function notSupported(op: string): Error {
  return new Error(
    `${op} is not supported by the "dynamic-workers" sandbox provider — ` +
      `it is a JS/Wasm eval isolate with no filesystem, shell, or persistence. ` +
      `Use a Linux-capable provider (cloud / boxrun / k8s-remote) for file or bash work.`,
  );
}

export interface DynamicWorkerSandboxOptions {
  /** The Cloudflare Worker Loader binding (env.LOADER). Required. */
  loader: WorkerLoader;
  /** Session id — used to derive worker ids (observability only). */
  sessionId: string;
  /** Per-run CPU limit in ms (default 30000, hard max 60000). */
  cpuMs?: number;
  /** Allow outbound network from the eval isolate (default false ⇒ fully
   *  sandboxed via globalOutbound: null). Credential-injecting gateway is a
   *  follow-up (see issue #139). */
  allowNetwork?: boolean;
}

/**
 * A JS-eval-only SandboxExecutor backed by Cloudflare Dynamic Workers.
 * `exec` runs the command as a JS module in a fresh ephemeral isolate; all
 * filesystem/process operations throw a clear "not supported" error.
 */
export class DynamicWorkerSandbox implements SandboxExecutor {
  private loader: WorkerLoader;
  private sessionId: string;
  private cpuMs: number;
  private allowNetwork: boolean;

  constructor(opts: DynamicWorkerSandboxOptions) {
    this.loader = opts.loader;
    this.sessionId = opts.sessionId;
    this.cpuMs = Math.min(opts.cpuMs || DEFAULT_CPU_MS, MAX_CPU_MS);
    this.allowNetwork = opts.allowNetwork ?? false;
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const cpuMs = timeout ? Math.min(timeout, MAX_CPU_MS) : this.cpuMs;
    const source = wrapJs(command);
    const worker = this.loader.get(nextWorkerId(this.sessionId), (): DynamicWorkerCode => ({
      compatibilityDate: DEFAULT_COMPAT_DATE,
      mainModule: "main.js",
      modules: { "main.js": source },
      // false ⇒ globalOutbound: null blocks ALL egress (fully sandboxed).
      globalOutbound: this.allowNetwork ? undefined : null,
      limits: { cpuMs },
    }));
    try {
      const res = await worker.getEntrypoint().fetch(
        new Request("https://oma-dynamic-worker.invalid/", { method: "POST" }),
      );
      const text = await res.text();
      if (!res.ok) {
        return `exit=1\ndynamic worker returned HTTP ${res.status}\n${text}`;
      }
      return `exit=0\n${text}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `exit=1\ndynamic worker eval failed: ${msg}`;
    }
  }

  async readFile(_path: string): Promise<string> {
    throw notSupported("readFile");
  }

  async writeFile(_path: string, _content: string): Promise<string> {
    throw notSupported("writeFile");
  }

  async startProcess(_command: string): Promise<ProcessHandle | null> {
    throw notSupported("startProcess");
  }

  async gitCheckout(
    _repoUrl: string,
    _options: { branch?: string; targetDir?: string },
  ): Promise<unknown> {
    throw notSupported("gitCheckout");
  }

  async ping(): Promise<{ status: "ok" | "error"; latencyMs: number; details?: string }> {
    const start = Date.now();
    try {
      const out = await this.exec("return 1 + 1;");
      const ok = out.includes('"result":2') || out.startsWith("exit=0");
      return {
        status: ok ? "ok" : "error",
        latencyMs: Date.now() - start,
        ...(ok ? {} : { details: out.slice(0, 200) }),
      };
    } catch (err) {
      return {
        status: "error",
        latencyMs: Date.now() - start,
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async destroy(): Promise<void> {
    // Nothing to tear down — each exec spins up and discards its own
    // ephemeral isolate. Dynamic Workers hold no state between calls.
  }
}

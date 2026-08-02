import type { SandboxExecutor, ProcessHandle } from "../harness/interface";
import type { Env } from "@duyet/oma-shared";
import { getSandbox as cfGetSandbox } from "@cloudflare/sandbox";
import { sessionOutputsPrefix } from "@duyet/oma-shared";
import { classifyCfSandboxProvider } from "@duyet/oma-sandbox";
// Static import (not the registry's lazy `import(factoryPath)`) so wrangler's
// esbuild bundles it like any other dependency — see the resolveCfSandbox
// doc comment below for why the registry itself can't be used here. BoxRun
// is the only remote adapter wired on CF today: it's a bare `fetch` client
// with zero driver-SDK dependency, so bundling it is low-risk. Daytona/E2B
// are classified `cfCompatible: true` (they're outbound-HTTP-only,
// architecturally fine for a Worker) but pull in real npm SDKs
// (`@daytonaio/sdk`, `e2b`) whose bundle-size/cold-start impact on a
// single-file Worker script can't be verified without an actual
// `wrangler deploy` — out of scope here. Selecting them on CF fails
// clearly (see resolveCfSandbox) instead of silently guessing.
import { BoxRunSandbox } from "@duyet/oma-sandbox/adapters/boxrun";
// Same static-import mandate as BoxRunSandbox: this is a bare `fetch`
// client against an in-cluster k8s-sandbox-gateway, zero Node builtins,
// so esbuild bundles it into the single-file Worker cleanly. The registry's
// lazy `import(factoryPath)` can't bundle here (see the comment above).
import { KubernetesRemoteSandbox } from "@duyet/oma-sandbox/adapters/kubernetes-remote";
import { K8sBridgeSandbox } from "@duyet/oma-sandbox/adapters/k8s-bridge";
// Relay-backed executor for local (subprocess) environments on the CF
// deployment — forwards sandbox ops to a user-paired `oma bridge daemon`
// over the RuntimeRoom DO. Imported lazily-at-construction (not at module
// eval) so the SandboxProviderUnavailableError circular reference below is
// safe. See bridge-relay.ts.
import { BridgeRelaySandbox } from "./bridge-relay";
// Browser-tab (WASM VM) relay — the browser-vm twin of BridgeRelaySandbox.
// Same RuntimeRoom-DO relay, different peer (a browser tab, not a daemon).
import { BrowserVmRelaySandbox } from "./browser-vm-relay";
// Pure mapping module (no gRPC / Node builtins) — bundles cleanly into the
// Worker. Turns OMA's environment networking/packages config into an OpenShell
// egress SandboxPolicy carried through to the bridge's OpenShell backend.
import {
  mapEnvironmentConfigToOpenShellPolicy,
  type OpenShellPolicyInput,
} from "@duyet/oma-sandbox/adapters/openshell-policy";
// `bash-parser` is CJS; the bundler handles interop for worker builds.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import parseShell from "bash-parser";

const parseShellCommand = parseShell as (command: string) => {
  type: string;
  commands?: Array<Record<string, any>>;
};

export class CloudflareSandbox implements SandboxExecutor {
  private sandboxPromise: Promise<any>;
  private env: Env;
  private sessionId: string;
  private mounted = false;
  private commandSecrets = new Map<string, Record<string, string>>();

  constructor(env: Env, sessionId: string) {
    this.env = env;
    this.sessionId = sessionId;
    try {
      this.sandboxPromise = Promise.resolve(cfGetSandbox(env.SANDBOX! as any, sessionId));
    } catch (err: any) {
      this.sandboxPromise = Promise.reject(
        new Error(`getSandbox failed (SANDBOX: ${typeof env.SANDBOX}, id: ${sessionId}): ${err?.message || err}`)
      );
    }
  }

  private async getSandbox() {
    return this.sandboxPromise;
  }

  /**
   * @deprecated /workspace persistence is now via createBackup/restoreBackup
   * (see restoreWorkspaceBackup + createWorkspaceBackup below). This is kept
   * as a no-op so callers that call mountWorkspace() during warmup don't
   * break, but it does NOT mount R2 anymore.
   *
   * Why dropped:
   *   - `localBucket: true` silently fails to push writes back in real CF
   *     (only works in `wrangler dev`). Workspace was effectively ephemeral.
   *   - FUSE/s3fs mode would make every `/workspace/...` write a synchronous
   *     R2 PUT (~100-500ms per write), unacceptable for typical agent flows
   *     (compile, build, scratch files).
   *   - Cloudflare's recommended pattern for "fast workspace + persist
   *     across sessions" is createBackup at session end + restoreBackup at
   *     session warmup. See changelog 2026-02-23.
   */
  async mountWorkspace(): Promise<void> {
    if (this.mounted) return;
    this.mounted = true;
    // Intentionally no-op. /workspace is plain container disk now.
    // Persistence is wired in session-do.ts via restoreWorkspaceBackup
    // (warmup) and createWorkspaceBackup (destroy).
  }

  /**
   * Snapshot /workspace into R2 via squashfs. Returns a handle the caller
   * persists in D1 (workspace_backups table). Best-effort: failure is
   * logged but does not raise — losing a backup is recoverable (worst
   * case: next session starts from empty workspace).
   */
  async createWorkspaceBackup(opts: {
    name?: string;
    ttlSec: number;
  }): Promise<{ id: string; dir: string; localBucket?: boolean } | null> {
    const sandbox = await this.getSandbox();
    // Detect dev mode: in wrangler dev there are no R2 S3 keys (no
    // presigned URLs available), so the SDK requires localBucket: true
    // which uses BACKUP_BUCKET binding directly. In prod we omit it and
    // the SDK uses presigned URLs.
    const isDev = !this.env.R2_ENDPOINT || !this.env.R2_ACCESS_KEY_ID;
    // Don't catch — let caller surface the SDK error in trajectory.
    // Earlier swallowed errors made silent backup failures look identical
    // to "no backup needed" from the perspective of the next session.
    const backup = await sandbox.createBackup({
      dir: "/workspace",
      name: opts.name,
      ttl: opts.ttlSec,
      // Skip the obvious bloat. node_modules can be 100s of MB and is
      // re-installable. Same for build caches.
      excludes: ["node_modules", ".cache", "__pycache__", ".next", "target"],
      // If /workspace is a git repo, respect .gitignore — it covers
      // build artifacts the project itself declared as expendable.
      gitignore: true,
      ...(isDev ? { localBucket: true } : {}),
    });
    return {
      id: backup.id,
      dir: backup.dir,
      localBucket: backup.localBucket,
    };
  }

  /**
   * Restore a previously created backup into /workspace. Returns
   * `{ ok: true }` on success, `{ ok: false, error: <message> }` on
   * failure. Best-effort: failure is logged AND surfaced to the caller
   * so observability can capture the underlying reason (expired squashfs,
   * R2 fetch error, container restoreArchive non-success, etc.).
   *
   * Earlier shape (`Promise<boolean>`) only returned a bare boolean which
   * meant a silently-failing restore looked identical to "no backup
   * existed" — diagnosed during 2026-05-02 TB pilot when hello-world
   * file vanished post-recycle but no error surfaced.
   */
  async restoreWorkspaceBackup(handle: {
    id: string;
    dir: string;
    localBucket?: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    try {
      const sandbox = await this.getSandbox();
      await sandbox.restoreBackup(handle);
      return { ok: true };
    } catch (err) {
      // Common: backup expired (BACKUP_EXPIRED), R2 lifecycle deleted the
      // squashfs, container's restoreArchive failed, etc. Either way, fall
      // through to empty workspace — agent can re-clone / re-install as
      // if it's a fresh session. Surface the message so callers can log.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[sandbox] restoreWorkspaceBackup failed: ${msg}`,
      );
      return { ok: false, error: msg.slice(0, 500) };
    }
  }

  /**
   * Mount a memory store into the sandbox at /mnt/memory/<store_name>/.
   * Uses sandbox.mountBucket with prefix scoping so the agent only sees this
   * store's keys (`<store_id>/...`) under the mount, regardless of what other
   * tenants have in MEMORY_BUCKET.
   *
   * Anthropic Managed Agents Memory contract: the agent reads/writes via
   * standard file tools — no bespoke memory_* tools (those were removed).
   *
   * Mode selection:
   *   - Production (FUSE / s3fs): used when R2_ENDPOINT + R2_ACCESS_KEY_ID
   *     + R2_SECRET_ACCESS_KEY are all bound. Writes flow synchronously
   *     over the S3 API and trigger R2 Event Notifications → CF Queue →
   *     consumer → D1 audit. This is the contract the rest of the memory
   *     subsystem assumes.
   *   - wrangler dev (`localBucket: true`): R2 binding-sync. Reads work,
   *     writes do NOT persist to R2 in real CF — only used here as a dev
   *     fallback so `pnpm wrangler dev` keeps working without R2 keys.
   */
  async mountMemoryStore(opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    if (!this.env.MEMORY_BUCKET) {
      throw new Error(
        `MEMORY_BUCKET binding missing — cannot mount memory store ${opts.storeName}`,
      );
    }
    const sandbox = await this.getSandbox();
    const mountPath = `/mnt/memory/${opts.storeName}`;
    // Trailing slash on the prefix ensures we don't accidentally match
    // sibling prefixes (e.g. "abc/" vs "abcd/...").
    const prefix = `/${opts.storeId}/`;

    const fuse = this.fuseR2ConfigOrNull();
    const bucketName = this.env.MEMORY_BUCKET_NAME;

    // Defensive cleanup: SDK keeps a per-isolate mount table that survives
    // container restarts. If a previous mount at the same path is still
    // registered (container went onStop without an explicit unmount —
    // happens on sleepAfter teardown + every Container DO restart), the
    // mountBucket below throws InvalidMountConfigError "already in use".
    // Idempotent unmount first; ignore errors (path wasn't mounted —
    // that's the happy case for a fresh isolate).
    await sandbox.unmountBucket(mountPath).catch(() => {});

    if (fuse && bucketName) {
      await sandbox.mountBucket(bucketName, mountPath, {
        endpoint: fuse.endpoint,
        provider: "r2",
        credentials: fuse.credentials,
        prefix,
        readOnly: opts.readOnly,
      });
    } else {
      // Dev fallback. In production this branch means agent writes won't
      // persist — log loudly so the operator catches the misconfig.
      console.warn(
        "[sandbox] mountMemoryStore: R2 FUSE creds missing (R2_ENDPOINT / " +
        "R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / MEMORY_BUCKET_NAME) — " +
        "falling back to localBucket mode. Agent writes to /mnt/memory/ will " +
        "NOT persist to R2 in real CF; this is dev-only behavior.",
      );
      await sandbox.mountBucket("MEMORY_BUCKET", mountPath, {
        localBucket: true,
        prefix,
        readOnly: opts.readOnly,
      });
    }
  }

  /**
   * Mount FILES_BUCKET at /mnt/session/outputs/ scoped to (tenant, session)
   * via R2 prefix. Mirrors AMA's `/mnt/session/outputs/` magic dir — agent
   * writes here using the standard `write` tool, files appear in the
   * caller-visible session outputs listing in real time (s3fs PUT each
   * write).
   *
   * R2 key scheme: t/<tenant>/session-outputs/<session>/<filename>
   * Caller list:    GET /v1/sessions/:id/outputs   (R2 list_objects by prefix)
   * Caller fetch:   GET /v1/sessions/:id/outputs/:filename
   *
   * Best-effort: any failure logs and proceeds (the agent can still
   * write to /workspace as a fallback, just not callable-retrievable).
   */
  async mountSessionOutputs(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    if (!this.env.FILES_BUCKET) {
      console.warn(
        "[sandbox] mountSessionOutputs: FILES_BUCKET binding missing — skipping",
      );
      return;
    }
    const sandbox = await this.getSandbox();
    const mountPath = `/mnt/session/outputs`;
    // s3fs wants a leading-slash prefix for directory scope; the shared
    // helper returns the R2-key form (no leading slash) so we prepend.
    const prefix = `/${sessionOutputsPrefix(opts.tenantId, opts.sessionId)}`;
    const fuse = this.fuseR2ConfigOrNull();
    const bucketName = "oma-managed-agents-files";

    // Defensive cleanup before mount — see mountMemoryStore for details.
    // Real prod symptom: container restart after sleepAfter teardown
    // throws InvalidMountConfigError "Mount path already in use" because
    // the SDK's per-isolate mount table still has the old entry. Caught
    // in sess-fa7j85x / sess-pkgiwl7 (2026-05-13 incident).
    await sandbox.unmountBucket(mountPath).catch(() => {});

    try {
      if (fuse) {
        await sandbox.mountBucket(bucketName, mountPath, {
          endpoint: fuse.endpoint,
          provider: "r2",
          credentials: fuse.credentials,
          prefix,
          readOnly: false,
        });
      } else {
        // Dev fallback. Writes won't reach R2 in real CF without keys —
        // log loudly so the operator sees the misconfig.
        console.warn(
          "[sandbox] mountSessionOutputs: R2 FUSE creds missing — falling " +
          "back to localBucket. Agent writes to /mnt/session/outputs/ will " +
          "NOT persist to R2; this is dev-only behavior.",
        );
        await sandbox.mountBucket("FILES_BUCKET", mountPath, {
          localBucket: true,
          prefix,
          readOnly: false,
        });
      }
    } catch (err) {
      console.error(
        `[sandbox] mountSessionOutputs failed: ${(err as Error).message ?? err}`,
      );
      // Don't throw — agent can fall back to /workspace, just not
      // callable-retrievable via the outputs endpoints.
    }
  }

  /**
   * Returns the R2 S3 credentials block if all three FUSE env vars are
   * present, else null (dev fallback). Centralized so memory + workspace
   * share the same gating.
   */
  private fuseR2ConfigOrNull(): {
    endpoint: string;
    credentials: { accessKeyId: string; secretAccessKey: string };
  } | null {
    const endpoint = this.env.R2_ENDPOINT;
    const accessKeyId = this.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = this.env.R2_SECRET_ACCESS_KEY;
    if (!endpoint || !accessKeyId || !secretAccessKey) return null;
    return { endpoint, credentials: { accessKeyId, secretAccessKey } };
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const sandbox = await this.getSandbox();
    const timeoutMs = timeout || 120000;
    const injectedSecrets = this.getSecretsForCommand(command);
    try {
      const execPromise = sandbox.exec(command, {
        timeout: timeoutMs,
        env: injectedSecrets,
      }).then((result: { stdout?: string; stderr?: string; exitCode?: number }) => {
        const out = result.stdout || "";
        const err = result.stderr || "";
        const combined = `exit=${result.exitCode}\n${out}${err ? "\nstderr: " + err : ""}`;
        return this.appendSecretRetryHint(command, combined, injectedSecrets);
      });
      const timeoutPromise = new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error(
          `Command timed out after ${Math.round(timeoutMs / 1000)}s: ${command.slice(0, 100)}`,
        )), timeoutMs + 10000),
      );
      return await Promise.race([execPromise, timeoutPromise]);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`exec("${command.slice(0, 80)}") failed: ${msg}`);
    }
  }

  async startProcess(command: string): Promise<ProcessHandle | null> {
    const sandbox = await this.getSandbox();
    if (typeof sandbox.startProcess !== "function") return null;
    try {
      const proc = await sandbox.startProcess(command, {
        env: this.getSecretsForCommand(command),
      });
      if (!proc?.id) return null;
      return {
        id: proc.id,
        pid: proc.pid,
        kill: (signal: string) => proc.kill(signal),
        getLogs: () => proc.getLogs(),
        getStatus: () => proc.getStatus(),
      };
    } catch {
      return null; // fallback to exec
    }
  }

  async readFile(path: string): Promise<string> {
    const sandbox = await this.getSandbox();
    try {
      const result = await sandbox.readFile(path, { encoding: "utf-8" });
      // Handle both string and {success, content} shapes
      if (typeof result === "string") return result;
      if ((result as { success?: boolean }).success === false) {
        throw new Error(`SDK returned success=false: ${JSON.stringify(result)}`);
      }
      return (result as { content: string }).content;
    } catch (err: any) {
      console.warn(`[sandbox.readFile] FAILED path=${path} err=${err?.message || err}`);
      throw new Error(`readFile(${path}) failed: ${err?.message || err}`);
    }
  }

  async writeFile(path: string, content: string): Promise<string> {
    const sandbox = await this.getSandbox();
    try {
      const result = await sandbox.writeFile(path, content);
      if (result && (result as { success?: boolean }).success === false) {
        throw new Error(`SDK returned success=false: ${JSON.stringify(result)}`);
      }
      return "ok";
    } catch (err: any) {
      console.warn(`[sandbox.writeFile] FAILED path=${path} err=${err?.message || err}`);
      throw new Error(`writeFile(${path}) failed: ${err?.message || err}`);
    }
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const sandbox = await this.getSandbox();
    // Encode to base64 client-side and ask the sandbox to decode. Avoids any
    // UTF-8 reinterpretation of the bytes in flight. The SDK's encoding hint
    // tells the sandbox how to interpret the string we send.
    let bin = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + CHUNK) as unknown as number[],
      );
    }
    const b64 = btoa(bin);
    try {
      const result = await sandbox.writeFile(path, b64, { encoding: "base64" });
      if (result && (result as { success?: boolean }).success === false) {
        throw new Error(`SDK returned success=false: ${JSON.stringify(result)}`);
      }
      return "ok";
    } catch (err: any) {
      console.warn(`[sandbox.writeFileBytes] FAILED path=${path} err=${err?.message || err}`);
      throw new Error(`writeFileBytes(${path}) failed: ${err?.message || err}`);
    }
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    const sandbox = await this.getSandbox();
    await sandbox.setEnvVars(envVars);
  }

  registerCommandSecrets(commandPrefix: string, secrets: Record<string, string>): void {
    this.commandSecrets.set(commandPrefix, secrets);
  }

  /**
   * Bind the OmaSandbox `inject_vault_creds` outbound handler with the
   * session's identifying context (tenantId, sessionId). The handler runs
   * in the agent worker scope; on every outbound HTTPS request the
   * sandbox makes, it RPCs to main with these identifiers, main does the
   * vault lookup live, injects the bearer, and forwards. The agent
   * worker's address space never holds plaintext vault credentials —
   * mirrors Anthropic Managed Agents' "credential proxy outside the
   * harness" pattern (see apps/agent/src/oma-sandbox.ts file header).
   */
  async setOutboundContext(opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    if (!opts.tenantId || !opts.sessionId) return;
    try {
      const sandbox = await this.getSandbox();
      const hasFn = typeof sandbox.setOutboundHandler === "function";
      console.log(
        `[sandbox] setOutboundContext tenant=${opts.tenantId.slice(0, 8)} sid=${opts.sessionId.slice(0, 12)} hasFn=${hasFn}`,
      );
      if (!hasFn) return;
      await sandbox.setOutboundHandler("inject_vault_creds", {
        tenantId: opts.tenantId,
        sessionId: opts.sessionId,
      });
      console.log(`[sandbox] setOutboundHandler bound (RPC mode)`);
    } catch (err) {
      console.error(
        `[sandbox] setOutboundContext failed: ${(err as Error).message ?? err}`,
      );
    }
  }

  /**
   * Hand the (tenant, env, session) tuple to the OmaSandbox container DO so
   * its `onActivityExpired` hook (fires right before sleepAfter teardown)
   * can write the final /workspace snapshot into MAIN_DB scoped to this
   * session. Best-effort — failure here just means the next session in
   * this scope falls back to the previous backup or empty workspace.
   */
  async setBackupContext(opts: {
    tenantId: string;
    environmentId: string;
    sessionId: string;
  }): Promise<void> {
    if (!opts.tenantId || !opts.environmentId || !opts.sessionId) return;
    try {
      const sandbox = (await this.getSandbox()) as unknown as {
        setBackupContext?: (ctx: { tenantId: string; environmentId: string; sessionId: string }) => Promise<void>;
      };
      if (typeof sandbox.setBackupContext !== "function") return;
      await sandbox.setBackupContext({
        tenantId: opts.tenantId,
        environmentId: opts.environmentId,
        sessionId: opts.sessionId,
      });
    } catch (err) {
      console.error(
        `[sandbox] setBackupContext failed: ${(err as Error).message ?? err}`,
      );
    }
  }

  /**
   * Trigger an immediate /workspace snapshot via the OmaSandbox helper.
   * Used by /destroy to get a final snapshot before sandbox.destroy() —
   * sleepAfter teardown handles itself via onActivityExpired. Best-effort.
   */
  async snapshotWorkspaceNow(): Promise<void> {
    try {
      const sandbox = (await this.getSandbox()) as unknown as {
        snapshotWorkspaceNow?: () => Promise<void>;
      };
      if (typeof sandbox.snapshotWorkspaceNow !== "function") return;
      await sandbox.snapshotWorkspaceNow();
    } catch (err) {
      console.error(
        `[sandbox] snapshotWorkspaceNow failed: ${(err as Error).message ?? err}`,
      );
    }
  }


  async destroy(): Promise<void> {
    try {
      const sandbox = await this.getSandbox();
      if (typeof sandbox.destroy === "function") await sandbox.destroy();
    } catch {}
    // Invalidate the cached stub. Next `getSandbox()` call will rebuild via
    // `cfGetSandbox(env.SANDBOX, sessionId)`, which returns the same logical
    // Sandbox DO (sessionId-keyed) but with a fresh RPC connection. Without
    // this, the wrapper would hand the next caller a stub pointing at the
    // container we just destroyed — followup exec calls would hit a stale
    // RPC handle (observed staging 2026-05-19: "An RPC stub was not
    // disposed properly" warning preceded the 53-min container wedge by
    // ~12s, suggesting stale-stub reuse plays a role in the hang loop).
    this.sandboxPromise = Promise.resolve(cfGetSandbox(this.env.SANDBOX! as any, this.sessionId));
    this.mounted = false;
  }

  /**
   * Forward (tenant, session, agent, instanceType) tuple to OmaSandbox so
   * its onStop / pre-destroy emit can attribute the sandbox_active_seconds
   * row with the correct instance type for pricing. The wrapper exists
   * because SessionDO holds a CloudflareSandbox, not the underlying DO stub
   * — without this passthrough, the optional-chain check at session-do.ts
   * warmup silently no-ops.
   */
  async setBillingContext(opts: {
    tenantId: string;
    sessionId: string;
    agentId: string | null;
    instanceType?: string | null;
  }): Promise<void> {
    if (!opts.tenantId || !opts.sessionId) return;
    try {
      const sandbox = (await this.getSandbox()) as unknown as {
        setBillingContext?: (c: {
          tenantId: string;
          sessionId: string;
          agentId: string | null;
          instanceType?: string | null;
        }) => Promise<void>;
      };
      if (typeof sandbox.setBillingContext !== "function") return;
      await sandbox.setBillingContext(opts);
    } catch (err) {
      console.error(
        `[sandbox] setBillingContext failed: ${(err as Error).message ?? err}`,
      );
    }
  }

  /**
   * Trigger the sandbox_active_seconds emit synchronously. Called by
   * SessionDO's `/destroy` handler BEFORE `destroy()` so the write lands
   * in the request lifecycle (CF's onStop callback fires async to destroy
   * and can be dropped on DO eviction). Idempotent via storage-delete
   * inside OmaSandbox.
   *
   * Returns the count of seconds emitted (0 if no-op / failed).
   */
  async emitSandboxActiveNow(): Promise<number> {
    try {
      const sandbox = (await this.getSandbox()) as unknown as {
        emitSandboxActiveNow?: () => Promise<number>;
      };
      if (typeof sandbox.emitSandboxActiveNow !== "function") return 0;
      return await sandbox.emitSandboxActiveNow();
    } catch (err) {
      console.error(
        `[sandbox] emitSandboxActiveNow failed: ${(err as Error).message ?? err}`,
      );
      return 0;
    }
  }

  /**
   * Reset the CF Container's sleepAfter inactivity timer. SessionDO calls
   * this from its alarm while there are background_tasks rows so a long-
   * running `python script.py &` survives past sleepAfter without us doing
   * any actual work for it. Fail-soft if SDK doesn't expose the method.
   */
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

  async renewActivityTimeout(): Promise<void> {
    try {
      const sandbox = await this.getSandbox();
      if (typeof sandbox.renewActivityTimeout === "function") {
        await sandbox.renewActivityTimeout();
      }
    } catch {}
  }

  private getSecretsForCommand(command: string): Record<string, string> | undefined {
    const commandName = this.getSimpleCommandName(command);
    if (!commandName) return undefined;
    for (const [prefix, secrets] of this.commandSecrets) {
      if (commandName === prefix) return secrets;
    }
    return undefined;
  }


  private getSimpleCommandName(command: string): string | undefined {
    try {
      const ast = parseShellCommand(command);
      if (ast?.type !== "Script" || !Array.isArray(ast.commands) || ast.commands.length !== 1) return undefined;
      const [node] = ast.commands;
      if (node?.type !== "Command") return undefined;
      if (!node.name || typeof node.name.text !== "string" || !node.name.text) return undefined;
      if (Array.isArray(node.suffix) && node.suffix.some((part: any) => part?.type === "Redirect")) return undefined;
      if (Array.isArray(node.prefix) && node.prefix.some((part: any) => part?.type === "Redirect")) return undefined;
      return node.name.text;
    } catch {
      return undefined;
    }
  }

  private appendSecretRetryHint(
    command: string,
    result: string,
    injectedSecrets?: Record<string, string>,
  ): string {
    if (injectedSecrets) return result;
    const exitMatch = result.match(/^exit=(\d+)/);
    if (!exitMatch || exitMatch[1] === "0") return result;
    if (!this.isCompositeCommand(command)) return result;

    const matchedPrefix = this.findSecretBackedCommandPrefix(command);
    if (!matchedPrefix) return result;

    return `${result}\n\nHint: This chained shell command includes a secret-backed command (\`${matchedPrefix}\`) and failed. Retry with a single authenticated command when possible.`;
  }

  private isCompositeCommand(command: string): boolean {
    return /&&|\|\||;|\||\n/.test(command);
  }

  private findSecretBackedCommandPrefix(command: string): string | undefined {
    const atoms = command
      .split(/&&|\|\||;|\||\n/g)
      .map((part) => part.trim())
      .filter(Boolean);

    for (const atom of atoms) {
      const commandName = this.getSimpleCommandName(atom);
      if (!commandName) continue;
      for (const prefix of this.commandSecrets.keys()) {
        if (commandName === prefix) return prefix;
      }
    }
    return undefined;
  }

  async gitCheckout(repoUrl: string, options: { branch?: string; targetDir?: string }): Promise<unknown> {
    const sandbox = await this.getSandbox();
    return sandbox.gitCheckout(repoUrl, options);
  }
}

export class TestSandbox implements SandboxExecutor {
  async exec(command: string): Promise<string> {
    return `exit=0\n(test: ${command})`;
  }
  async readFile(path: string): Promise<string> {
    return `(test: file ${path})`;
  }
  async writeFile(_path: string, _content: string): Promise<string> {
    return "ok";
  }
  async writeFileBytes(_path: string, _bytes: Uint8Array): Promise<string> {
    return "ok";
  }
  async ping(): Promise<{ status: "ok" | "error"; latencyMs: number; details?: string }> {
    return { status: "ok", latencyMs: 0 };
  }
}

/**
 * Thrown when an environment's `config.sandbox_provider` (or legacy
 * `config.type`) selects a sandbox adapter this Cloudflare deployment
 * cannot serve — either it's Node-only (subprocess / litebox / k8s: relies
 * on child_process, a native micro-VM binding, or local kubeconfig/
 * filesystem access — none of which exist in a Worker) or it's
 * architecturally CF-capable but not yet bundled here (daytona / e2b —
 * see the import comment above `BoxRunSandbox`). Callers must let this
 * propagate into the normal turn-processing error path (session-do.ts's
 * `drainEventQueue` catch, around the `runAgentTurn` call) so it surfaces
 * as a `session.error` event instead of crashing the DO or silently
 * substituting a different sandbox.
 */
export class SandboxProviderUnavailableError extends Error {}

/** The environment `config` subset resolveCfSandbox reads: the provider
 *  selector plus (for OpenShell) the networking/packages mapped into an egress
 *  policy. `OpenShellPolicyInput` supplies networking/packages. */
type CfEnvConfig = { sandbox_provider?: string; type?: string } & OpenShellPolicyInput;

function cfProviderEnv(env: Env): Record<string, string | undefined> {
  const e = env as unknown as Record<string, string | undefined>;
  return {
    BOXRUN_URL: e.BOXRUN_URL,
    BOXRUN_TOKEN: e.BOXRUN_TOKEN,
    BOXRUN_CPUS: e.BOXRUN_CPUS,
    BOXRUN_MEMORY_MIB: e.BOXRUN_MEMORY_MIB,
    SANDBOX_IMAGE: e.SANDBOX_IMAGE,
    K8S_SANDBOX_GATEWAY_URL: e.K8S_SANDBOX_GATEWAY_URL,
    K8S_SANDBOX_TOKEN: e.K8S_SANDBOX_TOKEN,
    K8S_SANDBOX_CPUS: e.K8S_SANDBOX_CPUS,
    K8S_SANDBOX_MEMORY_MIB: e.K8S_SANDBOX_MEMORY_MIB,
    K8S_BRIDGE_URL: e.K8S_BRIDGE_URL,
    K8S_BRIDGE_TOKEN: e.K8S_BRIDGE_TOKEN,
    K8S_CPU: e.K8S_CPU,
    K8S_MEMORY: e.K8S_MEMORY,
    OPENSHELL_BRIDGE_URL: e.OPENSHELL_BRIDGE_URL,
    OPENSHELL_BRIDGE_TOKEN: e.OPENSHELL_BRIDGE_TOKEN,
    OPENSHELL_MCP_PROXY_HOST: e.OPENSHELL_MCP_PROXY_HOST,
  };
}

/**
 * Construct the remote SandboxExecutor for a `cfCompatible` provider type.
 * Constructs the adapter class directly (not the adapter's `sandboxFactory`,
 * which is `async` to accommodate adapters that truly need to await
 * creation) so this stays synchronous — `resolveCfSandbox` is called from
 * `ensureSandboxCreated()` in session-do.ts, which is a synchronous method
 * with ~14 call sites; making sandbox creation async would ripple through
 * all of them, well outside this change's scope.
 */
function createRemoteSandbox(
  type: string,
  env: Env,
  sessionId: string,
  envConfig?: CfEnvConfig | null,
): SandboxExecutor {
  const e = cfProviderEnv(env);
  switch (type) {
    case "boxrun": {
      if (!e.BOXRUN_URL) {
        throw new SandboxProviderUnavailableError(
          `provider "boxrun" requires BOXRUN_URL to be set on this Cloudflare deployment ` +
            `(wrangler secret put BOXRUN_URL) — pointing at a running "boxlite serve" instance.`,
        );
      }
      return new BoxRunSandbox({
        baseUrl: e.BOXRUN_URL,
        image: e.SANDBOX_IMAGE,
        cpus: e.BOXRUN_CPUS ? Number(e.BOXRUN_CPUS) : undefined,
        memoryMib: e.BOXRUN_MEMORY_MIB ? Number(e.BOXRUN_MEMORY_MIB) : undefined,
        bearerToken: e.BOXRUN_TOKEN,
        sessionId,
      });
    }
    case "k8s-remote": {
      if (!e.K8S_SANDBOX_GATEWAY_URL) {
        throw new SandboxProviderUnavailableError(
          `provider "k8s-remote" requires K8S_SANDBOX_GATEWAY_URL to be set on this Cloudflare ` +
            `deployment (wrangler secret put K8S_SANDBOX_GATEWAY_URL) — pointing at a running ` +
            `in-cluster k8s-sandbox-gateway instance.`,
        );
      }
      return new KubernetesRemoteSandbox({
        baseUrl: e.K8S_SANDBOX_GATEWAY_URL,
        image: e.SANDBOX_IMAGE,
        cpus: e.K8S_SANDBOX_CPUS ? Number(e.K8S_SANDBOX_CPUS) : undefined,
        memoryMib: e.K8S_SANDBOX_MEMORY_MIB ? Number(e.K8S_SANDBOX_MEMORY_MIB) : undefined,
        bearerToken: e.K8S_SANDBOX_TOKEN,
        sessionId,
      });
    }
    case "k8s-bridge": {
      if (!e.K8S_BRIDGE_URL) {
        throw new SandboxProviderUnavailableError(
          `provider "k8s-bridge" requires K8S_BRIDGE_URL to be set on this Cloudflare deployment ` +
            `(wrangler secret put K8S_BRIDGE_URL) — pointing at a running K8s bridge instance.`,
        );
      }
      return new K8sBridgeSandbox({
        baseUrl: `${e.K8S_BRIDGE_URL.replace(/\/$/, "")}/api/v1`,
        bearerToken: e.K8S_BRIDGE_TOKEN ?? "",
        sessionId,
        image: e.SANDBOX_IMAGE,
        cpu: e.K8S_CPU ? Number(e.K8S_CPU) : undefined,
        memory: e.K8S_MEMORY ? Number(e.K8S_MEMORY) : undefined,
      });
    }
    case "openshell": {
      // The OpenShell gateway is gRPC-only, which a Worker cannot speak. On
      // CF we instead talk to the k8s-bridge running its OpenShell backend
      // (BRIDGE_BACKEND=openshell) — same boxrun-shaped HTTP surface as any
      // other k8s-bridge, so we reuse K8sBridgeSandbox pointed at
      // OPENSHELL_BRIDGE_URL. The bridge holds the gRPC client; the Worker
      // stays pure fetch. Self-host Node keeps its direct-gRPC adapter.
      if (!e.OPENSHELL_BRIDGE_URL) {
        throw new SandboxProviderUnavailableError(
          `provider "openshell" requires OPENSHELL_BRIDGE_URL to be set on this Cloudflare deployment ` +
            `(wrangler secret put OPENSHELL_BRIDGE_URL) — pointing at a k8s-bridge running its OpenShell ` +
            `backend (BRIDGE_BACKEND=openshell). Self-host Node speaks gRPC to the gateway directly.`,
        );
      }
      // Map OMA's environment networking/packages config to an OpenShell egress
      // policy here (on the Worker, where the config lives), then carry the
      // policy JSON through the bridge to the OpenShell backend's CreateSandbox.
      const mcpProxyHosts = e.OPENSHELL_MCP_PROXY_HOST ? [e.OPENSHELL_MCP_PROXY_HOST] : undefined;
      const { policy, warnings } = mapEnvironmentConfigToOpenShellPolicy(
        envConfig as OpenShellPolicyInput | undefined,
        { mcpProxyHosts },
      );
      for (const w of warnings) {
        console.warn(`[sandbox] openshell policy mapping (sid=${sessionId.slice(0, 12)}): ${w}`);
      }
      return new K8sBridgeSandbox({
        baseUrl: `${e.OPENSHELL_BRIDGE_URL.replace(/\/$/, "")}/api/v1`,
        bearerToken: e.OPENSHELL_BRIDGE_TOKEN ?? "",
        sessionId,
        image: e.SANDBOX_IMAGE,
        policy,
      });
    }
    default:
      // daytona / e2b — cfCompatible in provider-config.ts's classification
      // data, but their driver SDKs aren't bundled into this worker. See
      // the import comment above.
      throw new SandboxProviderUnavailableError(
        `provider "${type}" is not available on the Cloudflare deployment yet ` +
          `(its driver SDK isn't bundled into this worker) — use the self-host runtime instead.`,
      );
  }
}

/**
 * Resolve a SandboxExecutor for a CF session from its environment's
 * `config.sandbox_provider` (falls back to legacy `config.type`).
 *
 *  - absent / `"cloud"` / an unrecognized id → CloudflareSandbox, the
 *    unchanged pre-existing default.
 *  - `"boxrun"` → a real BoxRunSandbox (pure `fetch`, no driver SDK).
 *  - `"daytona"` / `"e2b"` → throws SandboxProviderUnavailableError —
 *    architecturally CF-capable but not wired here yet.
 *  - `"subprocess"` / `"litebox"` / `"k8s"` → throws
 *    SandboxProviderUnavailableError — Node-only, cannot run in a Worker.
 */
export function resolveCfSandbox(
  env: Env,
  sessionId: string,
  envConfig: CfEnvConfig | null | undefined,
  tenantId?: string,
): SandboxExecutor {
  const providerId = envConfig?.sandbox_provider || envConfig?.type;
  const resolution = classifyCfSandboxProvider(providerId);

  if (resolution.kind === "cloudflare") return new CloudflareSandbox(env, sessionId);
  if (resolution.kind === "remote") return createRemoteSandbox(resolution.type, env, sessionId, envConfig);
  // Relay environments connect lazily on first op; if no runtime is online
  // they throw SandboxProviderUnavailableError, which surfaces as a
  // session.error via the normal turn-processing error path.
  //  - `browser-vm` → relay to a browser tab hosting a WASM VM.
  //  - `subprocess` / `local` → relay to a paired `oma bridge daemon` machine.
  if (resolution.kind === "bridge") {
    return resolution.type === "browser-vm"
      ? new BrowserVmRelaySandbox(env, sessionId, tenantId)
      : new BridgeRelaySandbox(env, sessionId, tenantId);
  }

  throw new SandboxProviderUnavailableError(
    `provider "${resolution.type}" is not available on the Cloudflare deployment; ` +
      `use the self-host runtime (SANDBOX_PROVIDER=${resolution.type}) instead.`,
  );
}

export function createSandbox(
  env: Env,
  sessionId: string,
  envConfig?: CfEnvConfig | null,
  tenantId?: string,
): SandboxExecutor {
  return resolveCfSandbox(env, sessionId, envConfig, tenantId);
}

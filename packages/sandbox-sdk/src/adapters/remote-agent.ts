// RemoteAgentSandbox — BYOK remote machine sandbox adapter.
//
// Communicates with a lightweight HTTP agent running on a remote machine
// (apps/remote-sandbox-agent). The remote agent exposes a minimal REST API
// for executing commands and transferring files on the host.
//
// cfCompatible: true — pure fetch, no Node builtins.
//
// Config (env vars):
//   REMOTE_AGENT_URL  — base URL of the remote agent (e.g. http://10.0.0.1:3000)
//   REMOTE_AGENT_TOKEN — Bearer token for authentication

import type { SandboxExecutor, SandboxFactory } from "../ports";
import { getLogger } from "@duyet/oma-observability";

const moduleLogger = getLogger("remote-agent-sandbox");

export interface RemoteAgentSandboxOptions {
  /** Base URL of the remote agent (e.g. http://10.0.0.1:3000). */
  baseUrl: string;
  /** Bearer token for agent authentication. */
  token?: string;
  /** Default exec timeout in ms. */
  defaultTimeoutMs?: number;
  /** Logger. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

interface ExecResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  signal?: string;
}

export class RemoteAgentSandbox implements SandboxExecutor {
  private logger: NonNullable<RemoteAgentSandboxOptions["logger"]>;

  constructor(private opts: RemoteAgentSandboxOptions) {
    if (!opts.baseUrl) throw new Error("RemoteAgentSandbox: baseUrl required");
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => moduleLogger.warn({ ...(ctx as Record<string, unknown> ?? {}) }, msg),
      log: (msg) => moduleLogger.info(msg),
    };
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const timeoutMs = timeout ?? this.opts.defaultTimeoutMs ?? 120_000;
    const res = await this.fetch("/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ command, timeoutMs }),
    });
    if (!res.ok) {
      throw new Error(`remote-agent exec failed: ${res.status} ${await res.text()}`);
    }
    const data = (await res.json()) as ExecResponse;
    let output = data.stdout;
    if (data.stderr.trim().length > 0) output += `\n${data.stderr}`;
    if (data.exitCode !== 0) {
      const reason = data.signal ? `signal=${data.signal}` : `exit=${data.exitCode}`;
      output += `\n[exit ${reason}]`;
    }
    return output;
  }

  async readFile(path: string): Promise<string> {
    const res = await this.fetch(`/files?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      throw new Error(`remote-agent readFile ${path} failed: ${res.status} ${await res.text()}`);
    }
    return await res.text();
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    const res = await this.fetch(`/files?path=${encodeURIComponent(path)}`);
    if (!res.ok) {
      throw new Error(`remote-agent readFileBytes ${path} failed: ${res.status} ${await res.text()}`);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  async writeFile(path: string, content: string): Promise<string> {
    const res = await this.fetch(`/files?path=${encodeURIComponent(path)}`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: content,
    });
    if (!res.ok) {
      throw new Error(`remote-agent writeFile ${path} failed: ${res.status} ${await res.text()}`);
    }
    return path;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    let bin = "";
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode.apply(
        null,
        bytes.subarray(i, i + CHUNK) as unknown as number[],
      );
    }
    const b64 = btoa(bin);
    const res = await this.fetch(`/files?path=${encodeURIComponent(path)}&base64=true`, {
      method: "PUT",
      headers: { "content-type": "text/plain" },
      body: b64,
    });
    if (!res.ok) {
      throw new Error(`remote-agent writeFileBytes ${path} failed: ${res.status} ${await res.text()}`);
    }
    return path;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    const res = await this.fetch("/env", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ envVars }),
    });
    if (!res.ok) {
      throw new Error(`remote-agent setEnvVars failed: ${res.status} ${await res.text()}`);
    }
  }

  async destroy(): Promise<void> {
    try {
      await this.fetch("/destroy", { method: "POST" });
    } catch (err) {
      this.logger.warn(`remote-agent destroy error: ${(err as Error).message}`);
    }
  }

  async ping(): Promise<{ status: "ok" | "error"; latencyMs: number; details?: string }> {
    const start = performance.now();
    try {
      const res = await this.fetch("/health");
      if (!res.ok) {
        return { status: "error", latencyMs: Math.round(performance.now() - start), details: `${res.status}` };
      }
      return { status: "ok", latencyMs: Math.round(performance.now() - start) };
    } catch (err) {
      return { status: "error", latencyMs: Math.round(performance.now() - start), details: (err as Error).message };
    }
  }

  async setOutboundContext(_opts: { tenantId: string; sessionId: string }): Promise<void> {
    // Outbound credentials are configured on the remote agent's host
    // environment directly (env vars, proxy, etc.).
  }

  async mountMemoryStore(_opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    throw new Error("RemoteAgentSandbox.mountMemoryStore: not supported — mount via the remote host's filesystem");
  }

  async mountSessionOutputs(_opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    throw new Error("RemoteAgentSandbox.mountSessionOutputs: not supported");
  }

  async startProcess(_command: string): Promise<null> {
    return null;
  }

  async createWorkspaceBackup(_opts: { name?: string; ttlSec: number }): Promise<null> {
    return null;
  }

  async restoreWorkspaceBackup(_handle: { id: string; dir: string; localBucket?: boolean }): Promise<{ ok: boolean; error?: string }> {
    return { ok: false };
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}${path}`;
    const headers = new Headers(init.headers);
    if (this.opts.token && !headers.has("Authorization")) {
      headers.set("Authorization", `Bearer ${this.opts.token}`);
    }
    return globalThis.fetch(url, { ...init, headers, redirect: "follow" });
  }
}

// ── Factory (DIP entry point) ───────────────────────────────────────

export const sandboxFactory: SandboxFactory = async (_ctx, env) => {
  const baseUrl = env.REMOTE_AGENT_URL;
  if (!baseUrl) {
    throw new Error(
      "RemoteAgentSandbox: REMOTE_AGENT_URL env var required " +
      "(e.g. http://10.0.0.1:3000)",
    );
  }
  return new RemoteAgentSandbox({
    baseUrl,
    token: env.REMOTE_AGENT_TOKEN,
    defaultTimeoutMs: env.REMOTE_AGENT_TIMEOUT_MS ? Number(env.REMOTE_AGENT_TIMEOUT_MS) : undefined,
  });
};

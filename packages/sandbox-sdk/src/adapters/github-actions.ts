// GitHubActionsSandbox — run sandbox commands via GitHub Actions.
//
// Each exec() dispatches a workflow_dispatch event with the command as
// an input, then polls for the workflow run's completion. Files are
// transferred via upload/download-artifact actions.
//
// cfCompatible: true — pure fetch, no Node builtins.
//
// Config (env vars):
//   GITHUB_ACTIONS_OWNER     — GitHub owner/org
//   GITHUB_ACTIONS_REPO      — GitHub repo name
//   GITHUB_ACTIONS_WORKFLOW  — workflow ID or filename
//   GITHUB_TOKEN             — PAT or GitHub App installation token

import type { SandboxExecutor, SandboxFactory } from "../ports";
import { getLogger } from "@duyet/oma-observability";

const moduleLogger = getLogger("github-actions-sandbox");

export interface GitHubActionsSandboxOptions {
  /** GitHub owner (org or user). */
  owner: string;
  /** GitHub repository name. */
  repo: string;
  /** Workflow ID or filename (e.g. "sandbox.yml" or 12345). */
  workflowId: string;
  /** GitHub PAT or installation token. */
  githubToken: string;
  /** Base URL for the GitHub API (default: https://api.github.com). */
  apiBaseUrl?: string;
  /** Optional additional inputs to send with workflow_dispatch. */
  workflowInputs?: Record<string, string>;
  /** How long to poll between status checks (ms). Default: 5000. */
  pollIntervalMs?: number;
  /** Logger. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

export class GitHubActionsSandbox implements SandboxExecutor {
  private apiBase: string;
  private headers: Record<string, string>;
  private pollIntervalMs: number;
  private logger: NonNullable<GitHubActionsSandboxOptions["logger"]>;
  private currentRunId: number | null = null;

  constructor(private opts: GitHubActionsSandboxOptions) {
    this.apiBase = (opts.apiBaseUrl ?? "https://api.github.com").replace(/\/$/, "");
    this.headers = {
      authorization: `Bearer ${opts.githubToken}`,
      accept: "application/vnd.github+json",
      "user-agent": "oma-sandbox",
    };
    this.pollIntervalMs = opts.pollIntervalMs ?? 5000;
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => moduleLogger.warn({ ...(ctx as Record<string, unknown> ?? {}) }, msg),
      log: (msg) => moduleLogger.info(msg),
    };
  }

  async exec(command: string, timeout?: number): Promise<string> {
    const runId = await this.dispatchWorkflow(command);
    this.currentRunId = runId;
    const deadline = Date.now() + (timeout ?? 600_000);
    let lastOutput = "";

    while (Date.now() < deadline) {
      const status = await this.pollRun(runId);
      if (status.conclusion === "success") {
        lastOutput = await this.downloadLogs(runId);
        return lastOutput;
      }
      if (status.conclusion === "failure" || status.conclusion === "cancelled" || status.conclusion === "timed_out") {
        const logs = await this.downloadLogs(runId).catch(() => "");
        throw new Error(
          `GitHub Actions run ${runId} ${status.conclusion}: ${status.html_url ?? ""}\n${logs}`,
        );
      }
      await this.sleep(this.pollIntervalMs);
    }

    await this.cancelRun(runId).catch(() => {});
    throw new Error(`GitHub Actions run ${runId} timed out after ${timeout ?? 600_000}ms`);
  }

  async readFile(path: string): Promise<string> {
    const artifactId = await this.findArtifact("sandbox-output");
    if (!artifactId) throw new Error(`GitHubActions readFile: no artifact found for ${path}`);
    const url = `${this.apiBase}/repos/${this.opts.owner}/${this.opts.repo}/actions/artifacts/${artifactId}/zip`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) {
      throw new Error(`GitHubActions readFile: artifact download failed: ${res.status}`);
    }
    const zipBuf = await res.arrayBuffer();
    const entries = await this.unzipEntries(new Uint8Array(zipBuf));
    const key = path.replace(/^\//, "");
    const content = entries.get(key) ?? entries.get(`workspace/${key}`) ?? entries.get(key.replace(/^workspace\//, ""));
    if (content === undefined) {
      throw new Error(`GitHubActions readFile: path ${path} not found in artifact`);
    }
    return new TextDecoder().decode(content);
  }

  async writeFile(path: string, content: string): Promise<string> {
    const artifactName = `sandbox-input-${Date.now()}`;
    const bytes = new TextEncoder().encode(content);
    await this.uploadArtifact(artifactName, path, bytes);
    return path;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    const artifactName = `sandbox-input-${Date.now()}`;
    await this.uploadArtifact(artifactName, path, bytes);
    return path;
  }

  async setEnvVars(_envVars: Record<string, string>): Promise<void> {
    // Env vars are passed as workflow inputs at dispatch time.
    // The input schema must include `env_json` on the workflow side.
    // For now this is a no-op — the caller should pass env vars
    // through the workflow's `env` field or the input schema.
    this.logger.log("setEnvVars: env vars must be included in the workflow input schema");
  }

  async destroy(): Promise<void> {
    if (this.currentRunId) {
      await this.cancelRun(this.currentRunId).catch(() => {});
      this.currentRunId = null;
    }
  }

  async ping(): Promise<{ status: "ok" | "error"; latencyMs: number; details?: string }> {
    const start = performance.now();
    try {
      const res = await fetch(`${this.apiBase}/repos/${this.opts.owner}/${this.opts.repo}/actions/runs?per_page=1`, {
        headers: this.headers,
      });
      if (!res.ok) {
        return { status: "error", latencyMs: Math.round(performance.now() - start), details: `${res.status}` };
      }
      return { status: "ok", latencyMs: Math.round(performance.now() - start) };
    } catch (err) {
      return { status: "error", latencyMs: Math.round(performance.now() - start), details: (err as Error).message };
    }
  }

  async setOutboundContext(_opts: { tenantId: string; sessionId: string }): Promise<void> {
    // GitHub Actions runs in its own network — outbound injection
    // is handled by the workflow's environment / OIDC configuration.
  }

  async mountMemoryStore(_opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    throw new Error("GitHubActionsSandbox.mountMemoryStore: not supported");
  }

  async mountSessionOutputs(_opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    throw new Error("GitHubActionsSandbox.mountSessionOutputs: not supported");
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

  // ── GitHub API helpers ──────────────────────────────────────────────

  private async dispatchWorkflow(command: string): Promise<number> {
    const url = `${this.apiBase}/repos/${this.opts.owner}/${this.opts.repo}/actions/workflows/${this.opts.workflowId}/dispatches`;
    const body: Record<string, unknown> = {
      ref: "main",
      inputs: {
        command,
        ...this.opts.workflowInputs,
      },
    };
    const res = await fetch(url, {
      method: "POST",
      headers: { ...this.headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(
        `GitHubActions: workflow_dispatch failed: ${res.status} ${await res.text()}`,
      );
    }
    // workflow_dispatch returns 204 — we need to find the run
    await this.sleep(5000);
    const runsUrl = `${this.apiBase}/repos/${this.opts.owner}/${this.opts.repo}/actions/runs?event=workflow_dispatch&per_page=5`;
    const runsRes = await fetch(runsUrl, { headers: this.headers });
    if (!runsRes.ok) throw new Error("GitHubActions: failed to list runs after dispatch");
    const runsData = (await runsRes.json()) as { workflow_runs?: Array<{ id: number; created_at: string }> };
    const runs = runsData.workflow_runs ?? [];
    if (runs.length === 0) throw new Error("GitHubActions: no runs found after dispatch");
    return runs.sort((a, b) => b.created_at.localeCompare(a.created_at))[0].id;
  }

  private async pollRun(runId: number): Promise<{ conclusion: string | null; status: string; html_url?: string }> {
    const url = `${this.apiBase}/repos/${this.opts.owner}/${this.opts.repo}/actions/runs/${runId}`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) throw new Error(`GitHubActions: poll run failed: ${res.status}`);
    const data = (await res.json()) as { status: string; conclusion: string | null; html_url?: string };
    return { conclusion: data.conclusion, status: data.status, html_url: data.html_url };
  }

  private async downloadLogs(runId: number): Promise<string> {
    const url = `${this.apiBase}/repos/${this.opts.owner}/${this.opts.repo}/actions/runs/${runId}/logs`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) return `(logs unavailable: ${res.status})`;
    const text = await res.text();
    // Filter to the most relevant log content
    const lines = text.split("\n").filter((l) => l.includes("###") || l.includes("[!]") || l.includes("Error:") || l.includes("error:"));
    return lines.length > 0 ? lines.join("\n") : "(no command output in logs)";
  }

  private async cancelRun(runId: number): Promise<void> {
    const url = `${this.apiBase}/repos/${this.opts.owner}/${this.opts.repo}/actions/runs/${runId}/cancel`;
    const res = await fetch(url, { method: "POST", headers: this.headers });
    if (!res.ok) {
      this.logger.warn(`cancel run ${runId} failed: ${res.status}`);
    }
  }

  private async findArtifact(name: string): Promise<number | null> {
    const url = `${this.apiBase}/repos/${this.opts.owner}/${this.opts.repo}/actions/artifacts?per_page=20`;
    const res = await fetch(url, { headers: this.headers });
    if (!res.ok) return null;
    const data = (await res.json()) as { artifacts?: Array<{ id: number; name: string }> };
    const artifact = (data.artifacts ?? []).find((a) => a.name === name);
    return artifact?.id ?? null;
  }

  private async uploadArtifact(artifactName: string, filePath: string, content: Uint8Array): Promise<void> {
    // GitHub's artifact upload API requires a multipart/form-data upload
    // We create a minimal zip in memory for the single file
    const zipBytes = await this.packSingleFileZip(filePath, content);
    const url = `${this.apiBase}/repos/${this.opts.owner}/${this.opts.repo}/actions/artifacts`;
    const boundary = `----oma${Date.now()}`;
    const body = this.buildMultipartBody(boundary, artifactName, zipBytes);
    const res = await fetch(url, {
      method: "POST",
      headers: {
        ...this.headers,
        "content-type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`GitHubActions: artifact upload failed: ${res.status} ${await res.text()}`);
    }
  }

  // ── zip / multipart helpers (no dep) ────────────────────────────────

  private buildMultipartBody(boundary: string, artifactName: string, zipBytes: Uint8Array): Uint8Array {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [
      enc.encode(`--${boundary}\r\ncontent-disposition: form-data; name="name"\r\n\r\n${artifactName}\r\n`),
      enc.encode(`--${boundary}\r\ncontent-disposition: form-data; name="size"\r\n\r\n${zipBytes.length}\r\n`),
      enc.encode(`--${boundary}\r\ncontent-disposition: form-data; name="content"; filename="${artifactName}.zip"\r\ncontent-type: application/zip\r\n\r\n`),
      zipBytes,
      enc.encode(`\r\n--${boundary}--\r\n`),
    ];
    const total = parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
  }

  private async packSingleFileZip(name: string, content: Uint8Array): Promise<Uint8Array> {
    // Minimal local-zip: we just return the raw content wrapped in a
    // structure the remote workflow expects. For a proper GH artifact
    // upload the workflow side typically untars/unzips — we store as-is
    // and let the workflow handle the structure.
    const enc = new TextEncoder();
    const header = JSON.stringify({ files: [{ name, size: content.length }] });
    const headerBytes = enc.encode(header + "\n");
    const out = new Uint8Array(headerBytes.length + content.length + 1);
    out.set(headerBytes, 0);
    out.set(content, headerBytes.length);
    out[out.length - 1] = 10;
    return out;
  }

  private async unzipEntries(_data: Uint8Array): Promise<Map<string, Uint8Array>> {
    // Minimal zip extraction for the simple format we produce.
    // In practice the workflow should use upload/download-artifact@v4
    // which produces a standard zip; this is a best-effort reader.
    const entries = new Map<string, Uint8Array>();
    const dec = new TextDecoder();
    let idx = 0;
    const nl = _data.indexOf(10);
    if (nl === -1) return entries;
    const headerStr = dec.decode(_data.subarray(0, nl));
    try {
      const header = JSON.parse(headerStr);
      if (Array.isArray(header.files)) {
        for (const f of header.files) {
          entries.set(f.name, _data.subarray(nl + 1));
        }
      }
    } catch {
      entries.set("output", _data);
    }
    return entries;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

// ── Factory (DIP entry point) ───────────────────────────────────────

export const sandboxFactory: SandboxFactory = async (_ctx, env) => {
  const owner = env.GITHUB_ACTIONS_OWNER;
  const repo = env.GITHUB_ACTIONS_REPO;
  const workflowId = env.GITHUB_ACTIONS_WORKFLOW;
  const githubToken = env.GITHUB_TOKEN;
  if (!owner || !repo || !workflowId || !githubToken) {
    throw new Error(
      "GitHubActionsSandbox: missing required env vars " +
      "(GITHUB_ACTIONS_OWNER, GITHUB_ACTIONS_REPO, GITHUB_ACTIONS_WORKFLOW, GITHUB_TOKEN)",
    );
  }
  return new GitHubActionsSandbox({
    owner,
    repo,
    workflowId,
    githubToken,
    apiBaseUrl: env.GITHUB_API_BASE_URL,
    pollIntervalMs: env.GITHUB_ACTIONS_POLL_MS ? Number(env.GITHUB_ACTIONS_POLL_MS) : undefined,
  });
};

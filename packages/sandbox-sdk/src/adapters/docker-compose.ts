// DockerComposeSandbox — per-session docker compose sandbox.
//
// Each sandbox instance owns a directory containing a docker-compose.yml
// and an optional docker-compose.override.yml (for env vars). Commands
// execute via `docker compose exec`; files are transferred via `docker cp`.
//
// cfCompatible: false — requires a Docker socket + child_process (Node-only).
//
// Config:
//   DOCKER_COMPOSE_PROJECT_DIR — base directory for per-session compose dirs
//   DOCKER_COMPOSE_SERVICE     — target service name (default "sandbox")
//   SANDBOX_IMAGE              — container image override

import { promises as fs } from "node:fs";
import { execSync, spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import type { SandboxExecutor, SandboxFactory } from "../ports";
import { DEFAULT_SANDBOX_IMAGE } from "../ports";
import { getLogger } from "@duyet/oma-observability";

const moduleLogger = getLogger("docker-compose-sandbox");

export interface DockerComposeSandboxOptions {
  /** Base directory where per-session compose dirs are created. */
  composeProjectDir: string;
  /** Docker compose service name inside compose.yml (default "sandbox"). */
  serviceName?: string;
  /** Container image for the sandbox service. */
  image?: string;
  /** Per-session identifier used for the compose project name and dir. */
  sessionId: string;
  /** Logger. */
  logger?: { warn: (msg: string, ctx?: unknown) => void; log: (msg: string) => void };
}

export class DockerComposeSandbox implements SandboxExecutor {
  private sessionDir: string;
  private serviceName: string;
  private logger: NonNullable<DockerComposeSandboxOptions["logger"]>;
  private destroyed = false;

  constructor(private opts: DockerComposeSandboxOptions) {
    this.sessionDir = join(opts.composeProjectDir, opts.sessionId);
    this.serviceName = opts.serviceName ?? "sandbox";
    this.logger = opts.logger ?? {
      warn: (msg, ctx) => moduleLogger.warn({ ...(ctx as Record<string, unknown> ?? {}) }, msg),
      log: (msg) => moduleLogger.info(msg),
    };
    this.initComposeDir();
  }

  private initComposeDir(): void {
    mkdirSync(this.sessionDir, { recursive: true });
    const composeYml = join(this.sessionDir, "docker-compose.yml");
    try {
      void fs.access(composeYml);
    } catch {
      const image = this.opts.image ?? DEFAULT_SANDBOX_IMAGE;
      writeFileSync(
        composeYml,
        [
          "services:",
          `  ${this.serviceName}:`,
          `    image: ${image}`,
          "    working_dir: /workspace",
          "    entrypoint: [\"tail\", \"-f\", \"/dev/null\"]",
          "    init: true",
          "    network_mode: bridge",
        ].join("\n") + "\n",
      );
      this.logger.log(`compose dir initialised at ${this.sessionDir}`);
    }
  }

  async exec(command: string, timeout?: number): Promise<string> {
    this.assertNotDestroyed();
    const project = this.composeProjectName();
    const timeoutSec = Math.ceil((timeout ?? 120_000) / 1000);
    const args = ["compose", "-p", project, "-f", join(this.sessionDir, "docker-compose.yml")];
    const override = join(this.sessionDir, "docker-compose.override.yml");
    try {
      await fs.access(override);
      args.push("-f", override);
    } catch { /* no override */ }
    args.push("exec", "-T", this.serviceName, "/bin/sh", "-c", command);

    const result = spawnSync("docker", args, {
      cwd: this.sessionDir,
      timeout: timeoutSec * 1000 + 5000,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdout = result.stdout?.toString("utf8") ?? "";
    const stderr = result.stderr?.toString("utf8") ?? "";
    const status = result.status;
    const signal = result.signal;

    let output = stdout;
    if (stderr.trim().length > 0) output += `\n${stderr}`;
    if (status !== 0) {
      const reason = signal ? `signal=${signal}` : `exit=${status}`;
      output += `\n[exit ${reason}]`;
    }
    return output;
  }

  async readFile(path: string): Promise<string> {
    this.assertNotDestroyed();
    const project = this.composeProjectName();
    const containerId = this.resolveContainerId(project);
    const result = spawnSync("docker", [
      "cp",
      `${containerId}:${path}`,
      "-",
    ], {
      cwd: this.sessionDir,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      throw new Error(
        `docker-compose readFile ${path} failed: ${result.stderr?.toString("utf8") ?? result.status}`,
      );
    }
    return result.stdout?.toString("utf8") ?? "";
  }

  async readFileBytes(path: string): Promise<Uint8Array> {
    this.assertNotDestroyed();
    const project = this.composeProjectName();
    const containerId = this.resolveContainerId(project);
    const result = spawnSync("docker", [
      "cp",
      `${containerId}:${path}`,
      "-",
    ], {
      cwd: this.sessionDir,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0) {
      throw new Error(
        `docker-compose readFileBytes ${path} failed: ${result.stderr?.toString("utf8") ?? result.status}`,
      );
    }
    return new Uint8Array(result.stdout?.buffer ?? new ArrayBuffer(0));
  }

  async writeFile(path: string, content: string): Promise<string> {
    this.assertNotDestroyed();
    const project = this.composeProjectName();
    const containerId = this.resolveContainerId(project);
    const tmpDir = join(this.sessionDir, ".tmp");
    mkdirSync(tmpDir, { recursive: true });
    const hostFile = join(tmpDir, "upload");
    writeFileSync(hostFile, content, "utf8");
    const slash = path.lastIndexOf("/");
    const containerDir = slash >= 0 ? path.slice(0, slash) : "/";
    const containerName = slash >= 0 ? path.slice(slash + 1) : path;
    spawnSync("docker", [
      "cp",
      hostFile,
      `${containerId}:${containerDir}/${containerName}`,
    ], {
      cwd: this.sessionDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    rmSync(hostFile, { force: true });
    return path;
  }

  async writeFileBytes(path: string, bytes: Uint8Array): Promise<string> {
    this.assertNotDestroyed();
    const project = this.composeProjectName();
    const containerId = this.resolveContainerId(project);
    const tmpDir = join(this.sessionDir, ".tmp");
    mkdirSync(tmpDir, { recursive: true });
    const hostFile = join(tmpDir, "upload");
    fs.writeFile(hostFile, bytes).catch(() => {
      writeFileSync(hostFile, Buffer.from(bytes));
    });
    const slash = path.lastIndexOf("/");
    const containerDir = slash >= 0 ? path.slice(0, slash) : "/";
    const containerName = slash >= 0 ? path.slice(slash + 1) : path;
    spawnSync("docker", [
      "cp",
      hostFile,
      `${containerId}:${containerDir}/${containerName}`,
    ], {
      cwd: this.sessionDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    rmSync(hostFile, { force: true });
    return path;
  }

  async setEnvVars(envVars: Record<string, string>): Promise<void> {
    this.assertNotDestroyed();
    const overridePath = join(this.sessionDir, "docker-compose.override.yml");
    const existing: Record<string, string> = {};
    try {
      const content = await fs.readFile(overridePath, "utf8");
      const m = content.match(/^\s+([A-Z_][A-Z0-9_]*)=(.+)$/gm);
      if (m) {
        for (const line of m) {
          const [k, ...v] = line.trim().split("=");
          existing[k] = v.join("=");
        }
      }
    } catch { /* no existing override */ }
    Object.assign(existing, envVars);
    const envLines = Object.entries(existing)
      .map(([k, v]) => `      ${k}=${JSON.stringify(v)}`)
      .join("\n");
    writeFileSync(
      overridePath,
      [
        "services:",
        `  ${this.serviceName}:`,
        "    environment:",
        envLines,
      ].join("\n") + "\n",
    );
  }

  async mountMemoryStore(_opts: {
    storeName: string;
    storeId: string;
    readOnly: boolean;
  }): Promise<void> {
    throw new Error(
      "DockerComposeSandbox.mountMemoryStore: not supported — " +
      "add a bind mount to your docker-compose.yml manually.",
    );
  }

  async mountSessionOutputs(_opts: {
    tenantId: string;
    sessionId: string;
  }): Promise<void> {
    throw new Error(
      "DockerComposeSandbox.mountSessionOutputs: not supported — " +
      "add a bind mount to your docker-compose.yml manually.",
    );
  }

  async startProcess(_command: string): Promise<null> {
    return null;
  }

  async createWorkspaceBackup(_opts: {
    name?: string;
    ttlSec: number;
  }): Promise<null> {
    return null;
  }

  async restoreWorkspaceBackup(_handle: {
    id: string;
    dir: string;
    localBucket?: boolean;
  }): Promise<{ ok: boolean; error?: string }> {
    return { ok: false };
  }

  async gitCheckout(_repoUrl: string, _options: { branch?: string; targetDir?: string }): Promise<null> {
    return null;
  }

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

  async destroy(): Promise<void> {
    if (this.destroyed) return;
    this.destroyed = true;
    const project = this.composeProjectName();
    const args = ["compose", "-p", project, "-f", join(this.sessionDir, "docker-compose.yml")];
    const override = join(this.sessionDir, "docker-compose.override.yml");
    try {
      await fs.access(override);
      args.push("-f", override);
    } catch { /* no override */ }
    args.push("down", "--volumes", "--remove-orphans");
    try {
      spawnSync("docker", args, {
        cwd: this.sessionDir,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      });
    } catch (err) {
      this.logger.warn(`docker-compose down failed: ${(err as Error).message}`);
    }
    try {
      rmSync(this.sessionDir, { recursive: true, force: true });
    } catch (err) {
      this.logger.warn(`destroy: failed to remove ${this.sessionDir}: ${(err as Error).message}`);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private composeProjectName(): string {
    return `oma-${this.opts.sessionId.slice(0, 30)}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  }

  private resolveContainerId(project: string): string {
    const args = ["compose", "-p", project, "-f", join(this.sessionDir, "docker-compose.yml")];
    const override = join(this.sessionDir, "docker-compose.override.yml");
    try {
      fs.access(override);
      args.push("-f", override);
    } catch { /* no override */ }
    args.push("ps", "-q", this.serviceName);
    const result = spawnSync("docker", args, {
      cwd: this.sessionDir,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status !== 0 || !result.stdout || result.stdout.length === 0) {
      throw new Error(
        `docker-compose: service ${this.serviceName} not running or not found in project ${project}`,
      );
    }
    return result.stdout.toString("utf8").trim();
  }

  private assertNotDestroyed(): void {
    if (this.destroyed) {
      throw new Error("DockerComposeSandbox: already destroyed");
    }
  }
}

// ── Factory (DIP entry point) ───────────────────────────────────────

export const sandboxFactory: SandboxFactory = async (ctx, env) => {
  const composeProjectDir = env.DOCKER_COMPOSE_PROJECT_DIR ?? "/tmp/oma-compose";
  return new DockerComposeSandbox({
    composeProjectDir,
    serviceName: env.DOCKER_COMPOSE_SERVICE ?? "sandbox",
    image: env.SANDBOX_IMAGE,
    sessionId: ctx.sessionId,
  });
};

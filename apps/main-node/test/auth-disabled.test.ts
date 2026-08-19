// AUTH_DISABLED=1: API runs as tenant_id="default" without x-api-key, /auth-info
// advertises providers: [] so the Console skips login, and leftover /auth/*
// calls return 410 (not 404) instead of a generic "Authentication failed".

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface ProcessHandle {
  child: ChildProcess;
  port: number;
  dataDir: string;
  logBuf: string[];
}

const REPO_ROOT = resolve(__dirname, "../../..");
const MAIN_NODE_ENTRY = join(REPO_ROOT, "apps/main-node/src/index.ts");
const TSX_BIN = join(REPO_ROOT, "apps/main-node/node_modules/.bin/tsx");

describe("main-node AUTH_DISABLED", () => {
  let dataDir: string;
  let h: ProcessHandle | null = null;

  beforeEach(() => {
    dataDir = join(tmpdir(), `oma-test-auth-disabled-${randomBytes(6).toString("hex")}`);
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(async () => {
    if (h) {
      await killHard(h).catch(() => {});
      h = null;
    }
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it("accepts unauthenticated API calls, advertises empty providers, and 410s /auth/*", async () => {
    h = await startMainNode({ dataDir, extraEnv: { CONSOLE_DIR: join(dataDir, "no-console") } });
    const base = `http://localhost:${h.port}`;

    const health = await fetch(`${base}/health`);
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { auth: string };
    expect(healthBody.auth).toBe("disabled");

    const info = await fetch(`${base}/auth-info`);
    expect(info.status).toBe(200);
    const infoBody = (await info.json()) as { providers: string[] };
    expect(infoBody.providers).toEqual([]);

    const signup = await fetch(`${base}/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "trial@example.com",
        password: "password1",
        name: "Trial",
      }),
    });
    expect(signup.status).toBe(410);
    const signupBody = (await signup.json()) as { error: string; message: string };
    expect(signupBody.error).toBe("auth_disabled");
    expect(signupBody.message).toContain("AUTH_DISABLED=1");

    const create = await fetch(`${base}/v1/agents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "hello",
        model: "claude-sonnet-4-6",
        tools: [{ type: "agent_toolset_20260401" }],
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as { id: string };
    expect(typeof created.id).toBe("string");
    expect(created.id.length).toBeGreaterThan(0);

    const me = await fetch(`${base}/v1/me`);
    expect(me.status).toBe(200);
    const meBody = (await me.json()) as {
      user: { id: string; email: string };
      tenant: { id: string };
    };
    expect(meBody.user.id).toBe("default");
    expect(meBody.user.email).toBe("default@local");
    expect(meBody.tenant.id).toBe("default");

    const root = await fetch(`${base}/`);
    expect(root.status).toBe(404);
    const rootBody = (await root.json()) as { error: string };
    expect(rootBody.error).toBe("not found");
  });

  it("serves the Console SPA from CONSOLE_DIR on the API port", async () => {
    const dist = join(dataDir, "console-dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(
      join(dist, "index.html"),
      "<!doctype html><title>oma-console-fixture</title>",
    );
    h = await startMainNode({ dataDir, extraEnv: { CONSOLE_DIR: dist } });
    const res = await fetch(`http://localhost:${h.port}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("oma-console-fixture");
  });
});

async function startMainNode(opts: {
  dataDir: string;
  extraEnv?: Record<string, string>;
}): Promise<ProcessHandle> {
  const port = await pickPort();
  const child = spawn(TSX_BIN, [MAIN_NODE_ENTRY], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      DATABASE_PATH: join(opts.dataDir, "oma.db"),
      AUTH_DATABASE_PATH: join(opts.dataDir, "auth.db"),
      SANDBOX_WORKDIR: join(opts.dataDir, "sandboxes"),
      MEMORY_BLOB_DIR: join(opts.dataDir, "memory-blobs"),
      FILES_BLOB_DIR: join(opts.dataDir, "files-blobs"),
      SESSION_OUTPUTS_DIR: join(opts.dataDir, "outputs"),
      AUTH_DISABLED: "1",
      BETTER_AUTH_SECRET: "test-secret-only-for-vitest",
      PLATFORM_ROOT_SECRET: "test-root-secret-only-for-vitest",
      NODE_ENV: "test",
      ...opts.extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logBuf: string[] = [];
  child.stdout?.on("data", (b: Buffer) => logBuf.push(b.toString()));
  child.stderr?.on("data", (b: Buffer) => logBuf.push(b.toString()));
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://localhost:${port}/health`);
      if (res.ok) {
        await sleep(300);
        return { child, port, dataDir: opts.dataDir, logBuf };
      }
    } catch {
      /* not ready */
    }
    await sleep(200);
  }
  console.error("main-node never became ready. Logs:\n" + logBuf.join(""));
  child.kill("SIGKILL");
  throw new Error(`main-node didn't respond on /health within 30s`);
}

function killHard(handle: ProcessHandle): Promise<void> {
  return new Promise((res) => {
    if (handle.child.exitCode !== null) return res();
    handle.child.once("exit", () => res());
    handle.child.kill("SIGKILL");
  });
}

function pickPort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", rej);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => res(port));
      } else {
        rej(new Error("could not pick port"));
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

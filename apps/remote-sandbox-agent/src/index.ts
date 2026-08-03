// Remote Sandbox Agent — lightweight HTTP server for command execution
// and file transfer on a remote machine. Designed to be paired with
// the RemoteAgentSandbox adapter (packages/sandbox-sdk/src/adapters/remote-agent.ts).
//
// No framework, just the built-in http module. One dependency-less
// binary that any Node 20+ host can run.
//
// Endpoints:
//   POST /exec     — execute a command (child_process.exec)
//   GET  /files    — read a file (full content or base64)
//   PUT  /files    — write a file
//   POST /env      — set environment variables
//   POST /destroy  — clean shutdown
//   GET  /health   — heartbeat (uptime + load)

import * as http from "node:http";
import * as https from "node:https";
import { exec as execCallback } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(execCallback);

// ── Config ───────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
const BEARER_TOKEN = process.env.AGENT_TOKEN ?? process.env.REMOTE_AGENT_TOKEN ?? "";
const ALLOWED_DIRS = (process.env.ALLOWED_DIRS ?? "/workspace,/tmp").split(",").map((s) => path.resolve(s.trim()));
const MAX_BODY = 100 * 1024 * 1024;
const START_TIME = Date.now();

// ── Auth ─────────────────────────────────────────────────────────────

function authenticate(headers: http.IncomingHttpHeaders): boolean {
  if (!BEARER_TOKEN) return true;
  const auth = headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return false;
  return auth.slice(7) === BEARER_TOKEN;
}

function requireAuth(headers: http.IncomingHttpHeaders, res: http.ServerResponse): boolean {
  if (!authenticate(headers)) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return false;
  }
  return true;
}

// ── Helpers ──────────────────────────────────────────────────────────

function safePath(p: string): string {
  const resolved = path.resolve(p);
  for (const dir of ALLOWED_DIRS) {
    if (resolved.startsWith(dir)) return resolved;
  }
  throw new Error(`path ${p} is outside allowed directories (${ALLOWED_DIRS.join(", ")})`);
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function readBodyRaw(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        req.destroy(new Error("body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function jsonResponse(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

// ── Global env store ─────────────────────────────────────────────────

const globalEnv: Record<string, string> = { ...process.env as Record<string, string> };

// ── Route handlers ───────────────────────────────────────────────────

async function handleExec(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: { command: string; timeoutMs?: number };
  try {
    parsed = JSON.parse(body);
  } catch {
    jsonResponse(res, 400, { error: "invalid JSON" });
    return;
  }
  if (!parsed.command || typeof parsed.command !== "string") {
    jsonResponse(res, 400, { error: "command required" });
    return;
  }
  const timeoutMs = parsed.timeoutMs ?? 120_000;
  try {
    const { stdout, stderr } = await execAsync(parsed.command, {
      env: { ...globalEnv },
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    jsonResponse(res, 200, {
      stdout,
      stderr,
      exitCode: 0,
    });
  } catch (err: unknown) {
    const errObj = err as { stdout?: string; stderr?: string; code?: number; signal?: string };
    jsonResponse(res, 200, {
      stdout: errObj.stdout ?? "",
      stderr: errObj.stderr ?? "",
      exitCode: errObj.code ?? 1,
      signal: errObj.signal ?? null,
    });
  }
}

async function handleFilesGet(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const filePath = url.searchParams.get("path");
  if (!filePath) {
    jsonResponse(res, 400, { error: "path query param required" });
    return;
  }
  try {
    const safe = safePath(filePath);
    const content = await fs.promises.readFile(safe);
    const isBase64 = url.searchParams.get("base64") === "true";
    if (isBase64) {
      jsonResponse(res, 200, { content: content.toString("base64"), encoding: "base64" });
    } else {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(content);
    }
  } catch (err: unknown) {
    const msg = (err as Error).message;
    if (msg.includes("outside allowed")) {
      jsonResponse(res, 403, { error: msg });
    } else if (msg.includes("ENOENT")) {
      jsonResponse(res, 404, { error: `file not found: ${filePath}` });
    } else {
      jsonResponse(res, 500, { error: msg });
    }
  }
}

async function handleFilesPut(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const filePath = url.searchParams.get("path");
  if (!filePath) {
    jsonResponse(res, 400, { error: "path query param required" });
    return;
  }
  try {
    const safe = safePath(filePath);
    await fs.promises.mkdir(path.dirname(safe), { recursive: true });

    const isBase64 = url.searchParams.get("base64") === "true";
    if (isBase64) {
      const body = await readBody(req);
      const buf = Buffer.from(body.trim(), "base64");
      await fs.promises.writeFile(safe, buf);
    } else {
      const body = await readBodyRaw(req);
      await fs.promises.writeFile(safe, body);
    }
    jsonResponse(res, 200, { path: filePath, size: (await fs.promises.stat(safe)).size });
  } catch (err: unknown) {
    const msg = (err as Error).message;
    if (msg.includes("outside allowed")) {
      jsonResponse(res, 403, { error: msg });
    } else {
      jsonResponse(res, 500, { error: msg });
    }
  }
}

async function handleEnv(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: { envVars: Record<string, string> };
  try {
    parsed = JSON.parse(body);
  } catch {
    jsonResponse(res, 400, { error: "invalid JSON" });
    return;
  }
  if (!parsed.envVars || typeof parsed.envVars !== "object") {
    jsonResponse(res, 400, { error: "envVars object required" });
    return;
  }
  Object.assign(globalEnv, parsed.envVars);
  jsonResponse(res, 200, { ok: true, count: Object.keys(parsed.envVars).length });
}

async function handleDestroy(_req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  jsonResponse(res, 200, { ok: true, message: "shutting down" });
  setTimeout(() => {
    process.exit(0);
  }, 500);
}

function handleHealth(_req: http.IncomingMessage, res: http.ServerResponse): void {
  const uptime = Math.floor((Date.now() - START_TIME) / 1000);
  jsonResponse(res, 200, {
    status: "ok",
    uptimeSec: uptime,
    loadAvg: osLoadAvg(),
    memory: process.memoryUsage(),
    pid: process.pid,
    version: process.version,
  });
}

function osLoadAvg(): number[] {
  try {
    const content = fs.readFileSync("/proc/loadavg", "utf8");
    const parts = content.trim().split(/\s+/);
    return parts.slice(0, 3).map(Number);
  } catch {
    return [0, 0, 0];
  }
}

// ── Server ───────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  if (!requireAuth(req.headers, res)) return;

  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const method = req.method?.toUpperCase() ?? "GET";

    if (method === "POST" && url.pathname === "/exec") {
      await handleExec(req, res);
    } else if (method === "GET" && url.pathname === "/files") {
      await handleFilesGet(req, res);
    } else if (method === "PUT" && url.pathname === "/files") {
      await handleFilesPut(req, res);
    } else if (method === "POST" && url.pathname === "/env") {
      await handleEnv(req, res);
    } else if (method === "POST" && url.pathname === "/destroy") {
      await handleDestroy(req, res);
    } else if (method === "GET" && url.pathname === "/health") {
      handleHealth(req, res);
    } else {
      jsonResponse(res, 404, { error: "not found" });
    }
  } catch (err) {
    jsonResponse(res, 500, { error: (err as Error).message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Remote Sandbox Agent listening on http://${HOST}:${PORT}`);
  if (BEARER_TOKEN) console.log(" Auth: Bearer token enabled");
  else console.log(" Auth: none (AGENT_TOKEN not set)");
  console.log(` Allowed dirs: ${ALLOWED_DIRS.join(", ")}`);
});

// Graceful shutdown
function shutdown(signal: string): void {
  console.log(`Received ${signal}, shutting down...`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

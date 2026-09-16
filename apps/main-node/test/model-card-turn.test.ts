import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../..");
const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function listen(server: Server): Promise<number> {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing test port");
  return address.port;
}

describe("main-node model-card turns", () => {
  let child: ChildProcess;
  let upstream: Server;
  let dataDir: string;
  let base: string;
  let upstreamBase: string;
  const logs: string[] = [];
  const requests: { path: string; headers: IncomingHttpHeaders; body: { model: string; stream?: boolean } }[] = [];

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "oma-model-card-turn-"));
    upstream = createServer(async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      requests.push({ path: req.url!, headers: req.headers, body });
      if (!body.stream) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const chunk = (choices: unknown[], usage?: unknown) => `data: ${JSON.stringify({
        id: "chatcmpl-test", object: "chat.completion.chunk", created: 1,
        model: body.model, choices, ...(usage ? { usage } : {}),
      })}\n\n`;
      res.end(
        chunk([{ index: 0, delta: { role: "assistant", content: "Model card works." }, finish_reason: null }]) +
        chunk([{ index: 0, delta: {}, finish_reason: "stop" }], { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 }) +
        "data: [DONE]\n\n",
      );
    });
    upstreamBase = `http://127.0.0.1:${await listen(upstream)}`;
    const portProbe = createServer();
    const port = await listen(portProbe);
    await new Promise<void>((done) => portProbe.close(() => done()));
    base = `http://127.0.0.1:${port}`;
    child = spawn(join(REPO_ROOT, "apps/main-node/node_modules/.bin/tsx"), [
      join(REPO_ROOT, "apps/main-node/src/index.ts"),
    ], {
      cwd: REPO_ROOT,
      detached: true,
      env: {
        ...process.env,
        PORT: String(port), HOST: "127.0.0.1", NODE_ENV: "test", AUTH_DISABLED: "1",
        DATABASE_PATH: join(dataDir, "oma.db"), AUTH_DATABASE_PATH: join(dataDir, "auth.db"), DATABASE_URL: "",
        SANDBOX_WORKDIR: join(dataDir, "sandboxes"), SANDBOX_PROVIDER: "subprocess",
        MEMORY_BLOB_DIR: join(dataDir, "memory"), FILES_BLOB_DIR: join(dataDir, "files"),
        SESSION_OUTPUTS_DIR: join(dataDir, "outputs"),
        BETTER_AUTH_SECRET: "test-secret-only-for-vitest", PLATFORM_ROOT_SECRET: "test-root-only-for-vitest",
        ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "", ANTHROPIC_CUSTOM_HEADERS: "",
        ANYROUTER_API_KEY: "", CLAUDE_CODE_OAUTH_TOKEN: "", POOLSIDE_API_KEY: "",
        DEFAULT_HARNESS: "default", OMA_API_COMPAT: "", OPENSHELL_GATEWAY_ENDPOINT: "",
        OTEL_EXPORTER_OTLP_ENDPOINT: "", OMA_VAULT_PROXY_URL: "", MEMORY_S3_BUCKET: "", FILES_S3_BUCKET: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
    child.stderr?.on("data", (chunk) => logs.push(String(chunk)));
    child.on("error", (err) => logs.push(String(err)));
    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(logs.join(""));
      try {
        if ((await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })).ok) return;
      } catch { /* server is starting */ }
      await delay(100);
    }
    throw new Error(`main-node failed to start:\n${logs.join("")}`);
  }, 55_000);

  afterAll(async () => {
    if (child?.pid && child.exitCode === null) {
      const exited = new Promise<void>((done) => child.once("exit", () => done()));
      process.kill(-child.pid, "SIGKILL");
      await exited;
    }
    if (upstream) {
      upstream.closeAllConnections();
      await new Promise<void>((done) => upstream.close(() => done()));
    }
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  async function post(path: string, body: unknown, status: number) {
    const res = await fetch(`${base}${path}`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
    });
    const raw = await res.text();
    const data = raw ? JSON.parse(raw) : null;
    expect(res.status, JSON.stringify(data)).toBe(status);
    return data;
  }

  it("runs an OpenAI-compatible card without any global provider key", async () => {
    const card = await post("/v1/model_cards", {
      model_id: "deepseek-test", model: "deepseek-wire-model", provider: "oai-compatible",
      api_key: "sk-card-test", base_url: `${upstreamBase}/v1`, custom_headers: { "x-card-header": "test" },
    }, 201);
    expect(card.probe.ok).toBe(true);
    requests.length = 0;
    const agent = await post("/v1/agents", {
      name: "Model card regression", model: "deepseek-test", system: "Answer briefly.",
    }, 201);
    const environment = await post("/v1/environments", {
      name: "Local regression sandbox", config: { type: "cloud", sandbox_provider: "subprocess" },
    }, 201);
    const session = await post("/v1/sessions", { agent: agent.id, environment_id: environment.id }, 201);
    await post(`/v1/sessions/${session.id}/events`, {
      events: [{ type: "user.message", content: [{ type: "text", text: "Hello" }] }],
    }, 202);

    let events: { type: string; error?: string; content?: unknown }[] = [];
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const res = await fetch(`${base}/v1/sessions/${session.id}/events`, {
        headers: { accept: "application/json" }, signal: AbortSignal.timeout(1000),
      });
      const data = await res.json();
      events = Array.isArray(data) ? data : data.data;
      if (events.some((e) => e.type === "session.error" || e.type === "agent.message")) break;
      await delay(50);
    }
    expect(events.filter((e) => e.type === "session.error"), logs.join("")).toEqual([]);
    expect(events.some((e) => e.type === "agent.message" && JSON.stringify(e.content).includes("Model card works.")), logs.join("")).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: "/v1/chat/completions",
      headers: { authorization: "Bearer sk-card-test", "x-card-header": "test" },
      body: { model: "deepseek-wire-model", stream: true },
    });
  });
});

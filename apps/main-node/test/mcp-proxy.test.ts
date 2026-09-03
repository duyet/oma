// Unit tests for the Node MCP proxy (apps/main-node/src/mcp-proxy.ts) —
// self-host counterpart to apps/main/src/routes/mcp-proxy.ts's
// resolveProxyTargetByTenant. Exercises the credential-resolution rules
// (inline url wins over registry_id, credential_id pins else URL-match)
// entirely in-memory, with a fake upstream server standing in for the real
// MCP endpoint so we can assert on what actually got forwarded.

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { SessionService } from "@duyet/oma-sessions-store";
import { InMemorySessionRepo } from "@duyet/oma-sessions-store/test-fakes";
import { CredentialService } from "@duyet/oma-credentials-store";
import { InMemoryCredentialRepo } from "@duyet/oma-credentials-store/test-fakes";
import { InMemoryKvStore } from "@duyet/oma-kv-store";
import type { AgentConfig } from "@duyet/oma-shared";
import { buildNodeMcpBinding } from "../src/mcp-proxy";

const TENANT = "tn_test";

function baseAgent(mcpServers: AgentConfig["mcp_servers"]): AgentConfig {
  return {
    id: "agent_1",
    name: "test",
    model: "claude-sonnet-4-6",
    system: "",
    tools: [],
    mcp_servers: mcpServers,
  } as AgentConfig;
}

async function startUpstream(): Promise<{ url: string; close: () => Promise<void>; lastAuth: () => string | undefined }> {
  let lastAuth: string | undefined;
  const server: Server = createServer((req, res) => {
    lastAuth = req.headers.authorization;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
    lastAuth: () => lastAuth,
  };
}

function makeServices() {
  const sessions = new SessionService({ repo: new InMemorySessionRepo() });
  const credentials = new CredentialService({ repo: new InMemoryCredentialRepo() });
  const kv = new InMemoryKvStore();
  return { sessions, credentials, kv };
}

describe("buildNodeMcpBinding", () => {
  let upstream: Awaited<ReturnType<typeof startUpstream>>;

  afterEach(async () => {
    await upstream?.close();
  });

  it("forwards with an inline-url server's matched vault credential", async () => {
    upstream = await startUpstream();
    const { sessions, credentials, kv } = makeServices();

    const vault = await credentials.create({
      tenantId: TENANT,
      vaultId: "vault_1",
      displayName: "linear",
      auth: { type: "static_bearer", mcp_server_url: upstream.url, token: "secret-token" },
    });
    void vault;

    const { session } = await sessions.create({
      tenantId: TENANT,
      agentId: "agent_1",
      environmentId: "env_1",
      vaultIds: ["vault_1"],
      agentSnapshot: baseAgent([{ name: "linear", type: "http", url: upstream.url }]),
    });

    const binding = buildNodeMcpBinding({ sessions, credentials, kv });
    const req = new Request(upstream.url, {
      headers: {
        "x-oma-tenant": TENANT,
        "x-oma-session": session.id,
        "x-oma-mcp-server": "linear",
      },
    });
    const res = await binding.fetch(req);
    expect(res.status).toBe(200);
    expect(upstream.lastAuth()).toBe("Bearer secret-token");
  });

  it("resolves via mcp_servers[].authorization_token, skipping vault lookup entirely", async () => {
    // Regression coverage for issue #196: redacting authorization_token from
    // API *responses* (packages/http-routes/src/mcp-server-redaction.ts)
    // must not touch the agent_snapshot copy this proxy resolves against —
    // the inline literal-token path has to keep working unchanged. No
    // vaultIds at all here, so a pass would be impossible without this
    // exact code path.
    upstream = await startUpstream();
    const { sessions, credentials, kv } = makeServices();

    const { session } = await sessions.create({
      tenantId: TENANT,
      agentId: "agent_1",
      environmentId: "env_1",
      agentSnapshot: baseAgent([
        { name: "linear", type: "http", url: upstream.url, authorization_token: "inline-secret" },
      ]),
    });

    const binding = buildNodeMcpBinding({ sessions, credentials, kv });
    const req = new Request(upstream.url, {
      headers: {
        "x-oma-tenant": TENANT,
        "x-oma-session": session.id,
        "x-oma-mcp-server": "linear",
      },
    });
    const res = await binding.fetch(req);
    expect(res.status).toBe(200);
    expect(upstream.lastAuth()).toBe("Bearer inline-secret");
  });

  it("expands registry_id into a URL and pins the registered credential_id", async () => {
    upstream = await startUpstream();
    const { sessions, credentials, kv } = makeServices();

    // Two credentials in the same vault sharing no mcp_server_url match —
    // only the pinned one should ever be injected.
    await credentials.create({
      tenantId: TENANT,
      vaultId: "vault_1",
      displayName: "wrong",
      auth: { type: "static_bearer", token: "wrong-token" },
    });
    const pinned = await credentials.create({
      tenantId: TENANT,
      vaultId: "vault_1",
      displayName: "right",
      auth: { type: "static_bearer", token: "right-token" },
    });

    await kv.put(
      `mcp_registry:${TENANT}:mcps_1`,
      JSON.stringify({
        id: "mcps_1",
        tenant_id: TENANT,
        name: "linear",
        url: upstream.url,
        credential_id: pinned.id,
        created_at: Date.now(),
      }),
    );

    const { session } = await sessions.create({
      tenantId: TENANT,
      agentId: "agent_1",
      environmentId: "env_1",
      vaultIds: ["vault_1"],
      agentSnapshot: baseAgent([{ name: "linear", type: "http", registry_id: "mcps_1" }]),
    });

    const binding = buildNodeMcpBinding({ sessions, credentials, kv });
    const req = new Request("http://ignored/", {
      headers: {
        "x-oma-tenant": TENANT,
        "x-oma-session": session.id,
        "x-oma-mcp-server": "linear",
      },
    });
    const res = await binding.fetch(req);
    expect(res.status).toBe(200);
    expect(upstream.lastAuth()).toBe("Bearer right-token");
  });

  it("prefers an inline url over registry_id when both are present", async () => {
    upstream = await startUpstream();
    const { sessions, credentials, kv } = makeServices();

    await credentials.create({
      tenantId: TENANT,
      vaultId: "vault_1",
      displayName: "inline",
      auth: { type: "static_bearer", mcp_server_url: upstream.url, token: "inline-token" },
    });
    await kv.put(
      `mcp_registry:${TENANT}:mcps_1`,
      JSON.stringify({
        id: "mcps_1",
        tenant_id: TENANT,
        name: "linear",
        url: "http://should-not-be-used.invalid/mcp",
        created_at: Date.now(),
      }),
    );

    const { session } = await sessions.create({
      tenantId: TENANT,
      agentId: "agent_1",
      environmentId: "env_1",
      vaultIds: ["vault_1"],
      agentSnapshot: baseAgent([
        { name: "linear", type: "http", url: upstream.url, registry_id: "mcps_1" },
      ]),
    });

    const binding = buildNodeMcpBinding({ sessions, credentials, kv });
    const req = new Request("http://ignored/", {
      headers: {
        "x-oma-tenant": TENANT,
        "x-oma-session": session.id,
        "x-oma-mcp-server": "linear",
      },
    });
    const res = await binding.fetch(req);
    expect(res.status).toBe(200);
    expect(upstream.lastAuth()).toBe("Bearer inline-token");
  });

  it("returns 403 for an undeclared server name", async () => {
    const { sessions, credentials, kv } = makeServices();
    const { session } = await sessions.create({
      tenantId: TENANT,
      agentId: "agent_1",
      environmentId: "env_1",
      vaultIds: [],
      agentSnapshot: baseAgent([]),
    });

    const binding = buildNodeMcpBinding({ sessions, credentials, kv });
    const req = new Request("http://ignored/", {
      headers: {
        "x-oma-tenant": TENANT,
        "x-oma-session": session.id,
        "x-oma-mcp-server": "not-declared",
      },
    });
    const res = await binding.fetch(req);
    expect(res.status).toBe(403);
  });

  it("overlay MCP server wins over the agent snapshot", async () => {
    upstream = await startUpstream();
    const { sessions, credentials, kv } = makeServices();

    await credentials.create({
      tenantId: TENANT,
      vaultId: "vault_1",
      displayName: "overlay",
      auth: { type: "static_bearer", mcp_server_url: upstream.url, token: "overlay-token" },
    });

    const { session } = await sessions.create({
      tenantId: TENANT,
      agentId: "agent_1",
      environmentId: "env_1",
      vaultIds: ["vault_1"],
      agentSnapshot: baseAgent([
        { name: "linear", type: "http", url: "http://should-not-be-used.invalid/mcp" },
      ]),
    });
    await sessions.update({
      tenantId: TENANT,
      sessionId: session.id,
      metadata: {
        _oma_injections: {
          prompt_appends: [],
          mcp_servers: [{ name: "linear", url: upstream.url }],
          tool_overrides: {},
          credentials: [],
        },
      },
    });

    const binding = buildNodeMcpBinding({ sessions, credentials, kv });
    const req = new Request("http://ignored/", {
      headers: {
        "x-oma-tenant": TENANT,
        "x-oma-session": session.id,
        "x-oma-mcp-server": "linear",
      },
    });
    const res = await binding.fetch(req);
    expect(res.status).toBe(200);
    expect(upstream.lastAuth()).toBe("Bearer overlay-token");
  });

  it("overlay can mount an MCP server the agent did not declare", async () => {
    upstream = await startUpstream();
    const { sessions, credentials, kv } = makeServices();

    await credentials.create({
      tenantId: TENANT,
      vaultId: "vault_1",
      displayName: "overlay",
      auth: { type: "static_bearer", mcp_server_url: upstream.url, token: "mounted-token" },
    });

    const { session } = await sessions.create({
      tenantId: TENANT,
      agentId: "agent_1",
      environmentId: "env_1",
      vaultIds: ["vault_1"],
      agentSnapshot: baseAgent([]),
    });
    await sessions.update({
      tenantId: TENANT,
      sessionId: session.id,
      metadata: {
        _oma_injections: {
          prompt_appends: [],
          mcp_servers: [{ name: "linear", url: upstream.url }],
          tool_overrides: {},
          credentials: [],
        },
      },
    });

    const binding = buildNodeMcpBinding({ sessions, credentials, kv });
    const req = new Request("http://ignored/", {
      headers: {
        "x-oma-tenant": TENANT,
        "x-oma-session": session.id,
        "x-oma-mcp-server": "linear",
      },
    });
    const res = await binding.fetch(req);
    expect(res.status).toBe(200);
    expect(upstream.lastAuth()).toBe("Bearer mounted-token");
  });

  it("returns 400 when routing headers are missing", async () => {
    const { sessions, credentials, kv } = makeServices();
    const binding = buildNodeMcpBinding({ sessions, credentials, kv });
    const res = await binding.fetch(new Request("http://ignored/"));
    expect(res.status).toBe(400);
  });
});

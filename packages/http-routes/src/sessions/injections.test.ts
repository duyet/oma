// Route-level coverage for GET/POST /v1/sessions/:id/injections — the
// session-scoped operator injection overlay (issue #346).

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildSessionRoutes } from "./index";
import type { RouteServicesArg } from "../types";
import type { SessionRouter } from "@duyet/oma-session-runtime";
import { emptyInjectionOverlay, METADATA_KEY } from "@duyet/oma-api-types";

const TENANT = "tenant-1";
const SESSION_ID = "sess_1";

let knownSession: {
  id: string;
  metadata: Record<string, unknown>;
  vault_ids?: string[];
} | null = { id: SESSION_ID, metadata: {}, vault_ids: ["vlt_1"] };
let updateCalls: Array<{ sessionId: string; metadata?: Record<string, unknown> }> = [];
let configUpdatedCalls: Array<{ sessionId: string; event: unknown }> = [];
let vaultCredentialIds: string[] = ["cred_1"];

function mergeMetadata(
  existing: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...existing };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else out[k] = v;
  }
  return out;
}

function makeApp() {
  const services = {
    sessions: {
      get: async ({ sessionId }: { sessionId: string }) =>
        knownSession && knownSession.id === sessionId ? knownSession : null,
      update: async ({
        sessionId,
        metadata,
      }: {
        sessionId: string;
        metadata?: Record<string, unknown>;
      }) => {
        updateCalls.push({ sessionId, metadata });
        if (!knownSession || knownSession.id !== sessionId) return null;
        if (metadata) {
          knownSession = {
            ...knownSession,
            metadata: mergeMetadata(knownSession.metadata, metadata),
          };
        }
        return knownSession;
      },
    },
    credentials: {
      listByVaults: async () => [
        {
          vault_id: "vlt_1",
          credentials: vaultCredentialIds.map((id) => ({
            id,
            archived_at: null,
          })),
        },
      ],
    },
  } as unknown as RouteServicesArg;

  const router: Partial<SessionRouter> = {
    getFullStatus: async () => null,
    recordConfigUpdated: async (sessionId, event) => {
      configUpdatedCalls.push({ sessionId, event });
      return { status: 200, body: "{}" };
    },
  };

  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route("/v1/sessions", buildSessionRoutes({ services, router: router as SessionRouter }));
  return app;
}

function post(app: Hono<{ Variables: { tenant_id: string } }>, body: unknown, id = SESSION_ID) {
  return app.request(`/v1/sessions/${id}/injections`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("GET/POST /v1/sessions/:id/injections", () => {
  beforeEach(() => {
    knownSession = { id: SESSION_ID, metadata: {}, vault_ids: ["vlt_1"] };
    updateCalls = [];
    configUpdatedCalls = [];
    vaultCredentialIds = ["cred_1"];
  });

  it("returns an empty overlay when none has been applied", async () => {
    const app = makeApp();
    const res = await app.request(`/v1/sessions/${SESSION_ID}/injections`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(emptyInjectionOverlay());
  });

  it("appends a system prompt and records a config_updated audit event", async () => {
    const app = makeApp();
    const res = await post(app, { type: "system_prompt_append", text: "Run npm test." });
    expect(res.status).toBe(200);
    const overlay = await res.json() as {
      prompt_appends: Array<{ id: string; text: string; injected_at: string }>;
    };
    expect(overlay.prompt_appends).toHaveLength(1);
    expect(overlay.prompt_appends[0].text).toBe("Run npm test.");
    expect(overlay.prompt_appends[0].id).toMatch(/^inj_/);
    expect(updateCalls).toHaveLength(1);
    expect(configUpdatedCalls).toHaveLength(1);
    const ev = configUpdatedCalls[0].event as {
      type: string;
      operator_injection: true;
      detail: { system_prompt_append?: { id: string } };
    };
    expect(ev.type).toBe("session.config_updated");
    expect(ev.operator_injection).toBe(true);
    expect(JSON.stringify(ev)).not.toContain("Run npm test.");
    expect(ev.detail.system_prompt_append?.id).toBe(overlay.prompt_appends[0].id);
  });

  it("upserts MCP by name", async () => {
    const app = makeApp();
    await post(app, {
      type: "mcp_server_add",
      name: "linear",
      url: "https://a.example/mcp",
    });
    const res = await post(app, {
      type: "mcp_server_add",
      name: "linear",
      url: "https://b.example/mcp",
      registry_id: "mcps_1",
    });
    expect(res.status).toBe(200);
    const overlay = await res.json() as { mcp_servers: unknown[] };
    expect(overlay.mcp_servers).toEqual([
      { name: "linear", url: "https://b.example/mcp", registry_id: "mcps_1" },
    ]);
  });

  it("merges tool overrides across posts", async () => {
    const app = makeApp();
    await post(app, { type: "tools_update", enabled: ["browser"], disabled: ["web_search"] });
    const res = await post(app, { type: "tools_update", enabled: ["web_search"] });
    const overlay = await res.json() as { tool_overrides: Record<string, boolean> };
    expect(overlay.tool_overrides).toEqual({ browser: true, web_search: true });
  });

  it("normalizes credential host to a lowercase hostname", async () => {
    const app = makeApp();
    const res = await post(app, {
      type: "credential_inject",
      host: "https://API.Example.com/v1/foo",
      credential_id: "cred_1",
    });
    expect(res.status).toBe(200);
    const overlay = await res.json() as {
      credentials: Array<{ host: string; credential_id: string }>;
    };
    expect(overlay.credentials).toEqual([
      { host: "api.example.com", credential_id: "cred_1" },
    ]);
    expect(JSON.stringify(overlay)).not.toMatch(/token|secret|Bearer/i);
  });

  it("returns 404 for an unknown session", async () => {
    const app = makeApp();
    const get = await app.request(`/v1/sessions/sess_missing/injections`);
    expect(get.status).toBe(404);
    const res = await post(app, { type: "system_prompt_append", text: "x" }, "sess_missing");
    expect(res.status).toBe(404);
    expect(updateCalls).toHaveLength(0);
  });

  it("returns 400 on an unparseable body", async () => {
    const app = makeApp();
    const res = await post(app, "not json");
    expect(res.status).toBe(400);
    expect(updateCalls).toHaveLength(0);
  });

  it("returns 422 for invalid commands", async () => {
    const app = makeApp();
    const emptyPrompt = await post(app, { type: "system_prompt_append", text: "" });
    expect(emptyPrompt.status).toBe(422);
    const mcp = await post(app, { type: "mcp_server_add", name: "linear" });
    expect(mcp.status).toBe(422);
    const tools = await post(app, { type: "tools_update" });
    expect(tools.status).toBe(422);
    const cred = await post(app, { type: "credential_inject", host: "", credential_id: "cred_1" });
    expect(cred.status).toBe(422);
    expect(updateCalls).toHaveLength(0);
  });

  it("rejects a credential_id that is not in the session vaults", async () => {
    const app = makeApp();
    const res = await post(app, {
      type: "credential_inject",
      host: "api.example.com",
      credential_id: "cred_other",
    });
    expect(res.status).toBe(422);
    expect(updateCalls).toHaveLength(0);
  });

  it("rejects mcp_server_add when the pinned credential is not in the session vaults", async () => {
    const app = makeApp();
    const res = await post(app, {
      type: "mcp_server_add",
      name: "linear",
      url: "https://linear.app/mcp",
      credential_id: "cred_other",
    });
    expect(res.status).toBe(422);
    expect(updateCalls).toHaveLength(0);
  });

  it("accepts PATCH /v1/sessions/:id/tools as a tools_update alias", async () => {
    const app = makeApp();
    const res = await app.request(`/v1/sessions/${SESSION_ID}/tools`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled_tools: ["browser"], disabled_tools: ["web_search"] }),
    });
    expect(res.status).toBe(200);
    const overlay = await res.json() as { tool_overrides: Record<string, boolean> };
    expect(overlay.tool_overrides).toEqual({ browser: true, web_search: false });
    expect(configUpdatedCalls).toHaveLength(1);
    const ev = configUpdatedCalls[0].event as { type: string; changes: string[] };
    expect(ev.type).toBe("session.config_updated");
    expect(ev.changes).toEqual(["tools_updated"]);
  });

  it("strips _oma_injections from GET /v1/sessions/:id metadata", async () => {
    knownSession = {
      id: SESSION_ID,
      metadata: { team: "ops", [METADATA_KEY]: { prompt_appends: [] } },
    };
    const app = makeApp();
    const res = await app.request(`/v1/sessions/${SESSION_ID}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { metadata: Record<string, unknown> };
    expect(body.metadata).toEqual({ team: "ops" });
    expect(body.metadata).not.toHaveProperty(METADATA_KEY);
  });

  it("ignores _oma_injections on POST /v1/sessions/:id metadata updates", async () => {
    knownSession = {
      id: SESSION_ID,
      metadata: { team: "ops", [METADATA_KEY]: { prompt_appends: [{ id: "inj_keep", text: "keep", injected_at: "t" }] } },
    };
    const app = makeApp();
    const res = await app.request(`/v1/sessions/${SESSION_ID}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        metadata: { team: "new", [METADATA_KEY]: { prompt_appends: [] } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { metadata: Record<string, unknown> };
    expect(body.metadata).toEqual({ team: "new" });
    expect(knownSession.metadata[METADATA_KEY]).toEqual({
      prompt_appends: [{ id: "inj_keep", text: "keep", injected_at: "t" }],
    });
  });
});

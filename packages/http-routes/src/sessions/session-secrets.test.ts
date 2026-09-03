// Route-level coverage for POST /v1/sessions env / github secret persistence
// (issue #426). Create used to drop `.value` / `authorization_token` before
// the session-secrets store, so consumers always read null.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  createInMemorySessionService,
  ManualClock,
} from "@duyet/oma-sessions-store/test-fakes";
import { createInMemorySessionSecretService } from "@duyet/oma-session-secrets-store/test-fakes";
import type { SessionService } from "@duyet/oma-sessions-store";
import type { SessionSecretService } from "@duyet/oma-session-secrets-store";
import { buildSessionRoutes } from "./index";
import type { SessionRouter } from "@duyet/oma-session-runtime";
import type { RouteServices } from "../types";

const TENANT = "tenant-1";
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

function makeApp(service: SessionService, sessionSecrets?: SessionSecretService) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  const agents = {
    get: async ({ agentId }: { tenantId: string; agentId: string }) => ({
      id: agentId,
      tenant_id: TENANT,
      name: "Test Agent",
      model: "claude-sonnet-4-6",
      version: 1,
      metadata: {},
    }),
  };
  const router = {
    init: async () => {},
    destroy: async () => {},
    getFullStatus: async () => null,
  } as unknown as SessionRouter;
  app.route(
    "/v1/sessions",
    buildSessionRoutes({
      services: { sessions: service, agents, sessionSecrets } as unknown as RouteServices,
      router,
      loadEnvironment: async ({ environmentId }) =>
        ({
          id: environmentId,
          name: "Env",
          type: "environment",
          config: { type: "cloud" },
          created_at: new Date(BASE).toISOString(),
        }) as never,
    }),
  );
  return app;
}

function postSession(app: Hono<never>, body: unknown) {
  return app.request("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/sessions secret persistence (issue #426)", () => {
  it("stores env_secret.value in the session secret store and omits it from the response", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const { service: sessionSecrets } = createInMemorySessionSecretService();
    const app = makeApp(service, sessionSecrets);

    const secret = "env-secret-not-for-response";
    const res = await postSession(app as never, {
      agent: "agent_1",
      environment_id: "env_1",
      resources: [{ type: "env_secret", name: "MY_API_KEY", value: secret }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      resources: Array<{ id: string; type: string; name?: string; value?: string }>;
    };
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0].type).toBe("env");
    expect(body.resources[0].name).toBe("MY_API_KEY");
    expect(body.resources[0].value).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(secret);

    const stored = await sessionSecrets.get({
      tenantId: TENANT,
      sessionId: body.id,
      resourceId: body.resources[0].id,
    });
    expect(stored).toBe(secret);
  });

  it("stores github_repository.authorization_token in the session secret store", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const { service: sessionSecrets } = createInMemorySessionSecretService();
    const app = makeApp(service, sessionSecrets);

    const token = "ghp_not-for-response";
    const res = await postSession(app as never, {
      agent: "agent_1",
      environment_id: "env_1",
      resources: [{
        type: "github_repository",
        url: "https://github.com/acme/widgets",
        authorization_token: token,
      }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      resources: Array<{ id: string; type: string; authorization_token?: string }>;
    };
    expect(body.resources).toHaveLength(1);
    expect(body.resources[0].authorization_token).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain(token);

    const stored = await sessionSecrets.get({
      tenantId: TENANT,
      sessionId: body.id,
      resourceId: body.resources[0].id,
    });
    expect(stored).toBe(token);
  });

  it("stores mixed env_secret and github_repository tokens against the matching resource ids", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const { service: sessionSecrets } = createInMemorySessionSecretService();
    const app = makeApp(service, sessionSecrets);

    const envValue = "mixed-env-value";
    const gitToken = "ghp_mixed-git-token";
    const res = await postSession(app as never, {
      agent: "agent_1",
      environment_id: "env_1",
      resources: [
        {
          type: "github_repository",
          url: "https://github.com/acme/widgets",
          authorization_token: gitToken,
        },
        { type: "env_secret", name: "MIX_KEY", value: envValue },
      ],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      resources: Array<{ id: string; type: string; name?: string }>;
    };
    expect(JSON.stringify(body)).not.toContain(envValue);
    expect(JSON.stringify(body)).not.toContain(gitToken);

    const gitRow = body.resources.find((r) => r.type === "github_repository");
    const envRow = body.resources.find((r) => r.type === "env");
    expect(gitRow).toBeTruthy();
    expect(envRow).toBeTruthy();
    expect(await sessionSecrets.get({
      tenantId: TENANT,
      sessionId: body.id,
      resourceId: gitRow!.id,
    })).toBe(gitToken);
    expect(await sessionSecrets.get({
      tenantId: TENANT,
      sessionId: body.id,
      resourceId: envRow!.id,
    })).toBe(envValue);
  });

  it("accepts type=env as the canonical write alias of env_secret", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const { service: sessionSecrets } = createInMemorySessionSecretService();
    const app = makeApp(service, sessionSecrets);

    const secret = "canonical-env-value";
    const res = await postSession(app as never, {
      agent: "agent_1",
      environment_id: "env_1",
      resources: [{ type: "env", name: "CANONICAL", value: secret }],
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      resources: Array<{ id: string; type: string }>;
    };
    expect(body.resources[0].type).toBe("env");
    const stored = await sessionSecrets.get({
      tenantId: TENANT,
      sessionId: body.id,
      resourceId: body.resources[0].id,
    });
    expect(stored).toBe(secret);
  });

  it("returns 500 when secret payloads are present but the store is unwired", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const app = makeApp(service);

    const res = await postSession(app as never, {
      agent: "agent_1",
      environment_id: "env_1",
      resources: [{ type: "env_secret", name: "UNWIRED", value: "must-not-drop" }],
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/session secret store is not configured/);
    expect(JSON.stringify(body)).not.toContain("must-not-drop");
  });

  it("DELETE cascades session secrets without echoing plaintext", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const { service: sessionSecrets } = createInMemorySessionSecretService();
    const app = makeApp(service, sessionSecrets);

    const secret = "delete-cascade-secret";
    const created = await postSession(app as never, {
      agent: "agent_1",
      environment_id: "env_1",
      resources: [{ type: "env_secret", name: "TO_DELETE", value: secret }],
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      id: string;
      resources: Array<{ id: string }>;
    };

    const del = await app.request(`/v1/sessions/${body.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(JSON.stringify(await del.json())).not.toContain(secret);

    expect(await sessionSecrets.get({
      tenantId: TENANT,
      sessionId: body.id,
      resourceId: body.resources[0].id,
    })).toBeNull();
  });
});

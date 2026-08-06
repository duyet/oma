// Route-level coverage for POST /v1/sessions `metadata` pass-through
// (issue #252). The create handler used to silently drop body.metadata —
// publication session-create forwards publication_id/end_user_id there, so
// dropping it broke per_1k_tokens post-turn wallet resolution and notify
// webhook envelopes for exactly the public sessions the paywall covers.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  createInMemorySessionService,
  ManualClock,
} from "@duyet/oma-sessions-store/test-fakes";
import type { SessionService } from "@duyet/oma-sessions-store";
import { buildSessionRoutes } from "./index";
import type { SessionRouter, SessionInitParams } from "@duyet/oma-session-runtime";
import type { RouteServices } from "../types";

const TENANT = "tenant-1";
const BASE = Date.UTC(2026, 0, 1, 0, 0, 0);

function makeApp(service: SessionService, initCalls: SessionInitParams[]) {
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
      metadata: agentId === "agent_with_default"
        ? { default_environment_id: "env_from_agent" }
        : {},
    }),
  };
  const router = {
    init: async (_sessionId: string, params: SessionInitParams) => {
      initCalls.push(params);
    },
    getFullStatus: async () => null,
  } as unknown as SessionRouter;
  app.route(
    "/v1/sessions",
    buildSessionRoutes({
      services: { sessions: service, agents } as unknown as RouteServices,
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

describe("POST /v1/sessions metadata pass-through (issue #252)", () => {
  it("stamps body.metadata onto the created session row and echoes it in the response", async () => {
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const initCalls: SessionInitParams[] = [];
    const app = makeApp(service, initCalls);

    const res = await postSession(app as never, {
      agent: "agent_1",
      environment_id: "env_1",
      metadata: { publication_id: "pub_1", end_user_id: "eu_1" },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; metadata: Record<string, unknown> };
    expect(body.metadata).toEqual({ publication_id: "pub_1", end_user_id: "eu_1" });

    // Row carries it — this is what resolveSessionMetadata / the post-turn
    // debit read.
    const row = await repo.get(TENANT, body.id);
    expect(row?.metadata).toEqual({ publication_id: "pub_1", end_user_id: "eu_1" });

    // And the DO /init mirror (issue #222) receives the same bag.
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0].metadata).toEqual({ publication_id: "pub_1", end_user_id: "eu_1" });
  });

  it("no metadata in the body → row stays null, response defaults to {}", async () => {
    const { service, repo } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const app = makeApp(service, []);

    const res = await postSession(app as never, { agent: "agent_1", environment_id: "env_1" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; metadata: Record<string, unknown> };
    expect(body.metadata).toEqual({});
    const row = await repo.get(TENANT, body.id);
    expect(row?.metadata ?? null).toBeNull();
  });

  it("rejects non-object metadata with 400", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const app = makeApp(service, []);

    for (const bad of [["a"], "string", 42, null]) {
      const res = await postSession(app as never, {
        agent: "agent_1",
        environment_id: "env_1",
        metadata: bad,
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("metadata must be a plain object");
    }
  });
});

describe("POST /v1/sessions environment resolution (sandbox-runtime-selection)", () => {
  it("uses agent.metadata.default_environment_id when body omits environment_id", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const initCalls: SessionInitParams[] = [];
    const app = makeApp(service, initCalls);

    const res = await postSession(app as never, { agent: "agent_with_default" });
    expect(res.status).toBe(201);
    expect(initCalls).toHaveLength(1);
    expect(initCalls[0].environmentId).toBe("env_from_agent");
  });

  it("body.environment_id still wins over the agent default", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const initCalls: SessionInitParams[] = [];
    const app = makeApp(service, initCalls);

    const res = await postSession(app as never, {
      agent: "agent_with_default",
      environment_id: "env_explicit",
    });
    expect(res.status).toBe(201);
    expect(initCalls[0].environmentId).toBe("env_explicit");
  });

  it("returns 400 when neither body nor agent default supplies an environment", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const app = makeApp(service, []);

    const res = await postSession(app as never, { agent: "agent_1" });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; hint?: string };
    expect(body.error).toBe("environment_id is required");
    expect(body.hint).toMatch(/default_environment_id/);
  });
});


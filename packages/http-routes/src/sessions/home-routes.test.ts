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
      metadata: { default_environment_id: "env_from_agent" },
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

describe("GET/POST /v1/sessions/home (issue #460)", () => {
  it("creates a home session once and reuses it", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const initCalls: SessionInitParams[] = [];
    const app = makeApp(service, initCalls);

    const first = await app.request("/v1/sessions/home", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "agent_1" }),
    });
    expect(first.status).toBe(201);
    const created = (await first.json()) as {
      created: boolean;
      session: { id: string; metadata: Record<string, unknown>; title: string };
    };
    expect(created.created).toBe(true);
    expect(created.session.metadata.home).toBe(true);
    expect(created.session.title).toBe("Home");
    expect(initCalls).toHaveLength(1);

    const second = await app.request("/v1/sessions/home", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: "agent_1" }),
    });
    expect(second.status).toBe(200);
    const reused = (await second.json()) as {
      created: boolean;
      session: { id: string };
    };
    expect(reused.created).toBe(false);
    expect(reused.session.id).toBe(created.session.id);
    expect(initCalls).toHaveLength(1);

    const get = await app.request("/v1/sessions/home?agent_id=agent_1");
    expect(get.status).toBe(200);
    const body = (await get.json()) as { session: { id: string }; created: boolean };
    expect(body.session.id).toBe(created.session.id);
    expect(body.created).toBe(false);
  });

  it("GET without a home session is 404", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const app = makeApp(service, []);
    const res = await app.request("/v1/sessions/home?agent_id=agent_1");
    expect(res.status).toBe(404);
  });

  it("POST /v1/sessions with metadata.home reuses the same row", async () => {
    const { service } = createInMemorySessionService({ clock: new ManualClock(BASE) });
    const app = makeApp(service, []);
    const first = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "agent_1",
        environment_id: "env_1",
        metadata: { home: true },
        title: "Home",
      }),
    });
    expect(first.status).toBe(201);
    const a = (await first.json()) as { id: string };
    const second = await app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: "agent_1",
        environment_id: "env_1",
        metadata: { home: true },
      }),
    });
    expect(second.status).toBe(200);
    const b = (await second.json()) as { id: string };
    expect(b.id).toBe(a.id);
  });
});

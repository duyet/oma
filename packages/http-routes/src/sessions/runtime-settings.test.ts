// Route-level coverage for PATCH /v1/sessions/:id/runtime — the
// session-scoped model / reasoning-effort switch. Exercises the happy
// path, the null-clears-the-override contract, validation, the 409
// in-flight-turn conflict passed through from the runtime, the 404
// unknown-session path, and the 501 returned by runtimes that don't
// implement the optional `updateRuntimeSettings` seam (self-host Node).

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildSessionRoutes } from "./index";
import type { RouteServicesArg } from "../types";
import type { SessionRouter } from "@duyet/oma-session-runtime";

const TENANT = "tenant-1";
const SESSION_ID = "sess_1";

let knownSession: { id: string } | null = { id: SESSION_ID };
let updateResult: { status: number; body: string };
let updateCalls: Array<{ sessionId: string; settings: unknown }> = [];

function makeApp(opts: { supported?: boolean } = {}) {
  const services = {
    sessions: {
      get: async ({ sessionId }: { sessionId: string }) =>
        knownSession && knownSession.id === sessionId ? knownSession : null,
    },
  } as unknown as RouteServicesArg;

  const router: Partial<SessionRouter> = {};
  if (opts.supported !== false) {
    router.updateRuntimeSettings = async (sessionId, settings) => {
      updateCalls.push({ sessionId, settings });
      return updateResult;
    };
  }

  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route("/v1/sessions", buildSessionRoutes({ services, router: router as SessionRouter }));
  return app;
}

function patch(app: Hono<{ Variables: { tenant_id: string } }>, body: unknown, id = SESSION_ID) {
  return app.request(`/v1/sessions/${id}/runtime`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("PATCH /v1/sessions/:id/runtime", () => {
  beforeEach(() => {
    knownSession = { id: SESSION_ID };
    updateResult = {
      status: 200,
      body: JSON.stringify({ model: "claude-opus-4-6", reasoning_effort: "high" }),
    };
    updateCalls = [];
  });

  it("forwards model + reasoning_effort to the runtime and echoes its body", async () => {
    const app = makeApp();
    const res = await patch(app, { model: "claude-opus-4-6", reasoning_effort: "high" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ model: "claude-opus-4-6", reasoning_effort: "high" });
    expect(updateCalls).toEqual([
      {
        sessionId: SESSION_ID,
        settings: { model: "claude-opus-4-6", reasoningEffort: "high" },
      },
    ]);
  });

  it("passes null through so the runtime clears the override", async () => {
    const app = makeApp();
    await patch(app, { model: null, reasoning_effort: null });
    expect(updateCalls[0].settings).toEqual({ model: null, reasoningEffort: null });
  });

  it("omits keys the caller did not send, leaving those overrides untouched", async () => {
    const app = makeApp();
    await patch(app, { reasoning_effort: "low" });
    expect(updateCalls[0].settings).toEqual({ reasoningEffort: "low" });
  });

  it("rejects a non-string, non-null value with 422", async () => {
    const app = makeApp();
    const res = await patch(app, { model: 42 });
    expect(res.status).toBe(422);
    expect(updateCalls).toHaveLength(0);
  });

  it("rejects a blank model with 422 rather than storing an empty override", async () => {
    const app = makeApp();
    const res = await patch(app, { model: "   " });
    expect(res.status).toBe(422);
    expect(updateCalls).toHaveLength(0);
  });

  it("returns 400 on an unparseable body", async () => {
    const app = makeApp();
    const res = await patch(app, "not json");
    expect(res.status).toBe(400);
  });

  it("passes the runtime's 409 through when a turn is in flight", async () => {
    const app = makeApp();
    updateResult = {
      status: 409,
      body: JSON.stringify({
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "Cannot change model while a turn is in flight",
        },
      }),
    };
    const res = await patch(app, { model: "claude-opus-4-6" });
    expect(res.status).toBe(409);
  });

  it("returns 404 for an unknown session without calling the runtime", async () => {
    const app = makeApp();
    const res = await patch(app, { model: "x" }, "sess_missing");
    expect(res.status).toBe(404);
    expect(updateCalls).toHaveLength(0);
  });

  it("returns 501 when the runtime does not implement the seam", async () => {
    const app = makeApp({ supported: false });
    const res = await patch(app, { model: "claude-opus-4-6" });
    expect(res.status).toBe(501);
  });
});

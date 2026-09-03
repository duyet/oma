// GET /v1/sessions/:id overlays `outputs[]` from getFullStatus, derived
// from `agent.output_declared` events at read time (issue #341). No new
// table — the route copies whatever the runtime projected.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { buildSessionRoutes } from "./index";
import type { RouteServicesArg } from "../types";
import type { SessionRouter, SessionFullStatus } from "@duyet/oma-session-runtime";

const TENANT = "tenant-1";
const SESSION_ID = "sess_1";

function makeApp(opts: {
  outputs?: SessionFullStatus["outputs"];
  live?: SessionFullStatus | null;
} = {}) {
  const services = {
    sessions: {
      get: async ({ sessionId }: { sessionId: string }) =>
        sessionId === SESSION_ID
          ? {
              id: SESSION_ID,
              agent_id: "agent_1",
              environment_id: "env_1",
              status: "idle",
              created_at: new Date().toISOString(),
            }
          : null,
    },
  } as unknown as RouteServicesArg;

  const router: Partial<SessionRouter> = {
    getFullStatus: async () => {
      if (opts.live === null) return null;
      if (opts.live) return opts.live;
      return {
        status: "idle",
        usage: { input_tokens: 0, output_tokens: 0 },
        sandbox_status: "running",
        outputs: opts.outputs,
      };
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

describe("GET /v1/sessions/:id — declared outputs overlay (issue #341)", () => {
  it("always includes outputs[] even when the runtime projected none", async () => {
    const app = makeApp({ outputs: undefined });
    const res = await app.request(`/v1/sessions/${SESSION_ID}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { outputs: unknown };
    expect(json.outputs).toEqual([]);
  });

  it("forwards outputs[] from getFullStatus without the inline data payload", async () => {
    const app = makeApp({
      outputs: [
        {
          path: "/workspace/output/report.pdf",
          description: "Weekly metrics digest",
          media_type: "application/pdf",
          size_bytes: 89432,
          declared_at: "2026-08-03T14:32:00Z",
          tool_use_id: "toolu_1",
        },
      ],
    });
    const res = await app.request(`/v1/sessions/${SESSION_ID}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      outputs: Array<{ path: string; description?: string; data?: string }>;
    };
    expect(json.outputs).toHaveLength(1);
    expect(json.outputs[0].path).toBe("/workspace/output/report.pdf");
    expect(json.outputs[0].description).toBe("Weekly metrics digest");
    expect(json.outputs[0].data).toBeUndefined();
  });

  it("returns outputs: [] when the runtime is unreachable", async () => {
    const app = makeApp({ live: null });
    const res = await app.request(`/v1/sessions/${SESSION_ID}`);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { outputs: unknown };
    expect(json.outputs).toEqual([]);
  });
});

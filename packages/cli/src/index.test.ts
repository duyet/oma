// Command-level tests for the `oma schedules …` verbs. Importing `index.ts`
// is safe because the module skips its `main()` auto-exec when VITEST is set
// (see the guard at the bottom of index.ts). We look each command up by its
// `match` tokens and drive its `run` with a stubbed global fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { commands } from "./index";

const config = {
  baseUrl: "https://api.test",
  apiKey: "omak_test",
  json: false,
  source: "env" as const,
};

/** Find a command by its exact match-token sequence. */
function cmd(...match: string[]) {
  const c = commands.find(
    (x) => x.match.length === match.length && x.match.every((t, i) => t === match[i]),
  );
  if (!c) throw new Error(`command not found: ${match.join(" ")}`);
  return c;
}

interface Captured {
  url: string;
  method: string;
  body: unknown;
}

let captured: Captured[];

beforeEach(() => {
  captured = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      captured.push({
        url,
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      // Echo a plausible schedule/response body for each verb.
      return new Response(
        JSON.stringify({
          id: "sch_abc",
          cron_expression: "0 9 * * 1",
          next_run_at: "2026-07-20T09:00:00Z",
          status: "queued",
          data: [
            {
              id: "sch_abc",
              cron_expression: "0 9 * * 1",
              timezone: "UTC",
              enabled: 1,
              next_run_at: "2026-07-20T09:00:00Z",
              last_run_status: "ok",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("oma sessions message", () => {
  /** Respond with exactly what the platform sends back: `202` + no body. */
  function stubEmptyAccepted() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        captured.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body as string) : undefined,
        });
        return new Response(null, { status: 202 });
      }),
    );
  }

  it("succeeds on an empty 2xx instead of failing to parse JSON", async () => {
    stubEmptyAccepted();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    // The event IS accepted server-side; reporting a parse failure here is
    // what made scripts retry and duplicate turns (issue #436).
    await expect(
      cmd("sessions", "message").run(config, ["sess_k5k22ukwqusq2wfx", "follow-up smoke turn"]),
    ).resolves.toBeUndefined();

    expect(error).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("Message sent.");
  });

  it("POSTs the user.message payload the route expects", async () => {
    stubEmptyAccepted();

    await cmd("sessions", "message").run(config, ["sess_1", "hello"]);

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("POST");
    expect(captured[0].url).toBe("https://api.test/v1/sessions/sess_1/events");
    expect(captured[0].body).toEqual({
      events: [{ type: "user.message", content: [{ type: "text", text: "hello" }] }],
    });
  });

  it("still parses a JSON 2xx body", async () => {
    // Same shared helper, JSON-returning route: the body must still be
    // handed to the caller, so `sessions create` can read `id` back.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        captured.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body as string) : undefined,
        });
        return new Response(JSON.stringify({ id: "sess_9" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    await cmd("sessions", "create").run(config, [
      "--agent",
      "agent_1",
      "--env",
      "env_1",
    ]);

    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("Session created: sess_9");
  });
});

describe("oma schedules", () => {
  it("create POSTs the schedule body to the agent-scoped route", async () => {
    await cmd("schedules", "create").run(config, [
      "agent_1",
      "--cron",
      "0 9 * * 1",
      "--env",
      "env_1",
      "--input",
      "Post the digest",
      "--timezone",
      "America/New_York",
      "--max-sessions",
      "3",
    ]);

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("POST");
    expect(captured[0].url).toBe("https://api.test/v1/agents/agent_1/schedules");
    expect(captured[0].body).toMatchObject({
      cron_expression: "0 9 * * 1",
      environment_id: "env_1",
      input: "Post the digest",
      timezone: "America/New_York",
      max_sessions: 3,
    });
  });

  it("create with --disabled sets enabled:false", async () => {
    await cmd("schedules", "create").run(config, [
      "agent_1",
      "--cron",
      "* * * * *",
      "--env",
      "env_1",
      "--input",
      "hi",
      "--disabled",
    ]);
    expect(captured[0].body).toMatchObject({ enabled: false });
  });

  it("list GETs the agent-scoped route", async () => {
    await cmd("schedules", "list").run(config, ["agent_1"]);
    expect(captured[0].method).toBe("GET");
    expect(captured[0].url).toBe("https://api.test/v1/agents/agent_1/schedules");
  });

  it("run POSTs to the run subroute", async () => {
    await cmd("schedules", "run").run(config, ["agent_1", "sch_abc"]);
    expect(captured[0].method).toBe("POST");
    expect(captured[0].url).toBe("https://api.test/v1/agents/agent_1/schedules/sch_abc/run");
  });

  it("delete DELETEs the schedule", async () => {
    await cmd("schedules", "delete").run(config, ["agent_1", "sch_abc"]);
    expect(captured[0].method).toBe("DELETE");
    expect(captured[0].url).toBe("https://api.test/v1/agents/agent_1/schedules/sch_abc");
  });
});

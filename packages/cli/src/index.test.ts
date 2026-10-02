// Command-level tests for the `oma` verbs, plus argv-level dispatch (`--version`,
// group `--help`). Importing `index.ts` is safe because the module skips its
// `main()` auto-exec when VITEST is set (see the guard at the bottom of
// index.ts). Commands are looked up by their `match` tokens and driven with a
// stubbed global fetch; the argv-level paths call `main()` with a rewritten
// `process.argv`.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";

import { commands, main } from "./index";
import { PKG_VERSION } from "./bridge/lib/version.js";

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
  /** A stand-in for `Response` that can carry a body on any status. The fetch
   *  spec lists 204 as a null-body status, so `new Response("\n", { status:
   *  204 })` throws — the real constructor cannot express a stray byte on a
   *  204 at all. `apiFetch` only reads `ok` / `status` / `statusText` /
   *  `headers.get` / `text`, so a literal reproduces it faithfully. */
  function responseWithBody(status: number, body: string): Response {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: "",
      headers: { get: () => null },
      text: async () => body,
    } as unknown as Response;
  }

  /** Respond with exactly what the platform sends back for an accepted
   *  mutation: a 2xx with no body. `status`/`body` are overridable so the
   *  same stub can stand in for a 204, or for a body that is only whitespace. */
  function stubAccepted(status = 202, body: string | null = null) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        captured.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body as string) : undefined,
        });
        return body === null ? new Response(null, { status }) : responseWithBody(status, body);
      }),
    );
  }

  it("succeeds on an empty 2xx instead of failing to parse JSON", async () => {
    stubAccepted();
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
    stubAccepted();

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

  it("treats a whitespace-only 202 body as no content", async () => {
    // A gateway or trailing-newline server can answer the accepted mutation
    // with a stray blank instead of a truly zero-length body. `JSON.parse(" ")`
    // throws the exact same "Unexpected end of JSON input" as `JSON.parse("")`,
    // so an untrimmed check still reports a turn the server already queued.
    stubAccepted(202, "  \n\t  ");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(
      cmd("sessions", "message").run(config, ["sess_1", "hello"]),
    ).resolves.toBeUndefined();

    expect(error).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("Message sent.");
  });

  it("treats a whitespace-only 204 body as no content", async () => {
    // Same contract on the delete path. A conforming server cannot send this
    // (204 is a null-body status), but a proxy that appends a trailing byte
    // would, and the helper's contract is "empty after trimming", not
    // "falsy" — so pin it rather than leave it to a truthiness refactor.
    stubAccepted(204, "\n");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(cmd("agents", "delete").run(config, ["agent_1"])).resolves.toBeUndefined();

    expect(error).not.toHaveBeenCalled();
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain("Agent deleted: agent_1");
  });

  it("still throws a status-prefixed error on a non-2xx", async () => {
    // Widening "empty" to "empty after trimming" must not swallow a real
    // failure or soften its message: a 404 body still surfaces verbatim.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("agent not found", { status: 404, statusText: "Not Found" })),
    );

    await expect(cmd("agents", "delete").run(config, ["agent_x"])).rejects.toThrow(
      "404 Not Found: agent not found",
    );
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

/** Thrown by the `process.exit` stub below. Mocking exit as a no-op is not
 *  enough: the real `process.exit` never returns, so a mocked one lets
 *  `main()` keep running past a terminal branch (the `--version` path falls
 *  straight through into the config load and the unknown-command dump) and
 *  the assertions would pass while the code after `exit` still executed. */
class ProcessExit extends Error {}

describe("oma --version / group --help (issue #431)", () => {
  let home: string | undefined;

  beforeAll(() => {
    // `main()` bumps the local command counter before dispatching, and the
    // counter lives at `~/.oma/bridge/counters.json` (homedir-based, not XDG).
    // Redirect HOME so driving argv in a test can't scribble on the developer's
    // real counters. `os.homedir()` reads $HOME on POSIX, so this is enough.
    home = process.env.HOME;
    process.env.HOME = `${process.env.TMPDIR ?? "/tmp"}/oma-test-home-431`;
  });

  afterAll(() => {
    if (home === undefined) delete process.env.HOME;
    else process.env.HOME = home;
  });

  /** Run `main()` with `argv`, returning the code it exited with. A path that
   *  returns normally (group help) reports 0 — `main()` exiting early is the
   *  success signal there, not an explicit `process.exit(0)`. */
  async function runMain(argv: string[]): Promise<number> {
    const prevArgv = process.argv;
    process.argv = ["node", "oma", ...argv];
    let code: number | undefined;
    const exit = vi.spyOn(process, "exit").mockImplementation(((c?: number) => {
      code = c;
      throw new ProcessExit();
    }) as never);
    try {
      await main();
    } catch (e) {
      if (!(e instanceof ProcessExit)) throw e;
    } finally {
      exit.mockRestore();
      process.argv = prevArgv;
    }
    return code ?? 0;
  }

  it("--version prints PKG_VERSION and exits 0", async () => {
    expect(await runMain(["--version"])).toBe(0);
    expect(vi.mocked(console.log).mock.calls.map((c) => c[0])).toContain(PKG_VERSION);
  });

  it("-V and version aliases work", async () => {
    for (const alias of ["-V", "version"]) {
      vi.mocked(console.log).mockClear();
      expect(await runMain([alias])).toBe(0);
      expect(vi.mocked(console.log).mock.calls.map((c) => c[0])).toContain(PKG_VERSION);
    }
  });

  it("sessions --help shows group help, not Unknown command", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runMain(["sessions", "--help"])).toBe(0);

    const out = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(out).toMatch(/sessions/i);
    // The bug: no command matches `["sessions","--help"]`, so it fell through
    // to "Unknown command" plus the full global dump — for every group, which
    // made the surface undiscoverable from the CLI itself.
    expect(out).not.toMatch(/Unknown command/);
    expect(err).not.toHaveBeenCalled();
  });

  it("agents --help shows group help", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runMain(["agents", "--help"])).toBe(0);

    const out = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(out).toMatch(/agents/i);
    expect(out).not.toMatch(/Unknown command/);
    expect(err).not.toHaveBeenCalled();
  });

  it("leaf help documents one command", async () => {
    expect(await runMain(["sessions", "list", "--help"])).toBe(0);
    const out = vi.mocked(console.log).mock.calls.flat().join("\n");
    expect(out).toMatch(/GET {4}\/v1\/sessions/);
  });

  it("oma help <group> reaches the same help as <group> --help", async () => {
    expect(await runMain(["help", "agents"])).toBe(0);
    expect(vi.mocked(console.log).mock.calls.flat().join("\n")).toMatch(/agents/i);
  });

  it("an unknown group still reports Unknown command", async () => {
    // printHelp returning false must not swallow the real error path.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await runMain(["nope", "--help"])).toBe(1);
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/Unknown command/));
  });
});

describe("oma --json on list commands (issue #431)", () => {
  /** Respond with `body` and record nothing else. */
  function stubJson(body: unknown) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  }

  it("agents list emits the raw array when config.json is true", async () => {
    // A script parsing stdout got a padded human table and exit 0 — a silent
    // lie. `--json` has to change the shape, not just set a flag.
    const agents = [
      { id: "agent_1", name: "Researcher", model: "claude-sonnet-4-6", created_at: "2026-07-20T09:00:00Z" },
    ];
    stubJson({ data: agents });

    await cmd("agents", "list").run({ ...config, json: true }, []);

    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string)).toEqual(agents);
  });

  it("an empty list is [] rather than a human sentence", async () => {
    // The check has to run before the empty-result branch, or `--json` on an
    // empty list prints "No agents. Create one with: oma agents create" —
    // which no parser accepts, and reports success while doing it.
    stubJson({ data: [] });

    await cmd("agents", "list").run({ ...config, json: true }, []);

    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string)).toEqual([]);
  });

  it("still prints the human table without --json", async () => {
    stubJson({ data: [{ id: "agent_1", name: "Researcher", model: "claude-sonnet-4-6", created_at: "2026-07-20T09:00:00Z" }] });

    await cmd("agents", "list").run({ ...config, json: false }, []);

    const out = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(out).toContain("NAME");
    expect(out).toContain("Researcher");
  });

  it("sessions list honors --json too", async () => {
    const sessions = [{ id: "sess_1", title: "T", agent_id: "agent_1", status: "idle", created_at: "2026-07-20T09:00:00Z" }];
    stubJson({ data: sessions });

    await cmd("sessions", "list").run({ ...config, json: true }, []);

    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string)).toEqual(sessions);
  });
});

describe("oma envs get / delete (issue #484)", () => {
  /** Respond with `body`; the default stub's schedule-flavored envelope would
   *  make every assertion below vacuous. */
  function stubJson(body: unknown, status = 200) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        captured.push({
          url,
          method: init?.method ?? "GET",
          body: init?.body ? JSON.parse(init.body as string) : undefined,
        });
        return new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      }),
    );
  }

  const ENV = {
    type: "environment",
    id: "env_abc",
    name: "data-science",
    description: "Pandas + matplotlib",
    status: "ready",
    created_at: "2026-07-20T09:00:00Z",
    config: { type: "cloud", sandbox_provider: "boxrun", harness: "default" },
  };

  it("get GETs the environment by id", async () => {
    stubJson(ENV);

    await cmd("envs", "get").run(config, ["env_abc"]);

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("GET");
    expect(captured[0].url).toBe("https://api.test/v1/environments/env_abc");
  });

  it("get prints the sandbox provider bits when present", async () => {
    // `envs list` only shows name/id/status, so the detail view is the only
    // place an operator can see WHICH sandbox an env actually resolves to.
    stubJson(ENV);

    await cmd("envs", "get").run(config, ["env_abc"]);

    const out = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(out).toContain("data-science");
    expect(out).toContain("env_abc");
    expect(out).toContain("cloud");
    expect(out).toContain("boxrun");
  });

  it("get omits the optional rows a minimal environment does not set", async () => {
    // `toEnvironmentConfig` drops null description/updated_at rather than
    // sending them null, so a minimal env must not render empty label rows.
    stubJson({
      id: "env_min",
      name: "bare",
      created_at: "2026-07-20T09:00:00Z",
      config: { type: "cloud" },
    });

    await cmd("envs", "get").run(config, ["env_min"]);

    const out = vi.mocked(console.log).mock.calls.flat().join(" ");
    expect(out).toContain("bare");
    expect(out).not.toMatch(/Sandbox:/);
    expect(out).not.toMatch(/Desc:/);
  });

  it("get emits the raw object under --json", async () => {
    stubJson(ENV);

    await cmd("envs", "get").run({ ...config, json: true }, ["env_abc"]);

    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string)).toEqual(ENV);
  });

  it("delete DELETEs the environment by id", async () => {
    stubJson({ type: "environment_deleted", id: "env_abc" });

    await cmd("envs", "delete").run(config, ["env_abc"]);

    expect(captured).toHaveLength(1);
    expect(captured[0].method).toBe("DELETE");
    expect(captured[0].url).toBe("https://api.test/v1/environments/env_abc");
    expect(vi.mocked(console.log).mock.calls.flat().join(" ")).toContain(
      "Environment deleted: env_abc",
    );
  });

  it("delete still emits a parseable envelope when the body is empty", async () => {
    // Same contract as the 204 handling in the shared `apiFetch` helper: a
    // bodiless 2xx must not print a bare `undefined` under `--json`.
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        captured.push({ url, method: init?.method ?? "GET", body: undefined });
        return new Response(null, { status: 204 });
      }),
    );

    await cmd("envs", "delete").run({ ...config, json: true }, ["env_abc"]);

    expect(JSON.parse(vi.mocked(console.log).mock.calls[0][0] as string)).toEqual({
      type: "environment_deleted",
      id: "env_abc",
    });
  });

  it("delete surfaces the 409 raised by active sessions", async () => {
    // The route refuses a hard delete while the environment still has active
    // sessions; the CLI must relay that verbatim rather than swallow it into
    // a success line.
    stubJson(
      { error: "Cannot delete environment with active sessions. Archive or delete sessions first." },
      409,
    );

    await expect(cmd("envs", "delete").run(config, ["env_busy"])).rejects.toThrow(
      /Cannot delete environment with active sessions/,
    );
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();
  });

  it("delete surfaces a 404 for an unknown id", async () => {
    stubJson({ error: "Environment not found" }, 404);

    await expect(cmd("envs", "delete").run(config, ["env_nope"])).rejects.toThrow(
      "404",
    );
  });
});

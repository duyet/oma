// Tests for the run_dynamic_worker ("Code Mode") tool — the Cloudflare
// Dynamic Workers ephemeral-eval primitive. Verifies availability gating
// (opt-in AND binding-present) and the load()→getEntrypoint().fetch() shape
// against a faked Worker Loader binding (Workers-pool tests have no real one).

import { describe, it, expect } from "vitest";
import { buildTools } from "./tools";
import type { AgentConfig } from "@duyet/oma-shared";
import type { SandboxExecutor } from "@getoma/sandbox-sdk";
import type { WorkerLoader, DynamicWorkerCode } from "@duyet/oma-shared";

// Minimal SandboxExecutor — the tool never touches it, so exec/read/write throw.
const noopSandbox: SandboxExecutor = {
  exec: async () => { throw new Error("exec should not be called"); },
  readFile: async () => { throw new Error("readFile should not be called"); },
  writeFile: async () => { throw new Error("writeFile should not be called"); },
};

/** Fake Worker Loader that records the config it was given and returns a
 *  response computed by `handler` (defaults to echoing the request body). */
function fakeLoader(handler?: (body: unknown) => Response | Promise<Response>): {
  loader: WorkerLoader;
  configs: DynamicWorkerCode[];
} {
  const configs: DynamicWorkerCode[] = [];
  const loader: WorkerLoader = {
    get(_id, callback) {
      return {
        getEntrypoint() {
          return {
            async fetch(request: Request) {
              const cfg = await callback();
              configs.push(cfg);
              const body = await request.json().catch(() => null);
              if (handler) return handler(body);
              return Response.json({ result: (body as { input?: unknown })?.input ?? null });
            },
          };
        },
      };
    },
  };
  return { loader, configs };
}

function agentOptingIn(): AgentConfig {
  return {
    tools: [
      {
        type: "agent_toolset_20260401",
        configs: [{ name: "run_dynamic_worker", enabled: true }],
      },
    ],
  } as unknown as AgentConfig;
}

describe("run_dynamic_worker availability gating", () => {
  it("is omitted when the agent opts in but the Worker Loader binding is absent", async () => {
    const tools = await buildTools(agentOptingIn(), noopSandbox, {});
    expect(tools.run_dynamic_worker).toBeUndefined();
  });

  it("is omitted when the binding is present but the agent did not opt in", async () => {
    const { loader } = fakeLoader();
    const tools = await buildTools(
      { tools: [{ type: "agent_toolset_20260401" }] } as unknown as AgentConfig,
      noopSandbox,
      { workerLoader: loader },
    );
    expect(tools.run_dynamic_worker).toBeUndefined();
  });

  it("is registered when the agent opts in AND the binding is present", async () => {
    const { loader } = fakeLoader();
    const tools = await buildTools(agentOptingIn(), noopSandbox, { workerLoader: loader });
    expect(tools.run_dynamic_worker).toBeDefined();
  });
});

describe("run_dynamic_worker execution", () => {
  async function run(args: Record<string, unknown>, handler?: (b: unknown) => Response | Promise<Response>) {
    const { loader, configs } = fakeLoader(handler);
    const tools = await buildTools(agentOptingIn(), noopSandbox, { workerLoader: loader });
    const out = await tools.run_dynamic_worker.execute(args, { toolCallId: "t1", messages: [] });
    return { out: JSON.parse(out as string), configs };
  }

  it("passes `input` through to the worker and returns { ok, result }", async () => {
    const { out } = await run({ code: "return input.a + input.b;", input: { a: 2, b: 3 } });
    expect(out.ok).toBe(true);
    // Bare snippet is wrapped; our fake echoes request.input, so result is the input object.
    expect(out.result).toEqual({ result: { a: 2, b: 3 } });
  });

  it("blocks egress by default (globalOutbound: null) and passes a cpuMs limit", async () => {
    const { configs } = await run({ code: "return 1;" });
    expect(configs[0].globalOutbound).toBeNull();
    expect(configs[0].limits?.cpuMs).toBeGreaterThan(0);
    expect(configs[0].mainModule).toBe("main.js");
  });

  it("allows egress (globalOutbound omitted) when allow_network is true", async () => {
    const { configs } = await run({ code: "return 1;", allow_network: true });
    expect(configs[0].globalOutbound).toBeUndefined();
  });

  it("sets the python_workers compat flag for language: python", async () => {
    const { configs } = await run({ code: "result = 1", language: "python" });
    expect(configs[0].compatibilityFlags).toContain("python_workers");
    expect(configs[0].mainModule).toBe("main.py");
  });

  it("passes a full ES module through untouched (no bare-snippet wrapping)", async () => {
    const src = "export default { async fetch() { return Response.json({ result: 42 }); } };";
    const { configs } = await run({ code: src }, () => Response.json({ result: 42 }));
    expect(configs[0].modules["main.js"]).toBe(src);
  });

  it("caps timeout_ms at the maximum", async () => {
    const { configs } = await run({ code: "return 1;", timeout_ms: 999_999 });
    expect(configs[0].limits?.cpuMs).toBe(60_000);
  });

  it("returns ok:false when the worker responds non-2xx", async () => {
    const { out } = await run(
      { code: "return 1;" },
      () => new Response("boom", { status: 500 }),
    );
    expect(out.ok).toBe(false);
    expect(out.error).toContain("500");
  });
});

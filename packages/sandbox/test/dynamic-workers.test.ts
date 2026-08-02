// Unit tests for DynamicWorkerSandbox — the Cloudflare Dynamic Workers
// JS-eval sandbox adapter. Verifies exec()→load()→getEntrypoint().fetch()
// shape against a faked Worker Loader binding, that a bare snippet is wrapped
// into a fetch handler, that egress is blocked by default (globalOutbound:
// null), and that all filesystem/process ops fail with a clear error.

import { describe, it, expect } from "vitest";
import type { WorkerLoader, DynamicWorkerCode } from "@duyet/oma-shared";
import { DynamicWorkerSandbox } from "../src/adapters/dynamic-workers";

/** Fake Worker Loader — records each config it was given and runs the loaded
 *  module's source in a trivial interpreter (we don't have a real V8 isolate
 *  in the Node test pool, so `run` decides the response). */
function fakeLoader(
  run: (cfg: DynamicWorkerCode) => Response | Promise<Response>,
): { loader: WorkerLoader; configs: DynamicWorkerCode[] } {
  const configs: DynamicWorkerCode[] = [];
  const loader: WorkerLoader = {
    get(_id, callback) {
      return {
        getEntrypoint() {
          return {
            async fetch(_request: Request) {
              const cfg = await callback();
              configs.push(cfg);
              return run(cfg);
            },
          };
        },
      };
    },
  };
  return { loader, configs };
}

describe("DynamicWorkerSandbox.exec", () => {
  it("wraps a bare snippet into a fetch handler and returns the result", async () => {
    const { loader, configs } = fakeLoader(() => Response.json({ result: 4 }));
    const sandbox = new DynamicWorkerSandbox({ loader, sessionId: "sess_abc" });
    const out = await sandbox.exec("return 2 + 2;");
    expect(out).toContain("exit=0");
    expect(out).toContain('"result":4');
    // The bare snippet was wrapped into an ES module with a fetch handler.
    expect(configs).toHaveLength(1);
    expect(configs[0].mainModule).toBe("main.js");
    expect(configs[0].modules["main.js"]).toContain("export default");
    expect(configs[0].modules["main.js"]).toContain("return 2 + 2;");
  });

  it("blocks all egress by default (globalOutbound: null)", async () => {
    const { loader, configs } = fakeLoader(() => Response.json({ result: 1 }));
    const sandbox = new DynamicWorkerSandbox({ loader, sessionId: "sess_abc" });
    await sandbox.exec("return 1;");
    expect(configs[0].globalOutbound).toBeNull();
  });

  it("allows egress (globalOutbound omitted) when allowNetwork is set", async () => {
    const { loader, configs } = fakeLoader(() => Response.json({ result: 1 }));
    const sandbox = new DynamicWorkerSandbox({ loader, sessionId: "sess_abc", allowNetwork: true });
    await sandbox.exec("return 1;");
    expect(configs[0].globalOutbound).toBeUndefined();
  });

  it("passes a full ES module through untouched", async () => {
    const { loader, configs } = fakeLoader(() => Response.json({ result: "ok" }));
    const sandbox = new DynamicWorkerSandbox({ loader, sessionId: "sess_abc" });
    const mod = "export default { async fetch() { return Response.json({ result: 'ok' }); } };";
    await sandbox.exec(mod);
    expect(configs[0].modules["main.js"]).toBe(mod);
  });

  it("caps the per-run CPU limit at the hard max", async () => {
    const { loader, configs } = fakeLoader(() => Response.json({ result: 1 }));
    const sandbox = new DynamicWorkerSandbox({ loader, sessionId: "sess_abc" });
    await sandbox.exec("return 1;", 999_999);
    expect(configs[0].limits?.cpuMs).toBe(60_000);
  });

  it("surfaces a non-OK HTTP response as an exit=1 result", async () => {
    const { loader } = fakeLoader(() => new Response("boom", { status: 500 }));
    const sandbox = new DynamicWorkerSandbox({ loader, sessionId: "sess_abc" });
    const out = await sandbox.exec("throw new Error('boom');");
    expect(out).toContain("exit=1");
    expect(out).toContain("HTTP 500");
  });

  it("returns an exit=1 result when the loader throws", async () => {
    const { loader } = fakeLoader(() => {
      throw new Error("isolate exceeded cpuMs");
    });
    const sandbox = new DynamicWorkerSandbox({ loader, sessionId: "sess_abc" });
    const out = await sandbox.exec("while(true){}");
    expect(out).toContain("exit=1");
    expect(out).toContain("isolate exceeded cpuMs");
  });
});

describe("DynamicWorkerSandbox unsupported operations", () => {
  const { loader } = fakeLoader(() => Response.json({ result: null }));
  const sandbox = new DynamicWorkerSandbox({ loader, sessionId: "sess_abc" });

  it("readFile throws a clear not-supported error", async () => {
    await expect(sandbox.readFile("/workspace/x")).rejects.toThrow(/not supported by the "dynamic-workers"/);
  });

  it("writeFile throws a clear not-supported error", async () => {
    await expect(sandbox.writeFile("/workspace/x", "y")).rejects.toThrow(/not supported/);
  });

  it("startProcess throws a clear not-supported error", async () => {
    await expect(sandbox.startProcess("sleep 1")).rejects.toThrow(/not supported/);
  });

  it("gitCheckout throws a clear not-supported error", async () => {
    await expect(sandbox.gitCheckout("https://example.com/r.git", {})).rejects.toThrow(/not supported/);
  });
});

describe("DynamicWorkerSandbox.ping", () => {
  it("reports ok when a trivial eval succeeds", async () => {
    const { loader } = fakeLoader(() => Response.json({ result: 2 }));
    const sandbox = new DynamicWorkerSandbox({ loader, sessionId: "sess_abc" });
    const res = await sandbox.ping();
    expect(res.status).toBe("ok");
  });
});

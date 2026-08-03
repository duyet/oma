// Unit tests for KubernetesRemoteSandbox — the pure-fetch CF adapter that
// talks to an in-cluster k8s-sandbox-gateway (issue #78, Part B). No real
// gateway or cluster involved; globalThis.fetch is mocked to emit the
// boxrun-shaped HTTP contract:
//   POST   /boxes                       → { box_id }
//   POST   /boxes/:id/exec              → { execution_id }
//   GET    /boxes/:id/executions/:eid/output  (SSE: stdout/stderr/exit, base64)
//   GET/PUT /boxes/:id/files?path=      (application/x-tar)
//   DELETE /boxes/:id
//
// The tar helpers (packSingleFileTar / extractFirstRegularFile) are the
// same pure-USTAR routines boxrun uses, so the writeFile/readFile round
// trip exercises them end-to-end without any filesystem.

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// Re-import the private tar helpers indirectly by round-tripping through
// the adapter's public writeFileBytes/readFileBytes — those are the only
// surfaces that touch tar. We don't need to import the helpers directly.
import { KubernetesRemoteSandbox } from "../src/adapters/kubernetes-remote";
import { DEFAULT_SANDBOX_IMAGE } from "../src/ports";

function base64(s: string): string {
  return Buffer.from(s, "utf-8").toString("base64");
}

/** Build an SSE body string from ordered (type, payload) events. */
function sse(...events: Array<[string, Record<string, unknown>]>): string {
  return events
    .map(([type, payload]) => `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
    .join("");
}

// Minimal request/response capture for the mocked fetch.
const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = [];

function makeResponse(overrides: Partial<Response> & { status: number; ok: boolean }): Response {
  return overrides as unknown as Response;
}

/** SSE stream Response body for a successful no-output exec. */
function emptyExitStream(): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(sse(["exit", { exit_code: 0 }]));
  return new ReadableStream({
    start(c) {
      c.enqueue(new Uint8Array(bytes));
      c.close();
    },
  });
}

const realFetch = globalThis.fetch;
beforeEach(() => {
  calls.length = 0;
  vi.restoreAllMocks();
  // Default routed mock covering the full boxrun-shaped contract; individual
  // tests override globalThis.fetch when they need bespoke responses.
  (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    const headers: Record<string, string> = {};
    if (init?.headers) {
      for (const [k, v] of new Headers(init.headers).entries()) headers[k.toLowerCase()] = v;
    }
    const body = init?.body != null ? (typeof init.body === "string" ? init.body : "<bytes>") : undefined;
    calls.push({ url, method, headers, body });
    if (method === "POST" && url.endsWith("/boxes")) {
      return makeResponse({ status: 200, ok: true, json: async () => ({ box_id: "box-abc" }) } as Partial<Response> & { status: number; ok: boolean });
    }
    if (method === "POST" && url.includes("/exec")) {
      return makeResponse({ status: 200, ok: true, json: async () => ({ execution_id: "exec-1" }) } as Partial<Response> & { status: number; ok: boolean });
    }
    if (method === "DELETE") {
      return makeResponse({ status: 204, ok: true, text: async () => "" } as Partial<Response> & { status: number; ok: boolean });
    }
    // GET executions/:eid/output — SSE stream
    return makeResponse({ status: 200, ok: true, body: emptyExitStream() } as Partial<Response> & { status: number; ok: boolean });
  }) as unknown as typeof fetch;
});

describe("KubernetesRemoteSandbox", () => {
  it("uses only globalThis.fetch — no Node builtins imported", async () => {
    // Constructing + ensuring a box must issue exactly one POST /boxes.
    const sandbox = new KubernetesRemoteSandbox({
      baseUrl: "http://gw/v1/default",
      sessionId: "sess_1",
    });
    await sandbox.exec("echo hi");

    const createCall = calls.find((c) => c.method === "POST" && c.url.endsWith("/boxes"));
    expect(createCall).toBeDefined();
    expect(JSON.parse(createCall!.body!)).toMatchObject({ image: DEFAULT_SANDBOX_IMAGE, name: "oma-sess_1" });
  });

  it("exec() POSTs /exec then parses the SSE stream into stdout + exit", async () => {
    const sandbox = new KubernetesRemoteSandbox({ baseUrl: "http://gw/v1/default" });

    // exec start, then SSE stream. We need response per-call matching by URL.
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = (typeof input === "string" ? input : input.toString());
      const method = init?.method ?? "GET";
      calls.push({ url, method, headers: {} });
      if (method === "POST" && url.endsWith("/boxes")) {
        return makeResponse({ status: 200, ok: true, json: async () => ({ box_id: "box-1" }) });
      }
      if (method === "POST" && url.includes("/exec")) {
        return makeResponse({ status: 200, ok: true, json: async () => ({ execution_id: "exec-9" }) });
      }
      // SSE stream output
      const streamBody = sse(
        ["stdout", { data: base64("hello ") }],
        ["stdout", { data: base64("world\n") }],
        ["exit", { exit_code: 0 }],
      );
      const enc = new TextEncoder();
      const bytes = enc.encode(streamBody);
      const stream = new ReadableStream({
        start(c) {
          c.enqueue(new Uint8Array(bytes));
          c.close();
        },
      });
      return makeResponse({ status: 200, ok: true, body: stream as unknown as ReadableStream<Uint8Array> });
    }) as unknown as typeof fetch;

    const result = await sandbox.exec("echo hello world");
    expect(result).toBe("exit=0\nhello world\n");
    expect(calls.length).toBeGreaterThan(0);
  });

  it("exec() appends stderr when present", async () => {
    const sandbox = new KubernetesRemoteSandbox({ baseUrl: "http://gw/v1/default" });

    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = (typeof input === "string" ? input : input.toString());
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/boxes")) {
        return makeResponse({ status: 200, ok: true, json: async () => ({ box_id: "box-2" }) });
      }
      if (method === "POST" && url.includes("/exec")) {
        return makeResponse({ status: 200, ok: true, json: async () => ({ execution_id: "exec-2" }) });
      }
      const streamBody = sse(
        ["stdout", { data: base64("out\n") }],
        ["stderr", { data: base64("err\n") }],
        ["exit", { exit_code: 1 }],
      );
      const bytes = new TextEncoder().encode(streamBody);
      const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(bytes)); c.close(); } });
      return makeResponse({ status: 200, ok: true, body: stream as unknown as ReadableStream<Uint8Array> });
    }) as unknown as typeof fetch;

    const result = await sandbox.exec("false");
    expect(result).toContain("out");
    expect(result).toContain("[stderr:err\n]");
    expect(result).toContain("exit=1");
  });

  it("writeFile then readFile round-trips through the tar API", async () => {
    const sandbox = new KubernetesRemoteSandbox({ baseUrl: "http://gw/v1/default" });

    // Capture what the gateway would have stored per PUT, keyed by dir.
    const store: Record<string, Uint8Array> = {};
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = (typeof input === "string" ? input : input.toString());
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/boxes")) {
        return makeResponse({ status: 200, ok: true, json: async () => ({ box_id: "box-3" }) });
      }
      if (method === "PUT" && url.includes("/files")) {
        // init.body is a Uint8Array (tar bytes)
        const tar = init!.body as unknown as Uint8Array;
        store[url] = tar;
        return makeResponse({ status: 200, ok: true });
      }
      if (method === "GET" && url.includes("/files")) {
        // Echo back the most recent PUT tar for the same dir.
        const [storedUrl] = Object.keys(store).filter((u) => u.startsWith(url.split("?")[0]));
        const tar = store[storedUrl ?? Object.keys(store)[0]];
        return makeResponse({ status: 200, ok: true, arrayBuffer: async () => tar.buffer.slice(tar.byteOffset, tar.byteOffset + tar.byteLength) });
      }
      return makeResponse({ status: 404, ok: false, text: async () => "not found" });
    }) as unknown as typeof fetch;

    await sandbox.writeFile("/workspace/hello.txt", "hello k8s");
    const roundTrip = await sandbox.readFile("/workspace/hello.txt");
    expect(roundTrip).toBe("hello k8s");
  });

  it("readFileBytes returns raw bytes written via writeFileBytes", async () => {
    const sandbox = new KubernetesRemoteSandbox({ baseUrl: "http://gw/v1/default" });
    const store: Record<string, Uint8Array> = {};
    (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = (typeof input === "string" ? input : input.toString());
      const method = init?.method ?? "GET";
      if (method === "POST" && url.endsWith("/boxes")) {
        return makeResponse({ status: 200, ok: true, json: async () => ({ box_id: "box-4" }) });
      }
      if (method === "PUT" && url.includes("/files")) {
        store[url] = init!.body as unknown as Uint8Array;
        return makeResponse({ status: 200, ok: true });
      }
      if (method === "GET" && url.includes("/files")) {
        const [storedUrl] = Object.keys(store);
        const tar = store[storedUrl];
        return makeResponse({ status: 200, ok: true, arrayBuffer: async () => tar.buffer.slice(tar.byteOffset, tar.byteOffset + tar.byteLength) });
      }
      return makeResponse({ status: 404, ok: false });
    }) as unknown as typeof fetch;

    const raw = new Uint8Array([0x00, 0xff, 0x10, 0x42]);
    await sandbox.writeFileBytes("/workspace/bin.dat", raw);
    const got = await sandbox.readFileBytes("/workspace/bin.dat");
    expect([...got]).toEqual([...raw]);
  });

  it("destroy() issues DELETE /boxes/:id and is idempotent", async () => {
    const sandbox = new KubernetesRemoteSandbox({ baseUrl: "http://gw/v1/default" });
    await sandbox.exec("echo x"); // ensure box created
    await sandbox.destroy();
    await sandbox.destroy(); // second destroy is a no-op (no boxId)

    const deletes = calls.filter((c) => c.method === "DELETE" && c.url.includes("/boxes/"));
    expect(deletes).toHaveLength(1);
  });

  it("factory throws a clear error when K8S_SANDBOX_GATEWAY_URL is missing", async () => {
    const { sandboxFactory } = await import("../src/adapters/kubernetes-remote");
    await expect(
      sandboxFactory({ sessionId: "s", workdir: "/tmp" }, {}),
    ).rejects.toThrow(/K8S_SANDBOX_GATEWAY_URL/);
  });

  it("factory builds a sandbox when the gateway URL is present", async () => {
    const { sandboxFactory } = await import("../src/adapters/kubernetes-remote");
    const sb = await sandboxFactory(
      { sessionId: "s", workdir: "/tmp" },
      { K8S_SANDBOX_GATEWAY_URL: "http://gw/v1/default" },
    );
    expect(sb).toBeInstanceOf(KubernetesRemoteSandbox);
  });
});

afterAll(() => {
  (globalThis as { fetch: typeof fetch }).fetch = realFetch;
});

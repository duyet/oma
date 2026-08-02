import { describe, expect, it } from "vitest";
import { FakeHttpClient } from "@duyet/oma-integrations-core/test-fakes";
import type { HttpClient, HttpResponse } from "@duyet/oma-integrations-core";
import { agentHooksSchema, type AgentHook } from "@duyet/oma-api-types";
import { signWebhookBody as signWebhookBodyForTest } from "../runtime/notify-dispatch";
import {
  wrapToolsWithHooks,
  runPreToolHooks,
  runPostToolHooks,
  type HookDispatchDeps,
} from "./hooks";

function jsonResponse(obj: unknown): HttpResponse {
  return { status: 200, headers: {}, body: JSON.stringify(obj) };
}

function deps(http: HttpClient, overrides: Partial<HookDispatchDeps> = {}): HookDispatchDeps {
  return {
    httpClient: http,
    resolveSecret: async (ref?: string) => (ref ? "topsecret" : null),
    sessionId: "sess_1",
    tenantId: "tenant_a",
    ...overrides,
  };
}

const webhookHook = (over: Partial<AgentHook> = {}): AgentHook => ({
  event: "pre_tool",
  target: { type: "webhook", url: "https://hooks.example.com/hook", secret_ref: "cred_x" },
  ...over,
});

describe("agentHooksSchema", () => {
  it("accepts a valid webhook pre_tool hook", () => {
    const r = agentHooksSchema.safeParse([
      { event: "pre_tool", matcher: "bash", target: { type: "webhook", url: "https://x.example.com/h" }, on_error: "closed" },
    ]);
    expect(r.success).toBe(true);
  });

  it("rejects a non-URL webhook target", () => {
    const r = agentHooksSchema.safeParse([
      { event: "pre_tool", target: { type: "webhook", url: "not-a-url" } },
    ]);
    expect(r.success).toBe(false);
  });

  it("rejects an unknown event", () => {
    const r = agentHooksSchema.safeParse([
      { event: "on_boom", target: { type: "webhook", url: "https://x.example.com/h" } },
    ]);
    expect(r.success).toBe(false);
  });

  it("rejects an unknown on_error policy", () => {
    const r = agentHooksSchema.safeParse([
      { event: "pre_tool", target: { type: "webhook", url: "https://x.example.com/h" }, on_error: "sometimes" },
    ]);
    expect(r.success).toBe(false);
  });
});

describe("pre_tool hook", () => {
  it("signs the outbound envelope with HMAC-SHA256 over the raw body", async () => {
    const http = new FakeHttpClient().respondWith(jsonResponse({ decision: "allow" }));
    await runPreToolHooks([webhookHook()], "bash", { command: "ls" }, deps(http));
    const call = http.calls[0];
    const expected = await signWebhookBodyForTest(call.body ?? "", "topsecret");
    expect(call.headers?.["x-oma-signature"]).toBe(`sha256=${expected}`);
    expect(call.headers?.["x-oma-hook"]).toBe("pre_tool");
    expect(JSON.parse(call.body ?? "{}")).toMatchObject({ event: "pre_tool", tool_name: "bash" });
  });

  it("deny blocks tool execution (execute never runs)", async () => {
    const http = new FakeHttpClient().respondWith(jsonResponse({ decision: "deny", reason: "no rm allowed" }));
    let ran = false;
    const tools = { bash: { description: "d", execute: async (_a?: unknown, _o?: unknown) => { ran = true; return "ok"; } } };
    const wrapped = wrapToolsWithHooks(tools, [webhookHook()], deps(http));
    const out = await wrapped.bash.execute!({ command: "rm -rf /" }, {});
    expect(ran).toBe(false);
    expect(out).toContain("blocked by hook");
    expect(out).toContain("no rm allowed");
  });

  it("modify rewrites the tool input passed to execute", async () => {
    const http = new FakeHttpClient().respondWith(jsonResponse({ decision: "modify", tool_input: { command: "ls -la" } }));
    let seen: unknown;
    const tools = { bash: { execute: async (a?: unknown, _o?: unknown) => { seen = a; return "done"; } } };
    const wrapped = wrapToolsWithHooks(tools, [webhookHook()], deps(http));
    await wrapped.bash.execute!({ command: "ls" }, {});
    expect(seen).toEqual({ command: "ls -la" });
  });

  it("respects the matcher — a non-matching tool is not hooked", async () => {
    const http = new FakeHttpClient();
    const tools = { read: { execute: async (_a?: unknown, _o?: unknown) => "file" } };
    const wrapped = wrapToolsWithHooks(tools, [webhookHook({ matcher: "bash" })], deps(http));
    const out = await wrapped.read.execute!({}, {});
    expect(out).toBe("file");
    expect(http.calls).toHaveLength(0);
  });
});

describe("post_tool hook", () => {
  it("modify transforms the observed result", async () => {
    const http = new FakeHttpClient().respondWith(jsonResponse({ decision: "modify", tool_result: "[redacted]" }));
    const out = await runPostToolHooks(
      [webhookHook({ event: "post_tool" })],
      "read",
      {},
      "secret token abc",
      deps(http),
    );
    expect(out).toBe("[redacted]");
  });
});

describe("hook timeout / fail policy", () => {
  const slowHttp: HttpClient = {
    fetch: () => new Promise((resolve) => setTimeout(() => resolve(jsonResponse({ decision: "deny" })), 1000)),
  };

  it("fail-open (default): a timed-out pre hook lets the tool proceed", async () => {
    const r = await runPreToolHooks(
      [webhookHook({ timeout_ms: 10 })],
      "bash",
      { command: "ls" },
      deps(slowHttp),
    );
    expect(r.denied).toBe(false);
  });

  it("fail-closed: a timed-out pre hook denies the tool", async () => {
    const r = await runPreToolHooks(
      [webhookHook({ timeout_ms: 10, on_error: "closed" })],
      "bash",
      { command: "ls" },
      deps(slowHttp),
    );
    expect(r.denied).toBe(true);
    if (r.denied) expect(r.reason).toContain("fail-closed");
  });
});

describe("rate limiting", () => {
  it("skips the hook when the per-tenant bucket is exhausted (fail-open)", async () => {
    const http = new FakeHttpClient();
    const r = await runPreToolHooks(
      [webhookHook()],
      "bash",
      { command: "ls" },
      deps(http, { rateLimitGate: { consume: async () => ({ ok: false }) } }),
    );
    expect(r.denied).toBe(false);
    expect(http.calls).toHaveLength(0); // never dispatched
  });
});

describe("prompt-cache byte-safety", () => {
  it("wrapping preserves tool description + inputSchema (only execute changes)", () => {
    const schema = { type: "object" };
    const tools = { bash: { description: "run a command", inputSchema: schema, execute: async () => "x" } };
    const wrapped = wrapToolsWithHooks(tools, [webhookHook()], deps(new FakeHttpClient()));
    expect(wrapped.bash.description).toBe(tools.bash.description);
    expect(wrapped.bash.inputSchema).toBe(schema);
    expect(wrapped.bash.execute).not.toBe(tools.bash.execute);
  });

  it("no pre/post hooks configured → tools object returned unchanged", () => {
    const tools = { bash: { execute: async () => "x" } };
    const same = wrapToolsWithHooks(tools, [{ event: "session_start", target: { type: "webhook", url: "https://x.example.com/h" } }], deps(new FakeHttpClient()));
    expect(same).toBe(tools);
  });
});

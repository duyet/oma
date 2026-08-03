// Verifies the K8sBridgeSandbox forwards an OpenShell `policy` in its
// create-box POST body. This is the CF → bridge leg of the OMA-env →
// OpenShell-policy plumbing: apps/agent maps the env config to a policy and
// hands it to K8sBridgeSandbox; here we assert it lands on the wire.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { K8sBridgeSandbox } from "../src/adapters/k8s-bridge";
import type { OpenShellSandboxPolicy } from "../src/adapters/openshell-policy";

const calls: Array<{ url: string; method: string; body?: string }> = [];

beforeEach(() => {
  calls.length = 0;
  (globalThis as { fetch: typeof fetch }).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: init?.body as string | undefined });
    if (method === "POST" && url.endsWith("/boxes")) {
      return new Response(JSON.stringify({ id: "box-1" }), { status: 200 });
    }
    if (url.includes("/exec")) {
      return new Response("exit=0\n", { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
});

const policy: OpenShellSandboxPolicy = {
  version: 1,
  filesystem: { include_workdir: true },
  network_policies: { oma: { name: "oma", endpoints: [{ host: "api.github.com" }] } },
};

describe("K8sBridgeSandbox policy forwarding", () => {
  it("includes the policy in the create-box POST body", async () => {
    const sb = new K8sBridgeSandbox({
      baseUrl: "http://bridge/api/v1",
      bearerToken: "t",
      sessionId: "sess-1",
      policy,
    });
    await sb.exec("echo hi");
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/boxes"));
    expect(create).toBeDefined();
    expect(JSON.parse(create!.body!).policy).toEqual(policy);
  });

  it("omits policy when none is set (k8s backend path unchanged)", async () => {
    const sb = new K8sBridgeSandbox({ baseUrl: "http://bridge/api/v1", bearerToken: "t", sessionId: "sess-2" });
    await sb.exec("echo hi");
    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/boxes"));
    expect(JSON.parse(create!.body!).policy).toBeUndefined();
  });
});

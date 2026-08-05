// Unit tests for the non-interactive pairing client.
//
// pairNonInteractive is a pure fetch + mapping function — the only I/O is the
// exchange HTTP call, which we stub by swapping globalThis.fetch for the
// duration of each test. The assertions pin (a) the exact body shape sent to
// /agents/runtime/exchange (the backend branches on code-type server-side,
// so an inadvertent field rename would silently break k8s pairing) and (b)
// the v2 Credentials mapping that setup.ts also implements.

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { pairNonInteractive } from "./pair.js";

interface CapturedRequest {
  url: string;
  init: RequestInit;
}

function installFetchStub(
  respond: (req: CapturedRequest) => { status: number; body: string },
): { calls: CapturedRequest[]; restore: () => void } {
  const calls: CapturedRequest[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : (input as { toString(): string }).toString();
    const req = { url, init: init ?? {} };
    calls.push(req);
    const { status, body } = respond(req);
    return Promise.resolve(
      new Response(body, { status, headers: { "content-type": "application/json" } }),
    );
  }) as typeof fetch;
  return {
    calls,
    restore: () => { globalThis.fetch = realFetch; },
  };
}

const EXCHANGE_OK_BODY = JSON.stringify({
  runtime_id: "rt_test_1234567890",
  token: "sk_machine_testtoken",
  tenants: [
    { id: "tnt_a", name: "Workspace A", role: "owner", agent_api_key: "oma_aaa" },
    { id: "tnt_b", name: "Workspace B", role: "member", agent_api_key: "oma_bbb" },
  ],
});

describe("pairNonInteractive", () => {
  let restore: () => void;
  let stub: ReturnType<typeof installFetchStub>;

  afterEach(() => {
    if (restore) restore();
  });

  it("posts the exact exchange body shape (code, state, machine_id, hostname, os, version, multi_tenant)", async () => {
    stub = installFetchStub(() => ({ status: 200, body: EXCHANGE_OK_BODY }));
    restore = stub.restore;

    await pairNonInteractive({
      serverUrl: "https://oma.example.com/",
      pairingCode: "pair_abc",
      pairingState: "state_def",
      hostname: "pod-a",
      os: "linux/arm64",
      machineId: "machine-uuid-0001",
      version: "1.2.3",
    });

    expect(stub.calls).toHaveLength(1);
    const req = stub.calls[0]!;
    // Trailing slash on serverUrl is normalized away.
    expect(req.url).toBe("https://oma.example.com/agents/runtime/exchange");
    expect(req.init.method).toBe("POST");
    expect(JSON.parse(String(req.init.body))).toEqual({
      code: "pair_abc",
      state: "state_def",
      machine_id: "machine-uuid-0001",
      hostname: "pod-a",
      os: "linux/arm64",
      version: "1.2.3",
      multi_tenant: true,
    });
  });

  it("maps the v2 exchange response into CredentialsV2 with a fresh createdAt", async () => {
    stub = installFetchStub(() => ({ status: 200, body: EXCHANGE_OK_BODY }));
    restore = stub.restore;

    const before = Math.floor(Date.now() / 1000);
    const creds = await pairNonInteractive({
      serverUrl: "https://oma.example.com",
      pairingCode: "c",
      pairingState: "s",
      hostname: "h",
      os: "linux/x64",
      machineId: "mid",
      version: "v",
    });
    const after = Math.floor(Date.now() / 1000);

    expect(creds.v).toBe(2);
    expect(creds.serverUrl).toBe("https://oma.example.com");
    expect(creds.runtimeId).toBe("rt_test_1234567890");
    expect(creds.token).toBe("sk_machine_testtoken");
    expect(creds.machineId).toBe("mid");
    expect(creds.createdAt).toBeGreaterThanOrEqual(before);
    expect(creds.createdAt).toBeLessThanOrEqual(after);
    // v2 flattens agent_api_key → agentApiKey and drops `role`.
    expect(creds.tenants).toEqual([
      { id: "tnt_a", name: "Workspace A", agentApiKey: "oma_aaa" },
      { id: "tnt_b", name: "Workspace B", agentApiKey: "oma_bbb" },
    ]);
  });

  it("throws on non-2xx with the server's error body in the message", async () => {
    stub = installFetchStub(() => ({
      status: 410,
      body: JSON.stringify({ error: "pairing code expired" }),
    }));
    restore = stub.restore;

    await expect(
      pairNonInteractive({
        serverUrl: "https://oma.example.com",
        pairingCode: "c",
        pairingState: "s",
        hostname: "h",
        os: "linux/x64",
        machineId: "mid",
        version: "v",
      }),
    ).rejects.toThrow(/HTTP 410.*pairing code expired/);
  });

  it("throws on non-JSON 200 response", async () => {
    stub = installFetchStub(() => ({ status: 200, body: "<html>not json</html>" }));
    restore = stub.restore;

    await expect(
      pairNonInteractive({
        serverUrl: "https://oma.example.com",
        pairingCode: "c",
        pairingState: "s",
        hostname: "h",
        os: "linux/x64",
        machineId: "mid",
        version: "v",
      }),
    ).rejects.toThrow(/non-JSON/);
  });
});

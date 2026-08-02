// Unit tests for the proxied-session federation path (issue #132 M1):
// runRemoteTurn's create → post → poll-to-idle round-trip against a faked
// remote OMA instance, remote-session reuse across turns, loop prevention,
// loud failures, and the credential boundary.

import { describe, it, expect, vi } from "vitest";
import {
  runRemoteTurn,
  assertFederationDepthAllowed,
  federationDepthOf,
  FEDERATION_DEPTH_HEADER,
  type FetchLike,
  type RemoteMirroredEvent,
} from "./federation";

const REMOTE_KEY = "omak_super_secret_remote_key";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status < 400,
    status,
    async text() {
      return JSON.stringify(body);
    },
    async json() {
      return body;
    },
  };
}

/**
 * A fake remote OMA. `pages` is the sequence of `/events` pages returned to
 * successive polls; anything else 404s so an unexpected call fails the test
 * rather than passing silently.
 */
function fakeRemote(opts: {
  sessionId?: string;
  pages: RemoteMirroredEvent[][];
  createStatus?: number;
  postStatus?: number;
}) {
  const calls: RecordedCall[] = [];
  let pollIndex = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: init?.headers ?? {},
      body: init?.body,
    });
    if (url.endsWith("/v1/sessions") && init?.method === "POST") {
      const status = opts.createStatus ?? 200;
      if (status >= 400) return jsonResponse({ error: "nope" }, status);
      return jsonResponse({ id: opts.sessionId ?? "sess_remote" });
    }
    if (url.includes("/events?")) {
      const page = opts.pages[Math.min(pollIndex++, opts.pages.length - 1)] ?? [];
      return jsonResponse({ data: page });
    }
    if (url.endsWith("/events") && init?.method === "POST") {
      const status = opts.postStatus ?? 200;
      if (status >= 400) return jsonResponse({ error: "nope" }, status);
      return jsonResponse({ ok: true });
    }
    return jsonResponse({ error: "unexpected call" }, 404);
  };
  return { fetchImpl, calls };
}

const noSleep = async () => {};

const idlePage = (seq: number): RemoteMirroredEvent[] => [
  { seq, type: "session.status_idle" },
];

describe("runRemoteTurn — proxied remote session (M1)", () => {
  it("creates a remote session, forwards the turn, polls to idle and mirrors events", async () => {
    const { fetchImpl, calls } = fakeRemote({
      pages: [
        [
          { seq: 1, type: "session.status_running" },
          { seq: 2, type: "agent.tool_use", content: { name: "bash" } },
          { seq: 3, type: "agent.message", content: [{ type: "text", text: "hello from the homelab" }] },
        ],
        idlePage(4),
      ],
    });
    const mirrored: RemoteMirroredEvent[] = [];

    const result = await runRemoteTurn(
      { base_url: "https://remote.example.com", api_key: REMOTE_KEY },
      {
        remoteAgentId: "agent_remote",
        remoteEnvironmentId: "env_k8s",
        message: "build the thing",
        fetchImpl,
        sleep: noSleep,
        onRemoteEvent: (e) => mirrored.push(e),
      },
      "proxy_session",
    );

    expect(result.remote_session_id).toBe("sess_remote");
    expect(result.text).toBe("hello from the homelab");
    expect(result.last_seq).toBe(4);

    // Every observed remote event is offered to the mirror, in log order.
    expect(mirrored.map((e) => e.type)).toEqual([
      "session.status_running",
      "agent.tool_use",
      "agent.message",
      "session.status_idle",
    ]);

    const create = calls.find((c) => c.method === "POST" && c.url.endsWith("/v1/sessions"))!;
    expect(JSON.parse(create.body!)).toMatchObject({
      agent: "agent_remote",
      environment_id: "env_k8s",
      metadata: { federation: { origin: "proxy_session", depth: 1 } },
    });
    expect(create.headers[FEDERATION_DEPTH_HEADER]).toBe("1");

    const post = calls.find((c) => c.method === "POST" && c.url.includes("/events"))!;
    expect(JSON.parse(post.body!)).toEqual({
      events: [{ type: "user.message", content: [{ type: "text", text: "build the thing" }] }],
    });
  });

  it("reuses the bound remote session on later turns and does not replay earlier events", async () => {
    const { fetchImpl, calls } = fakeRemote({
      pages: [[{ seq: 9, type: "agent.message", content: [{ type: "text", text: "turn two" }] }], idlePage(10)],
    });
    const mirrored: RemoteMirroredEvent[] = [];

    const result = await runRemoteTurn(
      { base_url: "https://remote.example.com", api_key: REMOTE_KEY },
      {
        remoteAgentId: "agent_remote",
        message: "second turn",
        remoteSessionId: "sess_existing",
        afterSeq: 8,
        fetchImpl,
        sleep: noSleep,
        onRemoteEvent: (e) => mirrored.push(e),
      },
      "proxy_session",
    );

    expect(result.remote_session_id).toBe("sess_existing");
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/v1/sessions"))).toBe(false);
    // First poll starts after the last seq this origin already mirrored.
    expect(calls.find((c) => c.url.includes("/events?"))!.url).toContain("after_seq=8");
    expect(mirrored.map((e) => e.seq)).toEqual([9, 10]);
  });

  it("fails loudly when the remote is unreachable", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("getaddrinfo ENOTFOUND remote.example.com");
    };
    await expect(
      runRemoteTurn(
        { base_url: "https://remote.example.com", api_key: REMOTE_KEY },
        { remoteAgentId: "a", message: "m", fetchImpl, sleep: noSleep },
        "proxy_session",
      ),
    ).rejects.toThrow(/ENOTFOUND/);
  });

  it("fails loudly when the remote rejects the key (401 on create)", async () => {
    const { fetchImpl } = fakeRemote({ pages: [], createStatus: 401 });
    await expect(
      runRemoteTurn(
        { base_url: "https://remote.example.com" },
        { remoteAgentId: "a", message: "m", fetchImpl, sleep: noSleep },
        "proxy_session",
      ),
    ).rejects.toThrow(/remote session create failed \(401\)/);
  });

  it("surfaces a remote session.error instead of returning empty text", async () => {
    const { fetchImpl } = fakeRemote({
      pages: [[{ seq: 1, type: "session.error", content: [{ type: "text", text: "sandbox blew up" }] }]],
    });
    await expect(
      runRemoteTurn(
        { base_url: "https://remote.example.com", api_key: REMOTE_KEY },
        { remoteAgentId: "a", message: "m", fetchImpl, sleep: noSleep },
        "proxy_session",
      ),
    ).rejects.toThrow(/remote agent error: sandbox blew up/);
  });

  it("times out rather than polling forever", async () => {
    // Never reaches idle.
    const { fetchImpl } = fakeRemote({ pages: [[{ seq: 1, type: "agent.status" }]] });
    await expect(
      runRemoteTurn(
        { base_url: "https://remote.example.com", api_key: REMOTE_KEY },
        { remoteAgentId: "a", message: "m", fetchImpl, sleep: noSleep, timeoutMs: -1 },
        "proxy_session",
      ),
    ).rejects.toThrow(/timed out/);
  });
});

describe("federation loop prevention", () => {
  it("reads the depth off session metadata", () => {
    expect(federationDepthOf(undefined)).toBe(0);
    expect(federationDepthOf({})).toBe(0);
    expect(federationDepthOf({ federation: { origin: "proxy_session", depth: 1 } })).toBe(1);
  });

  it("allows a non-federated session to become an origin", () => {
    expect(() => assertFederationDepthAllowed({ deployment_run: {} })).not.toThrow();
  });

  it("refuses a federated session from opening a further hop (A→B→C)", () => {
    expect(() => assertFederationDepthAllowed({ federation: { origin: "proxy_session", depth: 1 } })).toThrow(
      /federation loop refused/,
    );
  });
});

describe("credential boundary", () => {
  it("never returns or logs the remote api key", async () => {
    const { fetchImpl, calls } = fakeRemote({
      pages: [[{ seq: 1, type: "agent.message", content: [{ type: "text", text: "ok" }] }], idlePage(2)],
    });
    const logged: string[] = [];
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );
    const mirrored: RemoteMirroredEvent[] = [];
    try {
      const result = await runRemoteTurn(
        { base_url: "https://remote.example.com", api_key: REMOTE_KEY },
        {
          remoteAgentId: "a",
          message: "m",
          fetchImpl,
          sleep: noSleep,
          onRemoteEvent: (e) => mirrored.push(e),
        },
        "proxy_session",
      );
      // Nothing the caller can persist or render carries the key.
      expect(JSON.stringify(result)).not.toContain(REMOTE_KEY);
      expect(JSON.stringify(mirrored)).not.toContain(REMOTE_KEY);
      expect(logged.join("\n")).not.toContain(REMOTE_KEY);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }

    // The key exists in exactly one place: the outbound x-api-key header.
    const withKey = calls.filter((c) => JSON.stringify(c.headers).includes(REMOTE_KEY));
    expect(withKey.length).toBe(calls.length);
    expect(calls.some((c) => (c.body ?? "").includes(REMOTE_KEY))).toBe(false);
    expect(calls.some((c) => c.url.includes(REMOTE_KEY))).toBe(false);
  });
});

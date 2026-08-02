// Unit tests for the proxied-session federation path (issue #132 M1 + M2):
// runRemoteTurn's create → post → observe-to-idle round-trip against a faked
// remote OMA instance on both transports (M1 polling, M2 SSE streaming),
// remote-session reuse across turns, mid-stream disconnect resume, loop
// prevention, loud failures, and the credential boundary.

import { describe, it, expect, vi } from "vitest";
import {
  runRemoteTurn,
  assertFederationDepthAllowed,
  federationDepthOf,
  parseSseEvents,
  FEDERATION_DEPTH_HEADER,
  type FetchLike,
  type SseFetchLike,
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
        transport: "poll",
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
        transport: "poll",
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
        { remoteAgentId: "a", message: "m", fetchImpl, sleep: noSleep, transport: "poll" },
        "proxy_session",
      ),
    ).rejects.toThrow(/ENOTFOUND/);
  });

  it("fails loudly when the remote rejects the key (401 on create)", async () => {
    const { fetchImpl } = fakeRemote({ pages: [], createStatus: 401 });
    await expect(
      runRemoteTurn(
        { base_url: "https://remote.example.com" },
        { remoteAgentId: "a", message: "m", fetchImpl, sleep: noSleep, transport: "poll" },
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
        { remoteAgentId: "a", message: "m", fetchImpl, sleep: noSleep, transport: "poll" },
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
        { remoteAgentId: "a", message: "m", fetchImpl, sleep: noSleep, transport: "poll", timeoutMs: -1 },
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
        transport: "poll",
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

// ── M2: SSE event-stream passthrough ──────────────────────────────────────

/**
 * A fake remote OMA that serves `/events/stream` as SSE. `connections` is the
 * sequence of streams handed to successive connect attempts; each is a list of
 * events the remote emits before the connection ends. A connection that never
 * yields `session.status_idle` models a mid-turn drop.
 *
 * The fake replays like the real remote does: on reconnect it serves every
 * event with `seq > Last-Event-ID` from `log`, so overlap between what the
 * origin already mirrored and what the remote replays is exercised for real.
 */
function fakeSseRemote(opts: {
  /** Full remote log, in seq order. */
  log: RemoteMirroredEvent[];
  /** How many events each successive connection delivers before ending. */
  deliverPerConnection: number[];
  streamStatus?: number;
}) {
  const calls: RecordedCall[] = [];
  let connection = 0;
  const streamFetchImpl: SseFetchLike = async (url, init) => {
    calls.push({ url, method: init?.method ?? "GET", headers: init?.headers ?? {} });
    const status = opts.streamStatus ?? 200;
    if (status >= 400) {
      return { ok: false, status, async text() { return "no stream here"; }, chunks: async function* () {} };
    }
    const lastEventId = Number(init?.headers?.["Last-Event-ID"] ?? "0") || 0;
    const pending = opts.log.filter((e) => (e.seq ?? 0) > lastEventId);
    const take = opts.deliverPerConnection[connection++] ?? pending.length;
    const deliver = pending.slice(0, take);
    return {
      ok: true,
      status,
      async text() { return ""; },
      chunks: async function* () {
        // Deliberately split frames across chunk boundaries so the parser's
        // buffering is exercised, not just whole-frame delivery.
        yield "retry: 1000\n\n";
        for (const ev of deliver) {
          const frame = `event: ${ev.type}\nid: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
          yield frame.slice(0, 7);
          yield frame.slice(7);
        }
      },
    };
  };
  return { streamFetchImpl, calls };
}

describe("runRemoteTurn — SSE passthrough (M2)", () => {
  const remoteLog: RemoteMirroredEvent[] = [
    { seq: 1, type: "session.status_running" },
    { seq: 2, type: "agent.tool_use", content: { name: "bash" } },
    { seq: 3, type: "agent.message", content: [{ type: "text", text: "streamed live" }] },
    { seq: 4, type: "session.status_idle" },
  ];

  it("mirrors streamed remote events into the origin log, in order, to idle", async () => {
    const { fetchImpl, calls: pollCalls } = fakeRemote({ pages: [] });
    const { streamFetchImpl, calls } = fakeSseRemote({ log: remoteLog, deliverPerConnection: [4] });
    const mirrored: RemoteMirroredEvent[] = [];

    const result = await runRemoteTurn(
      { base_url: "https://remote.example.com", api_key: REMOTE_KEY },
      {
        remoteAgentId: "agent_remote",
        message: "build the thing",
        fetchImpl,
        streamFetchImpl,
        sleep: noSleep,
        onRemoteEvent: (e) => mirrored.push(e),
      },
      "proxy_session",
    );

    expect(mirrored.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(result.text).toBe("streamed live");
    expect(result.last_seq).toBe(4);
    // One connection, opened against the remote's SSE surface.
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("/v1/sessions/sess_remote/events/stream");
    expect(calls[0].headers["Last-Event-ID"]).toBe("0");
    // The poll transport was never used — no /events?after_seq= request.
    expect(pollCalls.some((c) => c.url.includes("/events?"))).toBe(false);
  });

  it("resumes a mid-stream disconnect from the last mirrored seq — no gaps, no duplicates", async () => {
    const { fetchImpl } = fakeRemote({ pages: [] });
    // First connection dies after 2 events; the remote then replays from
    // Last-Event-ID and delivers the rest.
    const { streamFetchImpl, calls } = fakeSseRemote({
      log: remoteLog,
      deliverPerConnection: [2, 2],
    });
    const mirrored: RemoteMirroredEvent[] = [];

    const result = await runRemoteTurn(
      { base_url: "https://remote.example.com", api_key: REMOTE_KEY },
      {
        remoteAgentId: "agent_remote",
        message: "m",
        fetchImpl,
        streamFetchImpl,
        sleep: noSleep,
        onRemoteEvent: (e) => mirrored.push(e),
      },
      "proxy_session",
    );

    expect(mirrored.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
    expect(result.last_seq).toBe(4);
    expect(calls.length).toBe(2);
    expect(calls[1].headers["Last-Event-ID"]).toBe("2");
  });

  it("drops duplicate events a remote replays below the mirrored seq", async () => {
    const { fetchImpl } = fakeRemote({ pages: [] });
    // A remote that ignores Last-Event-ID and replays the whole log on
    // reconnect must not double-write into the origin's durable log.
    const { streamFetchImpl } = (() => {
      let connection = 0;
      const impl: SseFetchLike = async () => {
        const take = connection++ === 0 ? 2 : remoteLog.length;
        return {
          ok: true,
          status: 200,
          async text() { return ""; },
          chunks: async function* () {
            for (const ev of remoteLog.slice(0, take)) {
              yield `id: ${ev.seq}\ndata: ${JSON.stringify(ev)}\n\n`;
            }
          },
        };
      };
      return { streamFetchImpl: impl };
    })();
    const mirrored: RemoteMirroredEvent[] = [];

    await runRemoteTurn(
      { base_url: "https://remote.example.com", api_key: REMOTE_KEY },
      { remoteAgentId: "a", message: "m", fetchImpl, streamFetchImpl, sleep: noSleep, onRemoteEvent: (e) => mirrored.push(e) },
      "proxy_session",
    );

    expect(mirrored.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
  });

  it("falls back to the poll transport when the remote serves no SSE surface", async () => {
    const { fetchImpl, calls: httpCalls } = fakeRemote({
      pages: [
        [{ seq: 1, type: "agent.message", content: [{ type: "text", text: "polled" }] }],
        idlePage(2),
      ],
    });
    const { streamFetchImpl } = fakeSseRemote({ log: [], deliverPerConnection: [], streamStatus: 404 });

    const result = await runRemoteTurn(
      { base_url: "https://remote.example.com", api_key: REMOTE_KEY },
      { remoteAgentId: "a", message: "m", fetchImpl, streamFetchImpl, sleep: noSleep },
      "proxy_session",
    );

    expect(result.text).toBe("polled");
    expect(httpCalls.some((c) => c.url.includes("/events?"))).toBe(true);
  });

  it("fails loudly when the stream keeps dropping before idle", async () => {
    const { fetchImpl } = fakeRemote({ pages: [] });
    // Every connection delivers one non-idle event then dies.
    const { streamFetchImpl } = fakeSseRemote({
      log: [{ seq: 1, type: "agent.status" }],
      deliverPerConnection: [1, 0, 0, 0],
    });

    await expect(
      runRemoteTurn(
        { base_url: "https://remote.example.com", api_key: REMOTE_KEY },
        { remoteAgentId: "a", message: "m", fetchImpl, streamFetchImpl, sleep: noSleep, maxStreamReconnects: 2 },
        "proxy_session",
      ),
    ).rejects.toThrow(/stream dropped/);
  });

  it("surfaces a streamed session.error instead of returning empty text", async () => {
    const { fetchImpl } = fakeRemote({ pages: [] });
    const { streamFetchImpl } = fakeSseRemote({
      log: [{ seq: 1, type: "session.error", content: [{ type: "text", text: "sandbox blew up" }] }],
      deliverPerConnection: [1],
    });
    await expect(
      runRemoteTurn(
        { base_url: "https://remote.example.com", api_key: REMOTE_KEY },
        { remoteAgentId: "a", message: "m", fetchImpl, streamFetchImpl, sleep: noSleep },
        "proxy_session",
      ),
    ).rejects.toThrow(/remote agent error: sandbox blew up/);
  });

  it("never leaks the remote api key on the streaming path", async () => {
    const { fetchImpl } = fakeRemote({ pages: [] });
    const { streamFetchImpl, calls } = fakeSseRemote({ log: remoteLog, deliverPerConnection: [4] });
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
        { remoteAgentId: "a", message: "m", fetchImpl, streamFetchImpl, sleep: noSleep, onRemoteEvent: (e) => mirrored.push(e) },
        "proxy_session",
      );
      expect(JSON.stringify(result)).not.toContain(REMOTE_KEY);
      expect(JSON.stringify(mirrored)).not.toContain(REMOTE_KEY);
      expect(logged.join("\n")).not.toContain(REMOTE_KEY);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    // The key rides the stream request in exactly one place: the header.
    expect(calls.every((c) => c.headers["x-api-key"] === REMOTE_KEY)).toBe(true);
    expect(calls.some((c) => c.url.includes(REMOTE_KEY))).toBe(false);
  });
});

describe("parseSseEvents", () => {
  async function* chunksOf(s: string[]): AsyncIterable<string> {
    for (const c of s) yield c;
  }

  it("reassembles frames split across chunk boundaries and skips non-JSON frames", async () => {
    const out: RemoteMirroredEvent[] = [];
    for await (const ev of parseSseEvents(
      chunksOf(["retry: 1000\n\n", 'id: 1\nda', 'ta: {"seq":1,"type":"agent.message"}\n\n', ": keepalive\n\n"]),
    )) {
      out.push(ev);
    }
    expect(out).toEqual([{ seq: 1, type: "agent.message" }]);
  });
});

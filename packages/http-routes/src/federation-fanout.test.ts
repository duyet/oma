// @ts-nocheck
// Route-seam tests for unified federated listing (issue #132 M3).
//
// Mounts `federatedListBody` behind a minimal list route — the exact shape
// /v1/sessions and /v1/agents use — over an in-memory KV holding registered
// remote instances and a faked remote fetch. Covers: fan-out is off by
// default, merged ordering honours (created_at, id) DESC across sources, a
// dead remote degrades to partial results + an error marker instead of a
// 500, control params aren't forwarded (no multi-hop), and the remote API
// key never reaches a response body or a log line.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { Hono } from "hono";
import { InMemoryKvStore } from "@duyet/oma-kv-store";
import { buildLabeledCrypto, FEDERATION_CRYPTO_LABEL, federationKvKey } from "@duyet/oma-shared";
import { federatedListBody, mergeFederatedPages, type FanOutFetch, type FederatedRow } from "./federation-fanout";

const TENANT = "tn_test";
const REMOTE_KEY = "omak_super_secret_remote_key";
const crypto = buildLabeledCrypto("root-secret-for-tests", FEDERATION_CRYPTO_LABEL);

async function registerInstance(
  kv: InMemoryKvStore,
  id: string,
  name: string,
  baseUrl: string,
  apiKey = REMOTE_KEY,
) {
  await kv.put(
    federationKvKey(TENANT, id),
    JSON.stringify({
      id,
      tenant_id: TENANT,
      name,
      base_url: baseUrl,
      api_key_enc: await crypto.encrypt(apiKey),
      created_at: Date.now(),
    }),
  );
}

interface RemoteCall {
  url: string;
  headers: Record<string, string>;
}

/** A fake remote fleet keyed by base URL. `null` models a dead instance. */
function fakeRemotes(byHost: Record<string, FederatedRow[] | null>) {
  const calls: RemoteCall[] = [];
  const fetchImpl: FanOutFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers ?? {} });
    const host = new URL(url).host;
    const rows = byHost[host];
    if (rows === null || rows === undefined) {
      throw new Error(`connect ECONNREFUSED ${host}`);
    }
    return { ok: true, status: 200, async json() { return { data: rows }; } };
  };
  return { fetchImpl, calls };
}

function makeApp(opts: {
  kv: InMemoryKvStore;
  localItems: FederatedRow[];
  localNextCursor?: string;
  fetchImpl?: FanOutFetch;
  noCrypto?: boolean;
  limit?: number;
}) {
  const app = new Hono();
  app.get("/", async (c) => {
    const body = await federatedListBody(c, {
      kv: opts.kv as never,
      crypto: opts.noCrypto ? undefined : crypto,
      tenantId: TENANT,
      resource: "sessions",
      limit: opts.limit ?? 50,
      localItems: opts.localItems,
      localNextCursor: opts.localNextCursor,
      fetchImpl: opts.fetchImpl,
    });
    return c.json(body);
  });
  return app;
}

const local: FederatedRow[] = [
  { id: "sess_local_b", created_at: "2026-05-02T00:00:00.000Z" },
  { id: "sess_local_a", created_at: "2026-04-28T00:00:00.000Z" },
];

describe("federated listing fan-out (M3)", () => {
  let kv: InMemoryKvStore;
  beforeEach(async () => {
    kv = new InMemoryKvStore();
    await registerInstance(kv, "fed_eu", "eu-cluster", "https://eu.example.com");
  });

  it("is off by default — no remote is contacted and only local rows return", async () => {
    const { fetchImpl, calls } = fakeRemotes({ "eu.example.com": [{ id: "sess_r", created_at: "2026-06-01T00:00:00.000Z" }] });
    const res = await makeApp({ kv, localItems: local, fetchImpl }).request("/");
    const body = await res.json();

    expect(calls).toEqual([]);
    expect(body.data.map((r: FederatedRow) => r.id)).toEqual(["sess_local_b", "sess_local_a"]);
    expect(body.remote_errors).toBeUndefined();
  });

  it("merges remote rows in (created_at, id) DESC order and badges their source", async () => {
    await registerInstance(kv, "fed_us", "us-cluster", "https://us.example.com");
    const { fetchImpl } = fakeRemotes({
      "eu.example.com": [{ id: "sess_eu", created_at: "2026-05-05T00:00:00.000Z" }],
      "us.example.com": [{ id: "sess_us", created_at: "2026-04-30T00:00:00.000Z" }],
    });
    const res = await makeApp({ kv, localItems: local, fetchImpl }).request("/?include_remotes=1");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.map((r: FederatedRow) => r.id)).toEqual([
      "sess_eu", // 05-05
      "sess_local_b", // 05-02
      "sess_us", // 04-30
      "sess_local_a", // 04-28
    ]);
    expect(body.data.find((r: FederatedRow) => r.id === "sess_eu")).toMatchObject({
      remote_instance_id: "fed_eu",
      remote_instance_name: "eu-cluster",
    });
    // Local rows carry no badge — that's how a client tells them apart.
    expect(body.data.find((r: FederatedRow) => r.id === "sess_local_b").remote_instance_id).toBeUndefined();
  });

  it("breaks created_at ties by id DESC", async () => {
    const { fetchImpl } = fakeRemotes({
      "eu.example.com": [{ id: "sess_zz", created_at: "2026-05-02T00:00:00.000Z" }],
    });
    const res = await makeApp({
      kv,
      localItems: [{ id: "sess_aa", created_at: "2026-05-02T00:00:00.000Z" }],
      fetchImpl,
    }).request("/?include_remotes=1");
    const body = await res.json();
    expect(body.data.map((r: FederatedRow) => r.id)).toEqual(["sess_zz", "sess_aa"]);
  });

  it("degrades a dead remote to partial results plus an error marker, not a 500", async () => {
    await registerInstance(kv, "fed_dead", "dead-cluster", "https://dead.example.com");
    const { fetchImpl } = fakeRemotes({
      "eu.example.com": [{ id: "sess_eu", created_at: "2026-05-05T00:00:00.000Z" }],
      "dead.example.com": null,
    });
    const res = await makeApp({ kv, localItems: local, fetchImpl }).request("/?include_remotes=1");
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.map((r: FederatedRow) => r.id)).toEqual(["sess_eu", "sess_local_b", "sess_local_a"]);
    expect(body.remote_errors).toEqual([
      { instance_id: "fed_dead", name: "dead-cluster", error: expect.stringContaining("ECONNREFUSED") },
    ]);
  });

  it("marks a remote that answers non-2xx without dropping the others", async () => {
    const fetchImpl: FanOutFetch = async () => ({ ok: false, status: 502, async json() { return {}; } });
    const res = await makeApp({ kv, localItems: local, fetchImpl }).request("/?include_remotes=1");
    const body = await res.json();
    expect(body.data.map((r: FederatedRow) => r.id)).toEqual(["sess_local_b", "sess_local_a"]);
    expect(body.remote_errors[0].error).toContain("502");
  });

  it("marks a slow remote as timed out rather than hanging the listing", async () => {
    const fetchImpl: FanOutFetch = () => new Promise(() => {}); // never settles
    const app = new Hono();
    app.get("/", async (c) => {
      const body = await federatedListBody(c, {
        kv: kv as never,
        crypto,
        tenantId: TENANT,
        resource: "sessions",
        limit: 50,
        localItems: local,
        fetchImpl,
        timeoutMs: 5,
      });
      return c.json(body);
    });
    const body = await (await app.request("/?include_remotes=1")).json();
    expect(body.data).toHaveLength(2);
    expect(body.remote_errors[0].error).toContain("timed out");
  });

  it("narrows the fan-out with remote_instance_ids", async () => {
    await registerInstance(kv, "fed_us", "us-cluster", "https://us.example.com");
    const { fetchImpl, calls } = fakeRemotes({
      "eu.example.com": [{ id: "sess_eu", created_at: "2026-05-05T00:00:00.000Z" }],
      "us.example.com": [{ id: "sess_us", created_at: "2026-05-06T00:00:00.000Z" }],
    });
    const body = await (
      await makeApp({ kv, localItems: [], fetchImpl }).request(
        "/?include_remotes=1&remote_instance_ids=fed_us",
      )
    ).json();
    expect(calls).toHaveLength(1);
    expect(body.data.map((r: FederatedRow) => r.id)).toEqual(["sess_us"]);
  });

  it("forwards filters + cursor to each remote but never the fan-out control params", async () => {
    const { fetchImpl, calls } = fakeRemotes({ "eu.example.com": [] });
    await makeApp({ kv, localItems: [], fetchImpl }).request(
      "/?include_remotes=1&remote_instance_ids=fed_eu&status=idle&limit=10&cursor=abc",
    );
    const url = new URL(calls[0].url);
    expect(url.pathname).toBe("/v1/sessions");
    expect(url.searchParams.get("status")).toBe("idle");
    expect(url.searchParams.get("cursor")).toBe("abc");
    // Forwarding include_remotes would make the remote fan out in turn —
    // a multi-hop path the depth-1 federation model forbids.
    expect(url.searchParams.get("include_remotes")).toBeNull();
    expect(url.searchParams.get("remote_instance_ids")).toBeNull();
  });

  it("emits a next_cursor derived from the last merged row when truncating", async () => {
    const { fetchImpl } = fakeRemotes({
      "eu.example.com": [
        { id: "sess_eu1", created_at: "2026-05-06T00:00:00.000Z" },
        { id: "sess_eu2", created_at: "2026-05-04T00:00:00.000Z" },
      ],
    });
    const body = await (
      await makeApp({ kv, localItems: local, fetchImpl, limit: 2 }).request("/?include_remotes=1")
    ).json();
    expect(body.data.map((r: FederatedRow) => r.id)).toEqual(["sess_eu1", "sess_eu2"]);
    expect(typeof body.next_cursor).toBe("string");
    // Decodes to the last row kept — every source honours the same codec.
    const decoded = JSON.parse(atob(body.next_cursor.replace(/-/g, "+").replace(/_/g, "/")));
    expect(decoded.i).toBe("sess_eu2");
    expect(decoded.t).toBe(Date.parse("2026-05-04T00:00:00.000Z"));
  });

  it("marks every instance when federation crypto is unavailable", async () => {
    const { fetchImpl, calls } = fakeRemotes({ "eu.example.com": [] });
    const body = await (
      await makeApp({ kv, localItems: local, fetchImpl, noCrypto: true }).request(
        "/?include_remotes=1",
      )
    ).json();
    expect(calls).toEqual([]);
    expect(body.data).toHaveLength(2);
    expect(body.remote_errors[0].error).toContain("crypto unavailable");
  });

  it("never puts the remote api key in the response body or a log line", async () => {
    await registerInstance(kv, "fed_dead", "dead", "https://dead.example.com");
    const { fetchImpl, calls } = fakeRemotes({
      "eu.example.com": [{ id: "sess_eu", created_at: "2026-05-05T00:00:00.000Z" }],
      "dead.example.com": null,
    });
    const logged: string[] = [];
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        logged.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
      }),
    );
    try {
      const res = await makeApp({ kv, localItems: local, fetchImpl }).request("/?include_remotes=1");
      const raw = await res.text();
      expect(raw).not.toContain(REMOTE_KEY);
      expect(logged.join("\n")).not.toContain(REMOTE_KEY);
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
    // The key exists only as an outbound header — never in a URL.
    expect(calls.every((c) => c.headers["x-api-key"] === REMOTE_KEY)).toBe(true);
    expect(calls.some((c) => c.url.includes(REMOTE_KEY))).toBe(false);
  });
});

describe("mergeFederatedPages", () => {
  it("keeps the caller's next_cursor when a source has more but the merge wasn't truncated", () => {
    const merged = mergeFederatedPages(
      [[{ id: "a", created_at: "2026-05-02T00:00:00.000Z" }]],
      50,
      true,
    );
    expect(merged.items).toHaveLength(1);
    expect(merged.nextCursor).toBeTruthy();
  });

  it("emits no cursor when every source is exhausted", () => {
    const merged = mergeFederatedPages([[{ id: "a", created_at: "2026-05-02T00:00:00.000Z" }]], 50);
    expect(merged.nextCursor).toBeUndefined();
  });
});

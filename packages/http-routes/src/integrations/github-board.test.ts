// Route-level coverage for the GitHub issues-board proxies backing the
// Console Kanban "GitHub Issues" tab. These endpoints resolve the path
// installation (ownership + vault checked) and forward to the gateway's
// /github/internal/* routes with the internal secret. The token mint +
// GitHub REST call live in the gateway; here we only verify the resolve +
// forward contract (ownership 404, missing-vault 409, forwarded body shape).

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  InMemoryGitHubBoardCacheRepo,
  InMemoryInstallationRepo,
} from "@duyet/oma-integrations-core/test-fakes";
import {
  buildIntegrationsRoutes,
  type IntegrationsBags,
  type InstallProxyForwarder,
} from "./index";

const USER = "user-a";
const OTHER_USER = "user-b";

function makeInstallation(repo: InMemoryInstallationRepo, opts: { userId: string; withVault: boolean }) {
  return repo
    .insert({
      tenantId: "tenant-a",
      userId: opts.userId,
      providerId: "github",
      workspaceId: "999",
      workspaceName: "acme",
      installKind: "dedicated",
      appId: "app_1",
      botUserId: "bot_1",
      accessToken: "ghs_seed",
      refreshToken: null,
      scopes: [],
    })
    .then(async (inst) => {
      if (opts.withVault) await repo.setVaultId(inst.id, "vlt_1");
      return inst;
    });
}

/** Records what the route forwarded so tests can assert the wire shape. */
function recordingProxy(): {
  proxy: InstallProxyForwarder;
  calls: Array<{ subpath: string; body: unknown; needsInternalSecret: boolean }>;
} {
  const calls: Array<{ subpath: string; body: unknown; needsInternalSecret: boolean }> = [];
  const proxy: InstallProxyForwarder = {
    async forward({ subpath, body, needsInternalSecret }) {
      calls.push({ subpath, body, needsInternalSecret });
      return new Response(JSON.stringify({ data: [], ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
  return { proxy, calls };
}

function buildApp(
  repo: InMemoryInstallationRepo,
  proxy: InstallProxyForwarder | null,
  userId = USER,
  boardCache?: InMemoryGitHubBoardCacheRepo,
) {
  const bags: IntegrationsBags = {
    linear: null,
    slack: null,
    github: {
      installations: repo,
      // Only `installations` (+ optionally `boardCache`) is exercised by the
      // board routes.
      publications: {} as never,
      boardCache: boardCache ?? null,
    },
  };
  const routes = buildIntegrationsRoutes({ bags: () => bags, installProxy: proxy });
  const wrapper = new Hono<{ Variables: { tenant_id: string; user_id?: string } }>();
  wrapper.use("*", async (c, next) => {
    c.set("tenant_id", "tenant-a");
    c.set("user_id", userId);
    await next();
  });
  wrapper.route("/", routes);
  return wrapper;
}

/** Proxy whose response (or failure) each call can control. */
function scriptedProxy(respond: (n: number) => Response | Promise<Response>): {
  proxy: InstallProxyForwarder;
  calls: Array<{ subpath: string; body: unknown }>;
} {
  const calls: Array<{ subpath: string; body: unknown }> = [];
  const proxy: InstallProxyForwarder = {
    async forward({ subpath, body }) {
      calls.push({ subpath, body });
      return respond(calls.length);
    },
  };
  return { proxy, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const REPOS = [{ full_name: "acme/widgets", name: "widgets", owner: "acme" }];

describe("GitHub issues board proxies", () => {
  it("forwards a repos request to github/internal/list-repos with the vault id", async () => {
    const repo = new InMemoryInstallationRepo();
    const inst = await makeInstallation(repo, { userId: USER, withVault: true });
    const { proxy, calls } = recordingProxy();
    const app = buildApp(repo, proxy);

    const res = await app.request(`/github/installations/${inst.id}/repos?page=2`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0].subpath).toBe("github/internal/list-repos");
    expect(calls[0].needsInternalSecret).toBe(true);
    expect(calls[0].body).toMatchObject({ userId: USER, vaultId: "vlt_1", page: 2 });
  });

  it("forwards an issues request with parsed repo slug + filters", async () => {
    const repo = new InMemoryInstallationRepo();
    const inst = await makeInstallation(repo, { userId: USER, withVault: true });
    const { proxy, calls } = recordingProxy();
    const app = buildApp(repo, proxy);

    const res = await app.request(
      `/github/installations/${inst.id}/issues?repo=acme%2Fwidgets&state=closed&labels=bug,ui&assignee=octocat&q=crash`,
    );
    expect(res.status).toBe(200);
    expect(calls[0].subpath).toBe("github/internal/list-issues");
    expect(calls[0].body).toMatchObject({
      userId: USER,
      vaultId: "vlt_1",
      owner: "acme",
      repo: "widgets",
      state: "closed",
      labels: ["bug", "ui"],
      assignee: "octocat",
      q: "crash",
      page: 1,
    });
  });

  it("404s when the installation belongs to another user", async () => {
    const repo = new InMemoryInstallationRepo();
    const inst = await makeInstallation(repo, { userId: OTHER_USER, withVault: true });
    const { proxy, calls } = recordingProxy();
    const app = buildApp(repo, proxy); // request runs as USER

    const res = await app.request(`/github/installations/${inst.id}/repos`);
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it("409s when the installation has no connected vault", async () => {
    const repo = new InMemoryInstallationRepo();
    const inst = await makeInstallation(repo, { userId: USER, withVault: false });
    const { proxy, calls } = recordingProxy();
    const app = buildApp(repo, proxy);

    const res = await app.request(`/github/installations/${inst.id}/issues?repo=acme/widgets`);
    expect(res.status).toBe(409);
    expect(calls).toHaveLength(0);
  });
});

// ─── Read-through cache (github_board_cache) ────────────────────────────
// The repo + assignee lists are slow to fetch and change rarely, so they're
// persisted and served from the DB inside a 10-minute TTL. Issues are never
// cached (they carry live filters).
describe("GitHub board cache", () => {
  const TTL_MS = 10 * 60_000;

  async function setup(respond: (n: number) => Response | Promise<Response>) {
    const repo = new InMemoryInstallationRepo();
    const inst = await makeInstallation(repo, { userId: USER, withVault: true });
    const cache = new InMemoryGitHubBoardCacheRepo();
    const { proxy, calls } = scriptedProxy(respond);
    return { inst, cache, calls, app: buildApp(repo, proxy, USER, cache) };
  }

  it("forwards the first repos request, then serves the second from the cache", async () => {
    const { inst, calls, app } = await setup(() => jsonResponse({ data: REPOS, has_more: false }));

    const first = await app.request(`/github/installations/${inst.id}/repos`);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ data: REPOS });
    expect(calls).toHaveLength(1);

    const second = await app.request(`/github/installations/${inst.id}/repos`);
    expect(second.status).toBe(200);
    const body = (await second.json()) as { data: unknown; cached_at: number; stale?: true };
    expect(body.data).toEqual(REPOS);
    expect(typeof body.cached_at).toBe("number");
    expect(body.stale).toBeUndefined();
    // The whole point: zero additional forwards inside the TTL.
    expect(calls).toHaveLength(1);
  });

  it("omits cached_at on the fresh uncached fetch", async () => {
    const { inst, app } = await setup(() => jsonResponse({ data: REPOS, has_more: false }));
    const res = await app.request(`/github/installations/${inst.id}/repos`);
    expect(await res.json()).not.toHaveProperty("cached_at");
  });

  it("re-forwards and rewrites the row once fetched_at is older than the TTL", async () => {
    const { inst, cache, calls, app } = await setup(() =>
      jsonResponse({ data: REPOS, has_more: false }),
    );
    const stale = Date.now() - TTL_MS - 1_000;
    await cache.put(inst.id, "repos", JSON.stringify([{ full_name: "old/repo" }]), stale);

    const res = await app.request(`/github/installations/${inst.id}/repos`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    const row = await cache.get(inst.id, "repos");
    expect(JSON.parse(row!.payloadJson)).toEqual(REPOS);
    expect(row!.fetchedAt).toBeGreaterThan(stale);
  });

  it("?refresh=1 bypasses a fresh row", async () => {
    const { inst, cache, calls, app } = await setup(() =>
      jsonResponse({ data: REPOS, has_more: false }),
    );
    await cache.put(inst.id, "repos", JSON.stringify([{ full_name: "old/repo" }]), Date.now());

    const res = await app.request(`/github/installations/${inst.id}/repos?refresh=1`);
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(await res.json()).toMatchObject({ data: REPOS });
  });

  it("serves a stale row with stale:true when the upstream fetch fails", async () => {
    const { inst, cache, app } = await setup(() => jsonResponse({ error: "boom" }, 502));
    const old = Date.now() - TTL_MS - 1_000;
    await cache.put(inst.id, "repos", JSON.stringify(REPOS), old);

    const res = await app.request(`/github/installations/${inst.id}/repos`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ data: REPOS, cached_at: old, stale: true });
  });

  it("propagates the upstream error when no row exists", async () => {
    const { inst, app } = await setup(() => jsonResponse({ error: "boom" }, 502));
    const res = await app.request(`/github/installations/${inst.id}/repos`);
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: "boom" });
  });

  it("never caches a non-2xx body", async () => {
    const { inst, cache, app } = await setup(() => jsonResponse({ data: [] }, 500));
    await app.request(`/github/installations/${inst.id}/repos`);
    expect(await cache.get(inst.id, "repos")).toBeNull();
  });

  it("still serves the fresh data when the cache write fails", async () => {
    const { inst, cache, app } = await setup(() => jsonResponse({ data: REPOS, has_more: false }));
    cache.failWrites = true;
    const res = await app.request(`/github/installations/${inst.id}/repos`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: REPOS });
  });

  it("forwards assignees with owner + repo and caches per repo slug", async () => {
    const users = [{ login: "octocat", avatar_url: "https://img/1" }];
    const { inst, cache, calls, app } = await setup(() => jsonResponse({ data: users }));

    const res = await app.request(
      `/github/installations/${inst.id}/assignees?repo=acme%2Fwidgets`,
    );
    expect(res.status).toBe(200);
    expect(calls[0].subpath).toBe("github/internal/list-assignees");
    expect(calls[0].body).toMatchObject({
      userId: USER,
      vaultId: "vlt_1",
      owner: "acme",
      repo: "widgets",
    });
    const row = await cache.get(inst.id, "assignees:acme/widgets");
    expect(JSON.parse(row!.payloadJson)).toEqual(users);

    // Second call inside the TTL is served from the row.
    const again = await app.request(
      `/github/installations/${inst.id}/assignees?repo=acme%2Fwidgets`,
    );
    expect(calls).toHaveLength(1);
    expect(await again.json()).toMatchObject({ data: users });
  });

  it("400s a missing repo param on assignees without forwarding", async () => {
    const { inst, calls, app } = await setup(() => jsonResponse({ data: [] }));
    const res = await app.request(`/github/installations/${inst.id}/assignees`);
    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);

    const blank = await app.request(`/github/installations/${inst.id}/assignees?repo=%20`);
    expect(blank.status).toBe(400);
    expect(calls).toHaveLength(0);
  });

  it("404s another user's installation and 409s a vault-less one without touching the cache", async () => {
    const repo = new InMemoryInstallationRepo();
    const foreign = await makeInstallation(repo, { userId: OTHER_USER, withVault: true });
    const novault = await makeInstallation(repo, { userId: USER, withVault: false });
    const cache = new InMemoryGitHubBoardCacheRepo();
    const { proxy, calls } = scriptedProxy(() => jsonResponse({ data: REPOS }));
    const app = buildApp(repo, proxy, USER, cache);

    expect((await app.request(`/github/installations/${foreign.id}/repos`)).status).toBe(404);
    expect(
      (await app.request(`/github/installations/${novault.id}/assignees?repo=a/b`)).status,
    ).toBe(409);
    expect(calls).toHaveLength(0);
    expect(cache.rows.size).toBe(0);
  });
});

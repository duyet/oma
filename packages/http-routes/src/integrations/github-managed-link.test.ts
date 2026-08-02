// Route-level coverage for the GitHub reconcile ("link existing
// installation") flow:
//
//   GET /github/managed/link/callback   — gateway; the managed App's OAuth
//                                         Callback URL on github.com
//   GET /v1/integrations/github/managed/link          — start (302 to GitHub)
//   GET /v1/integrations/github/installations/:id/detail — live grant detail
//
// This is the path that rescues an App installed straight from github.com,
// which never hit our Setup URL and so has no `github_installations` row.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import type {
  ContinueInstallArgs,
  ContinueInstallResult,
  InstallBridge,
  JwtSigner,
} from "@duyet/oma-integrations-core";
import { InMemoryInstallationRepo } from "@duyet/oma-integrations-core/test-fakes";
import { buildIntegrationsGatewayRoutes } from "./gateway";
import {
  buildIntegrationsRoutes,
  type IntegrationsBags,
  type InstallProxyForwarder,
} from "./index";

const CONSOLE_ORIGIN = "https://console.example.com";
const RETURN_URL = `${CONSOLE_ORIGIN}/integrations/github`;
const USER = "user-a";

const fakeJwt: JwtSigner = {
  async sign(payload) {
    return btoa(JSON.stringify(payload));
  },
  async verify<T extends object = object>(token: string): Promise<T> {
    try {
      return JSON.parse(atob(token)) as T;
    } catch {
      throw new Error("invalid token");
    }
  },
};

function stateFor(payload: object): string {
  return btoa(JSON.stringify(payload));
}

function stubBridge(
  respond: (args: ContinueInstallArgs) => Promise<ContinueInstallResult>,
): { bridge: InstallBridge; calls: ContinueInstallArgs[] } {
  const calls: ContinueInstallArgs[] = [];
  const bridge = {
    async continueInstall(args: ContinueInstallArgs) {
      calls.push(args);
      return await respond(args);
    },
  } as unknown as InstallBridge;
  return { bridge, calls };
}

function buildGateway(bridge: InstallBridge) {
  return buildIntegrationsGatewayRoutes({
    installBridge: bridge,
    jwt: fakeJwt,
    webhooks: {},
    internalSecret: null,
    consoleOrigin: CONSOLE_ORIGIN,
  });
}

describe("GET /github/managed/link/callback", () => {
  it("links the user's installations and reports the count back to the Console", async () => {
    const { bridge, calls } = stubBridge(async () => ({
      publicationId: "",
      returnUrl: RETURN_URL,
      login: "acme",
      linked: 2,
    }));
    const state = stateFor({ kind: "github.link.workspace", returnUrl: RETURN_URL });

    const res = await buildGateway(bridge).request(
      `/github/managed/link/callback?code=abc&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(RETURN_URL);
    expect(location.searchParams.get("managed_install")).toBe("linked");
    expect(location.searchParams.get("linked")).toBe("2");
    expect(location.searchParams.get("connected")).toBe("1");
    expect(location.searchParams.get("login")).toBe("acme");

    // Must take the reconcile branch — NOT the install-callback one, which
    // would look for an installation_id that this callback never carries.
    expect(calls).toHaveLength(1);
    expect(calls[0].code).toBe("abc");
    expect(calls[0].extra).toMatchObject({ linkExisting: true });
    expect(calls[0].extra?.workspaceManaged).toBeUndefined();
  });

  it("reports `ok` (not `linked`) when everything was already recorded", async () => {
    const { bridge } = stubBridge(async () => ({
      publicationId: "",
      returnUrl: RETURN_URL,
      linked: 0,
    }));
    const state = stateFor({ kind: "github.link.workspace", returnUrl: RETURN_URL });

    const res = await buildGateway(bridge).request(
      `/github/managed/link/callback?code=abc&state=${encodeURIComponent(state)}`,
    );

    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("managed_install")).toBe("ok");
    expect(location.searchParams.get("linked")).toBe("0");
  });

  it("redirects to the Console (not a raw error) when the user denies authorization", async () => {
    const { bridge, calls } = stubBridge(async () => ({ publicationId: "", returnUrl: null }));
    const state = stateFor({ kind: "github.link.workspace", returnUrl: RETURN_URL });

    const res = await buildGateway(bridge).request(
      `/github/managed/link/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${RETURN_URL}?managed_install=error`);
    expect(calls).toHaveLength(0);
  });

  it("absolutizes the Console fallback when the state carried no returnUrl", async () => {
    const { bridge } = stubBridge(async () => {
      throw new Error("managed App OAuth not configured");
    });

    const res = await buildGateway(bridge).request(
      "/github/managed/link/callback?code=abc&state=not-a-signed-jwt",
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${CONSOLE_ORIGIN}/integrations/github?managed_install=error`,
    );
  });
});

// ─── Public (tenant-authed) routes ──────────────────────────────────────

function recordingProxy(response: () => Response): {
  proxy: InstallProxyForwarder;
  calls: Array<{ subpath: string; body: unknown }>;
} {
  const calls: Array<{ subpath: string; body: unknown }> = [];
  const proxy: InstallProxyForwarder = {
    async forward({ subpath, body }) {
      calls.push({ subpath, body });
      return response();
    },
  };
  return { proxy, calls };
}

function buildApp(repo: InMemoryInstallationRepo, proxy: InstallProxyForwarder | null) {
  const bags: IntegrationsBags = {
    linear: null,
    slack: null,
    github: { installations: repo, publications: {} as never },
  };
  const routes = buildIntegrationsRoutes({ bags: () => bags, installProxy: proxy });
  const wrapper = new Hono<{ Variables: { tenant_id: string; user_id?: string } }>();
  wrapper.use("*", async (c, next) => {
    c.set("tenant_id", "tenant-a");
    c.set("user_id", USER);
    await next();
  });
  wrapper.route("/", routes);
  return wrapper;
}

function seedInstallation(repo: InMemoryInstallationRepo, userId = USER) {
  return repo.insert({
    tenantId: "tenant-a",
    userId,
    providerId: "github",
    workspaceId: "555000",
    workspaceName: "acme",
    installKind: "dedicated",
    appId: null,
    botUserId: "oma-managed-bot[bot]",
    accessToken: "ghs_seed",
    refreshToken: null,
    scopes: [],
  });
}

describe("GET /github/managed/link", () => {
  it("302s the browser to the URL the gateway hands back", async () => {
    const repo = new InMemoryInstallationRepo();
    const { proxy, calls } = recordingProxy(
      () =>
        new Response(JSON.stringify({ url: "https://github.com/login/oauth/authorize?x=1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await buildApp(repo, proxy).request(
      "/github/managed/link?returnUrl=https%3A%2F%2Fconsole.example.com%2Fintegrations%2Fgithub",
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://github.com/login/oauth/authorize?x=1");
    expect(calls[0].subpath).toBe("github/managed/link");
    expect(calls[0].body).toMatchObject({ userId: USER, returnUrl: RETURN_URL });
  });

  it("sends the user back to the Console when the App has no OAuth credentials", async () => {
    const repo = new InMemoryInstallationRepo();
    const { proxy } = recordingProxy(
      () =>
        new Response(JSON.stringify({ error: "managed_link_unavailable" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await buildApp(repo, proxy).request("/github/managed/link");

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("managed_install=unavailable");
  });
});

describe("GET /github/installations/:id/detail", () => {
  it("forwards the GitHub-side installation id after checking ownership", async () => {
    const repo = new InMemoryInstallationRepo();
    const inst = await seedInstallation(repo);
    const { proxy, calls } = recordingProxy(
      () =>
        new Response(JSON.stringify({ permissions: { contents: "write" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const res = await buildApp(repo, proxy).request(`/github/installations/${inst.id}/detail`);

    expect(res.status).toBe(200);
    expect(calls[0].subpath).toBe("github/managed/installation-detail");
    // The numeric GitHub id, not our row id — the gateway calls
    // `GET /app/installations/<that>`.
    expect(calls[0].body).toMatchObject({ installationId: "555000" });
  });

  it("404s for another user's installation without forwarding", async () => {
    const repo = new InMemoryInstallationRepo();
    const inst = await seedInstallation(repo, "user-b");
    const { proxy, calls } = recordingProxy(() => new Response("{}", { status: 200 }));

    const res = await buildApp(repo, proxy).request(`/github/installations/${inst.id}/detail`);

    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

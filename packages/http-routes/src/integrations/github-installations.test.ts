// Route-level coverage for the tenant-scoped connected-accounts surface the
// Console GitHub integrations page renders: listing every installation a user
// has (multiple orgs are supported — one row per install) and disconnecting
// one of them.

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { InMemoryInstallationRepo } from "@duyet/oma-integrations-core/test-fakes";
import { buildIntegrationsRoutes, type IntegrationsBags } from "./index";

const USER = "user-a";
const OTHER_USER = "user-b";

function addInstallation(
  repo: InMemoryInstallationRepo,
  opts: { userId?: string; workspaceId: string; workspaceName: string },
) {
  return repo.insert({
    tenantId: "tenant-a",
    userId: opts.userId ?? USER,
    providerId: "github",
    workspaceId: opts.workspaceId,
    workspaceName: opts.workspaceName,
    installKind: "dedicated",
    appId: null,
    botUserId: "oma-app[bot]",
    accessToken: "ghs_seed",
    refreshToken: null,
    scopes: [],
  });
}

function buildApp(repo: InMemoryInstallationRepo) {
  const bags: IntegrationsBags = {
    linear: null,
    slack: null,
    github: { installations: repo, publications: {} as never },
  };
  const routes = buildIntegrationsRoutes({ bags: () => bags, installProxy: null });
  const wrapper = new Hono<{ Variables: { tenant_id: string; user_id?: string } }>();
  wrapper.use("*", async (c, next) => {
    c.set("tenant_id", "tenant-a");
    c.set("user_id", USER);
    await next();
  });
  wrapper.route("/", routes);
  return wrapper;
}

describe("GitHub connected accounts", () => {
  it("lists every account the user has connected", async () => {
    const repo = new InMemoryInstallationRepo();
    await addInstallation(repo, { workspaceId: "42", workspaceName: "acme" });
    await addInstallation(repo, { workspaceId: "77", workspaceName: "widgets-inc" });
    // Another user's install must never leak into this tenant's list.
    await addInstallation(repo, {
      userId: OTHER_USER,
      workspaceId: "99",
      workspaceName: "not-mine",
    });

    const res = await buildApp(repo).request("/github/installations");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data.map((i) => i.workspace_name).sort()).toEqual(["acme", "widgets-inc"]);
    // The numeric GitHub installation id is what the UI shows per account.
    expect(body.data.map((i) => i.workspace_id).sort()).toEqual(["42", "77"]);
  });

  it("disconnecting an account drops it from the list without touching the others", async () => {
    const repo = new InMemoryInstallationRepo();
    const gone = await addInstallation(repo, { workspaceId: "42", workspaceName: "acme" });
    await addInstallation(repo, { workspaceId: "77", workspaceName: "widgets-inc" });
    const app = buildApp(repo);

    const del = await app.request(`/github/installations/${gone.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(await del.json()).toMatchObject({ id: gone.id, status: "disconnected" });

    const res = await app.request("/github/installations");
    const body = (await res.json()) as { data: Array<Record<string, unknown>> };
    expect(body.data.map((i) => i.workspace_name)).toEqual(["widgets-inc"]);
  });

  it("404s when disconnecting an installation owned by another user", async () => {
    const repo = new InMemoryInstallationRepo();
    const theirs = await addInstallation(repo, {
      userId: OTHER_USER,
      workspaceId: "99",
      workspaceName: "not-mine",
    });

    const res = await buildApp(repo).request(`/github/installations/${theirs.id}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
    // Still live for its real owner.
    expect(await repo.listByUser(OTHER_USER, "github")).toHaveLength(1);
  });
});

// GitHubProvider.beginManagedInstallLink / completeManagedInstallLink — the
// reconcile ("link existing installation") flow.
//
// Fixes the production case where the App shows installed on github.com but
// the Console says nothing is connected: the install predates (or bypassed)
// the Setup URL round-trip, so no `github_installations` row was ever
// written. Instead of asking the user to uninstall + reinstall, we identify
// them with GitHub's user-authorization flow and link every installation of
// OUR App that THEY administer.
//
// Attribution is the whole point of the test file: linking must be driven by
// `GET /user/installations` under the user's own token, never the App JWT's
// `GET /app/installations` (which lists every tenant's installs).

import { describe, expect, it } from "vitest";
import { GitHubProvider } from "./provider";
import { buildFakeGitHubContainer } from "./test-fakes";
import type { GitHubConfig } from "./config";

const MANAGED_APP = {
  appId: "123456",
  appSlug: "oma-managed-bot",
  botLogin: "oma-managed-bot[bot]",
  privateKey: "",
  webhookSecret: "MANAGED_WEBHOOK_SECRET",
  clientId: "Iv1.managedclient",
  clientSecret: "managed-client-secret",
};

function baseConfig(managedApp: GitHubConfig["managedApp"]): GitHubConfig {
  return {
    gatewayOrigin: "https://gw.example.com",
    defaultCapabilities: ["issue.read"],
    mcpServerUrl: "https://api.githubcopilot.com/mcp/",
    managedApp,
  };
}

/** Generate a PKCS#8 RSA PEM (the format mintAppJwt's importKey expects). */
async function generatePkcs8Pem(): Promise<string> {
  const kp = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer;
  const bytes = new Uint8Array(pkcs8);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin);
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

const RETURN_URL = "https://console.example.com/integrations/github";

function jsonRes(body: unknown, status = 200) {
  return { status, headers: {}, body: JSON.stringify(body) };
}

/** `GET /user/installations` payload. `app_id` decides what's ours. */
function userInstallations(rows: Array<{ id: number; login: string; appId: number }>) {
  return jsonRes({
    total_count: rows.length,
    installations: rows.map((r) => ({
      id: r.id,
      app_id: r.appId,
      account: { id: 1, login: r.login, type: "Organization", avatar_url: null },
      repository_selection: "all",
      permissions: { contents: "write" },
      events: [],
      created_at: "2026-01-05T00:00:00Z",
    })),
  });
}

/** The per-installation pair the link flow makes for each NEW row: token
 *  mint, then `GET /app/installations/:id`. */
function recordInstallationPair(login: string) {
  return [
    jsonRes(
      {
        token: "ghs_installation_token",
        expires_at: "2026-01-01T00:00:00Z",
        permissions: { contents: "write" },
        repository_selection: "all",
      },
      201,
    ),
    jsonRes({
      id: 42,
      account: { id: 7, login, type: "Organization", avatar_url: null },
      repository_selection: "all",
      app_id: 123456,
      permissions: { contents: "write" },
      events: [],
      created_at: "2026-01-05T00:00:00Z",
    }),
  ];
}

async function providerWithKey(container: ReturnType<typeof buildFakeGitHubContainer>) {
  const managedApp = { ...MANAGED_APP, privateKey: await generatePkcs8Pem() };
  return new GitHubProvider(container, baseConfig(managedApp));
}

async function linkState(
  provider: GitHubProvider,
): Promise<string> {
  const { url } = await provider.beginManagedInstallLink({
    userId: "user_1",
    returnUrl: RETURN_URL,
  });
  return new URL(url).searchParams.get("state")!;
}

describe("GitHubProvider.beginManagedInstallLink", () => {
  it("returns GitHub's user-authorization URL with a link-kind state", async () => {
    const container = buildFakeGitHubContainer();
    const provider = await providerWithKey(container);

    const { url } = await provider.beginManagedInstallLink({
      userId: "user_1",
      returnUrl: RETURN_URL,
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://github.com/login/oauth/authorize");
    expect(parsed.searchParams.get("client_id")).toBe("Iv1.managedclient");
    // Must match the managed App's Callback URL on github.com.
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      "https://gw.example.com/github/managed/link/callback",
    );

    const decoded = await container.jwt.verify<{
      kind: string;
      userId: string;
      tenantId: string;
      returnUrl: string;
    }>(parsed.searchParams.get("state")!);
    expect(decoded.kind).toBe("github.link.workspace");
    expect(decoded.userId).toBe("user_1");
    expect(decoded.returnUrl).toBe(RETURN_URL);
    expect(decoded.tenantId).toBeTruthy();
  });

  it("refuses when the managed App has no OAuth credentials", async () => {
    const container = buildFakeGitHubContainer();
    // Managed App configured, but no client id/secret — the install-token
    // flow alone can't identify a human, so linking is impossible.
    const provider = new GitHubProvider(
      container,
      baseConfig({
        ...MANAGED_APP,
        privateKey: await generatePkcs8Pem(),
        clientId: null,
        clientSecret: null,
      }),
    );

    await expect(
      provider.beginManagedInstallLink({ userId: "user_1", returnUrl: RETURN_URL }),
    ).rejects.toThrow(/GITHUB_MANAGED_CLIENT_ID/);
  });
});

describe("GitHubProvider.completeManagedInstallLink", () => {
  // The App can be configured with "Request user authorization (OAuth) during
  // installation", in which case GitHub sends the install to the OAuth
  // Callback URL — this route — instead of the Setup URL, and carries
  // `installation_id` + the connect flow's own state. Without this the
  // install completes on github.com and is never recorded.
  it("records an install redirected here with installation_id and no code", async () => {
    const container = buildFakeGitHubContainer();
    const provider = await providerWithKey(container);
    const { url } = await provider.beginManagedWorkspaceInstall({
      userId: "user_1",
      returnUrl: RETURN_URL,
    });
    const state = new URL(url).searchParams.get("state")!;

    // Only the record pair — no user-token exchange, no /user/installations.
    container.http.respondWith(...recordInstallationPair("acme"));

    const result = await provider.completeManagedInstallLink({
      state,
      installationId: "555000",
    });

    expect(result.linked).toBe(1);
    expect(result.logins).toEqual(["acme"]);
    expect(result.returnUrl).toBe(RETURN_URL);
    const installs = await container.installations.listByUser("user_1", "github");
    expect(installs.map((i) => i.workspaceId)).toEqual(["555000"]);
  });

  it("counts an installation_id already recorded as existing", async () => {
    const container = buildFakeGitHubContainer();
    const provider = await providerWithKey(container);
    const { url } = await provider.beginManagedWorkspaceInstall({
      userId: "user_1",
      returnUrl: RETURN_URL,
    });
    const state = new URL(url).searchParams.get("state")!;

    container.http.respondWith(...recordInstallationPair("acme"));
    await provider.completeManagedInstallLink({ state, installationId: "555000" });

    // No responses queued: a second record attempt would throw.
    const again = await provider.completeManagedInstallLink({
      state,
      installationId: "555000",
    });
    expect(again.linked).toBe(0);
    expect(again.existing).toBe(1);
    expect(container.vaults.created.length).toBe(1);
  });

  it("links the user's un-recorded installation of our App", async () => {
    const container = buildFakeGitHubContainer();
    const provider = await providerWithKey(container);
    const state = await linkState(provider);

    container.http.respondWith(
      jsonRes({ access_token: "ghu_user_token" }),
      userInstallations([{ id: 555000, login: "acme", appId: 123456 }]),
      ...recordInstallationPair("acme"),
    );

    const result = await provider.completeManagedInstallLink({ code: "abc", state });

    expect(result.linked).toBe(1);
    expect(result.existing).toBe(0);
    expect(result.logins).toEqual(["acme"]);
    expect(result.returnUrl).toBe(RETURN_URL);

    // Same row shape the Setup-URL callback writes: appId=null, vault wired.
    const installs = await container.installations.listByUser("user_1", "github");
    expect(installs.length).toBe(1);
    expect(installs[0].workspaceId).toBe("555000");
    expect(installs[0].workspaceName).toBe("acme");
    expect(installs[0].appId).toBeNull();
    expect(installs[0].vaultId).toBeTruthy();
    expect(container.vaults.created.length).toBe(1);
    expect(container.vaults.capCli[0].cliId).toBe("gh");
  });

  it("ignores installations of OTHER GitHub Apps the user can see", async () => {
    const container = buildFakeGitHubContainer();
    const provider = await providerWithKey(container);
    const state = await linkState(provider);

    container.http.respondWith(
      jsonRes({ access_token: "ghu_user_token" }),
      // Only the first row is our App (app_id 123456).
      userInstallations([
        { id: 555000, login: "acme", appId: 123456 },
        { id: 999111, login: "other-org", appId: 987654 },
      ]),
      ...recordInstallationPair("acme"),
    );

    const result = await provider.completeManagedInstallLink({ code: "abc", state });

    expect(result.linked).toBe(1);
    const installs = await container.installations.listByUser("user_1", "github");
    expect(installs.map((i) => i.workspaceId)).toEqual(["555000"]);
  });

  it("counts an already-recorded installation as existing, minting no second vault", async () => {
    const container = buildFakeGitHubContainer();
    const provider = await providerWithKey(container);
    const state = await linkState(provider);

    container.http.respondWith(
      jsonRes({ access_token: "ghu_user_token" }),
      userInstallations([{ id: 555000, login: "acme", appId: 123456 }]),
      ...recordInstallationPair("acme"),
    );
    await provider.completeManagedInstallLink({ code: "abc", state });

    // Second sync: only the token exchange + listing are queued — hitting the
    // record path again would run out of responses and throw.
    container.http.respondWith(
      jsonRes({ access_token: "ghu_user_token" }),
      userInstallations([{ id: 555000, login: "acme", appId: 123456 }]),
    );
    const second = await provider.completeManagedInstallLink({ code: "abc", state });

    expect(second.linked).toBe(0);
    expect(second.existing).toBe(1);
    const installs = await container.installations.listByUser("user_1", "github");
    expect(installs.length).toBe(1);
    expect(container.vaults.created.length).toBe(1);
  });

  // `github.install.workspace` IS accepted here (GitHub can route a Connect
  // install to the OAuth Callback URL) — any other kind is not.
  it("rejects a wrong-kind state", async () => {
    const container = buildFakeGitHubContainer();
    const provider = await providerWithKey(container);
    const wrongState = await container.jwt.sign(
      { kind: "github.install.pub", userId: "user_1", returnUrl: RETURN_URL },
      3600,
    );

    await expect(
      provider.completeManagedInstallLink({ code: "abc", state: wrongState }),
    ).rejects.toThrow(/invalid state kind/i);
  });

  it("surfaces GitHub's OAuth error body rather than writing a partial row", async () => {
    const container = buildFakeGitHubContainer();
    const provider = await providerWithKey(container);
    const state = await linkState(provider);

    // GitHub 200s on a bad code with an error body.
    container.http.respondWith(
      jsonRes({ error: "bad_verification_code", error_description: "expired" }),
    );

    await expect(
      provider.completeManagedInstallLink({ code: "stale", state }),
    ).rejects.toThrow(/bad_verification_code/);
    expect(await container.installations.listByUser("user_1", "github")).toHaveLength(0);
  });
});

describe("GitHubProvider.getManagedInstallationDetail", () => {
  it("returns permissions, repo selection, install date and repo names", async () => {
    const container = buildFakeGitHubContainer();
    const provider = await providerWithKey(container);

    container.http.respondWith(
      // GET /app/installations/:id
      jsonRes({
        id: 555000,
        account: { id: 7, login: "acme", type: "Organization", avatar_url: null },
        repository_selection: "selected",
        app_id: 123456,
        permissions: { contents: "write", issues: "read" },
        events: [],
        created_at: "2026-01-05T00:00:00Z",
        html_url: "https://github.com/organizations/acme/settings/installations/555000",
      }),
      // installation token mint
      jsonRes(
        {
          token: "ghs_installation_token",
          expires_at: "2026-01-01T00:00:00Z",
          permissions: {},
          repository_selection: "selected",
        },
        201,
      ),
      // GET /installation/repositories
      jsonRes({
        total_count: 2,
        repositories: [
          { owner: { login: "acme" }, name: "widgets" },
          { owner: { login: "acme" }, name: "docs" },
        ],
      }),
    );

    const detail = await provider.getManagedInstallationDetail({ installationId: "555000" });

    expect(detail.permissions).toEqual({ contents: "write", issues: "read" });
    expect(detail.repositorySelection).toBe("selected");
    expect(detail.installedAt).toBe("2026-01-05T00:00:00Z");
    expect(detail.repoCount).toBe(2);
    expect(detail.repos).toEqual(["acme/widgets", "acme/docs"]);
  });

  it("still returns the grant when the repo listing fails", async () => {
    const container = buildFakeGitHubContainer();
    const provider = await providerWithKey(container);

    container.http.respondWith(
      jsonRes({
        id: 555000,
        account: { id: 7, login: "acme", type: "Organization", avatar_url: null },
        repository_selection: "all",
        app_id: 123456,
        permissions: { contents: "write" },
        events: [],
        created_at: null,
      }),
      // Token mint fails — the card must still render the permissions half.
      jsonRes({ message: "Bad credentials" }, 401),
    );

    const detail = await provider.getManagedInstallationDetail({ installationId: "555000" });

    expect(detail.repositorySelection).toBe("all");
    expect(detail.repos).toEqual([]);
    expect(detail.repoCount).toBe(0);
  });
});

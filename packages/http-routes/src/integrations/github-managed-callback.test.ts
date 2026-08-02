// Route-level coverage for the managed GitHub App's ONE Setup URL
// (`GET /github/managed/callback`).
//
// A managed App has exactly one Setup URL on github.com regardless of how
// many OMA flows use it, so BOTH managed installs land here and the route
// dispatches on the state JWT's `kind`:
//
//   github.install.workspace — "Connect" (no agent bound)
//   github.install.pub       — "Bind an agent" via the managed App
//
// Before the dispatch existed, an agent-bind managed install always failed
// here with "invalid state kind" and bounced the user to
// `?managed_install=error` with the publication stuck in `awaiting_install`.
//
// Also covers the stranded-user case: GitHub hits this URL with NO state at
// all (install started from the App's own github.com page, or a
// `setup_on_update` permission-change redirect). The fallback path must be
// absolutized against the Console origin — the gateway runs on its own
// origin and serves no Console, so a bare relative path 404s the user
// instead of returning them to OMA.

import { describe, it, expect } from "vitest";
import type {
  ContinueInstallArgs,
  ContinueInstallResult,
  InstallBridge,
  JwtSigner,
} from "@duyet/oma-integrations-core";
import { buildIntegrationsGatewayRoutes } from "./gateway";

const CONSOLE_ORIGIN = "https://console.example.com";
const RETURN_URL = `${CONSOLE_ORIGIN}/integrations/github`;

/** Round-trips a JSON payload through base64 so tests can mint a "state"
 *  without real crypto. `verify` rejects anything it can't decode, matching
 *  the real signer's contract closely enough for routing. */
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

interface BridgeStub {
  bridge: InstallBridge;
  calls: ContinueInstallArgs[];
}

function stubBridge(
  respond: (args: ContinueInstallArgs) => Promise<ContinueInstallResult>,
): BridgeStub {
  const calls: ContinueInstallArgs[] = [];
  const bridge = {
    async continueInstall(args: ContinueInstallArgs) {
      calls.push(args);
      // `return await` (not a bare `return`) so the rejection chains onto
      // this promise instead of surfacing as an unhandled rejection under
      // the workers pool.
      return await respond(args);
    },
  } as unknown as InstallBridge;
  return { bridge, calls };
}

function buildGateway(bridge: InstallBridge, consoleOrigin: string | null = CONSOLE_ORIGIN) {
  return buildIntegrationsGatewayRoutes({
    installBridge: bridge,
    jwt: fakeJwt,
    webhooks: {},
    internalSecret: null,
    consoleOrigin,
  });
}

describe("GET /github/managed/callback", () => {
  it("completes an agent-bind install (state kind github.install.pub) and returns to the wizard", async () => {
    const { bridge, calls } = stubBridge(async () => ({
      publicationId: "pub_123",
      returnUrl: RETURN_URL,
    }));
    const state = stateFor({
      kind: "github.install.pub",
      publicationId: "pub_123",
      appOmaId: "gha_1",
      userId: "user-a",
      returnUrl: RETURN_URL,
    });

    const res = await buildGateway(bridge).request(
      `/github/managed/callback?installation_id=99&setup_action=install&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(RETURN_URL);
    expect(location.searchParams.get("install")).toBe("ok");
    expect(location.searchParams.get("publication_id")).toBe("pub_123");
    // Must run the publication-first completion, NOT the workspace one —
    // otherwise the publication never leaves `awaiting_install`.
    expect(calls).toHaveLength(1);
    expect(calls[0].providerInstallationId).toBe("pub_123");
    expect(calls[0].extra).toMatchObject({
      installationId: "99",
      setupAction: "install",
      publicationFirst: true,
    });
    expect(calls[0].extra?.workspaceManaged).toBeUndefined();
  });

  it("completes a workspace connect (state kind github.install.workspace)", async () => {
    const { bridge, calls } = stubBridge(async () => ({
      publicationId: "",
      returnUrl: RETURN_URL,
      login: "acme",
    }));
    const state = stateFor({
      kind: "github.install.workspace",
      userId: "user-a",
      tenantId: "tenant-a",
      returnUrl: RETURN_URL,
    });

    const res = await buildGateway(bridge).request(
      `/github/managed/callback?installation_id=99&setup_action=install&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("managed_install")).toBe("ok");
    // Public success contract the Console reads: /integrations/github?connected=1
    expect(location.searchParams.get("connected")).toBe("1");
    expect(location.searchParams.get("login")).toBe("acme");
    expect(calls[0].extra).toMatchObject({ workspaceManaged: true });
  });

  it("redirects a failed workspace connect back to the console origin when no returnUrl was supplied", async () => {
    const { bridge, calls } = stubBridge(async () => {
      throw new Error("installation token: HTTP 404");
    });
    const state = stateFor({
      kind: "github.install.workspace",
      userId: "user-a",
      tenantId: "tenant-a",
      returnUrl: null,
    });

    const res = await buildGateway(bridge).request(
      `/github/managed/callback?installation_id=99&setup_action=install&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${CONSOLE_ORIGIN}/integrations/github?managed_install=error`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].extra).toMatchObject({ workspaceManaged: true });
  });

  it("redirects a failed agent-bind install back to the console, not a raw error", async () => {
    const { bridge } = stubBridge(async () => {
      throw new Error("installation token: HTTP 404");
    });
    const state = stateFor({
      kind: "github.install.pub",
      publicationId: "pub_123",
      returnUrl: RETURN_URL,
    });

    const res = await buildGateway(bridge).request(
      `/github/managed/callback?installation_id=99&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${RETURN_URL}?managed_install=error`);
  });

  it("sends a stateless install (GitHub App page / setup_on_update) back to the Console origin as unlinked", async () => {
    const { bridge, calls } = stubBridge(async () => ({
      publicationId: "",
      returnUrl: null,
    }));

    const res = await buildGateway(bridge).request(
      "/github/managed/callback?installation_id=99&setup_action=install",
    );

    expect(res.status).toBe(302);
    // Must be absolute and on the Console — a bare "/integrations/github"
    // resolves against the gateway origin, which serves no Console (404).
    // The App IS installed on GitHub — we just can't attribute it to a user
    // without state, so it's `unlinked`, not a generic failure.
    expect(res.headers.get("location")).toBe(
      `${CONSOLE_ORIGIN}/integrations/github?managed_install=unlinked`,
    );
    expect(calls).toHaveLength(0);
  });

  it("falls back to a relative console path when no consoleOrigin is configured", async () => {
    const { bridge } = stubBridge(async () => ({ publicationId: "", returnUrl: null }));

    const res = await buildGateway(bridge, null).request(
      "/github/managed/callback?installation_id=99",
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/integrations/github?managed_install=unlinked");
  });

  it("never routes an unverifiable state into the publication branch", async () => {
    // The route reads `kind` / `publicationId` off the state only after
    // `jwt.verify` accepts it. A forged state that merely *looks* like a
    // publication install must not be able to pick a publication id — the
    // request falls through to the workspace branch, where the provider
    // re-verifies the signature and rejects it.
    const { bridge, calls } = stubBridge(async () => {
      throw new Error("invalid state kind");
    });
    const forged = "not-a-signed-jwt";

    const res = await buildGateway(bridge).request(
      `/github/managed/callback?installation_id=99&state=${encodeURIComponent(forged)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(
      `${CONSOLE_ORIGIN}/integrations/github?managed_install=error`,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].providerInstallationId).toBeUndefined();
    expect(calls[0].extra).toMatchObject({ workspaceManaged: true });
  });

  it("shows the pending page when the org owner has to approve the install", async () => {
    const { bridge, calls } = stubBridge(async () => ({ publicationId: "", returnUrl: null }));

    const res = await buildGateway(bridge).request(
      "/github/managed/callback?installation_id=99&setup_action=request&state=x",
    );

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Install requested");
    expect(calls).toHaveLength(0);
  });

  it("redirects to the console when the user denies the install", async () => {
    const { bridge, calls } = stubBridge(async () => ({ publicationId: "", returnUrl: null }));
    const state = stateFor({ kind: "github.install.workspace", returnUrl: RETURN_URL });

    const res = await buildGateway(bridge).request(
      `/github/managed/callback?error=access_denied&state=${encodeURIComponent(state)}`,
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${RETURN_URL}?managed_install=error`);
    expect(calls).toHaveLength(0);
  });
});

describe("GET /github/oauth/pub/:pubId/callback", () => {
  it("absolutizes the console fallback when the state carried no returnUrl", async () => {
    const { bridge } = stubBridge(async () => ({
      publicationId: "pub_123",
      returnUrl: null,
    }));

    const res = await buildGateway(bridge).request(
      "/github/oauth/pub/pub_123/callback?installation_id=99&state=abc",
    );

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe(CONSOLE_ORIGIN);
    expect(location.pathname).toBe("/integrations/github");
    expect(location.searchParams.get("install")).toBe("ok");
    expect(location.searchParams.get("publication_id")).toBe("pub_123");
  });

  it("passes the capability probe through to the console redirect", async () => {
    const { bridge } = stubBridge(async () => ({
      publicationId: "pub_123",
      returnUrl: RETURN_URL,
      capabilityProbe: { kind: "mcp", ok: false, message: "toggle off", fixUrl: "https://x/fix" },
    }));

    const res = await buildGateway(bridge).request(
      "/github/oauth/pub/pub_123/callback?installation_id=99&state=abc",
    );

    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("probe_kind")).toBe("mcp");
    expect(location.searchParams.get("probe_ok")).toBe("0");
    expect(location.searchParams.get("probe_message")).toBe("toggle off");
    expect(location.searchParams.get("probe_fix_url")).toBe("https://x/fix");
  });
});

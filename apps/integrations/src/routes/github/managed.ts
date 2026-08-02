import { Hono } from "hono";
import type { Env } from "../../env";
import { buildProviders } from "../../providers";

// GitHub managed workspace connect — the "Connect" one-click flow that
// installs this deployment's managed GitHub App onto a user's org/account
// WITHOUT binding an agent first (no publication). Internal-secret gated:
// apps/main forwards the authenticated GET /v1/integrations/github/managed/
// connect here with x-internal-secret + the resolved userId.
//
//   POST /github/managed/connect  { userId, returnUrl } → { url }
//
// The install callback GitHub redirects to afterwards
// (`GET /github/managed/callback`) is served by the shared gateway package
// (buildIntegrationsGatewayRoutes) — see the CfInstallBridge workspace branch.

const app = new Hono<{ Bindings: Env }>();

function requireInternalSecret(env: Env, headerValue: string | undefined): boolean {
  return Boolean(
    env.INTEGRATIONS_INTERNAL_SECRET &&
      headerValue === env.INTEGRATIONS_INTERNAL_SECRET,
  );
}

interface ConnectBody {
  userId: string;
  returnUrl: string;
}

app.post("/connect", async (c) => {
  if (!requireInternalSecret(c.env, c.req.header("x-internal-secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json<ConnectBody>();
  if (!body.userId || !body.returnUrl) {
    return c.json({ error: "userId, returnUrl required" }, 400);
  }

  const { github } = buildProviders(c.env);

  try {
    const result = await github.beginManagedWorkspaceInstall({
      userId: body.userId,
      returnUrl: body.returnUrl,
    });
    return c.json({ url: result.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        error: "managed_install_unavailable",
        details: msg,
        remediation: "Configure the managed GitHub App secrets on this deployment.",
      },
      503,
    );
  }
});

// POST /github/managed/link  { userId, returnUrl } → { url }
// Reconcile flow: hands back GitHub's user-authorization URL. The callback
// (`GET /github/managed/link/callback`) is served by the shared gateway
// package, same as the install callback.
app.post("/link", async (c) => {
  if (!requireInternalSecret(c.env, c.req.header("x-internal-secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json<ConnectBody>();
  if (!body.userId || !body.returnUrl) {
    return c.json({ error: "userId, returnUrl required" }, 400);
  }

  const { github } = buildProviders(c.env);
  try {
    const result = await github.beginManagedInstallLink({
      userId: body.userId,
      returnUrl: body.returnUrl,
    });
    return c.json({ url: result.url });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json(
      {
        error: "managed_link_unavailable",
        details: msg,
        remediation:
          "Configure GITHUB_MANAGED_CLIENT_ID / GITHUB_MANAGED_CLIENT_SECRET on this deployment.",
      },
      503,
    );
  }
});

// POST /github/managed/installation-detail  { installationId } → live detail
// Live read-through to GitHub for one installation (permissions, repo
// selection, install date, repo names). Ownership was already checked by the
// public route in packages/http-routes before forwarding here.
app.post("/installation-detail", async (c) => {
  if (!requireInternalSecret(c.env, c.req.header("x-internal-secret"))) {
    return c.json({ error: "unauthorized" }, 401);
  }
  const body = await c.req.json<{ installationId?: string }>();
  if (!body.installationId) {
    return c.json({ error: "installationId required" }, 400);
  }

  const { github } = buildProviders(c.env);
  try {
    const detail = await github.getManagedInstallationDetail({
      installationId: body.installationId,
    });
    return c.json(detail);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return c.json({ error: "installation_detail_unavailable", details: msg }, 502);
  }
});

export default app;

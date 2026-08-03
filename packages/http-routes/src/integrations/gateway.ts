// Integrations gateway routes — OAuth callbacks, setup pages, Linear MCP,
// GitHub internal refresh, and the webhook receivers.
//
// The thin route bodies fan out to:
//   - InstallBridge.continueInstall (provider-routed; lookup of vault +
//     session binding is the bridge's job)
//   - InstallBridge.lookupLinearCredentialForSession (Linear MCP)
//   - InstallBridge.refreshGithubVault (GitHub internal endpoint)
//   - WebhookHandlers (per-provider, returns the same WebhookOutcome the
//     CF route consumed) — kept as a callback so the package doesn't
//     import @duyet/oma-{linear,github,slack}.
//
// This file mirrors apps/integrations/src/routes/* one-for-one, with the
// CF-specific bits (executionCtx.waitUntil, env binding access) replaced by
// runtime-agnostic deps. CF wires them through service binding RPC; Node
// wires them through in-process services.
//
// Setup-page HTML is verbatim from the CF impl — re-rendered to match the
// existing console links a user might already have shared.

import { Hono } from "hono";
import type {
  InstallBridge,
  WebhookOutcome,
  WebhookRequest,
  JwtSigner,
} from "@duyet/oma-integrations-core";
import { getLogger } from "@duyet/oma-observability";
import { checkInternalSecret } from "../internal-auth";

const log = getLogger("http-routes.integrations.gateway");

/** Per-provider webhook handler closure. The host wires this to
 *  `provider.handleWebhook(req)` — keeps `@duyet/oma-{linear,
 *  github,slack}` out of the http-routes deps. */
export type WebhookHandler = (req: WebhookRequest) => Promise<WebhookOutcome>;

export interface WebhookHandlers {
  linear?: WebhookHandler | null;
  github?: WebhookHandler | null;
  slack?: WebhookHandler | null;
  /** Handler for the ONE shared managed GitHub App's webhook URL
   *  (`POST /github/webhook/managed`) — wired to
   *  `GitHubProvider.handleManagedWebhook`, distinct from `github` (which
   *  wires `handleWebhook`, the per-App-id BYOA route). Null/undefined
   *  when no managed App is configured skips mounting the route. */
  githubManaged?: WebhookHandler | null;
}

/** Per-tenant rate-limit hook (CF wires the binding; Node soft-passes). */
export interface RateLimitHooks {
  shouldDropForTenant?(tenantId: string): Promise<boolean>;
}

export interface IntegrationsGatewayDeps {
  installBridge: InstallBridge;
  /** JwtSigner backing setup-page form-token verification + the OAuth state
   *  JWT. CF + Node both pass their WebCryptoJwtSigner here. */
  jwt: JwtSigner;
  /** Per-provider webhook closures. A null/undefined provider entry skips
   *  the webhook route mount. */
  webhooks: WebhookHandlers;
  /** Internal-secret required by /github/internal/* (the refresh-by-vault
   *  endpoint). Same secret CF used for the `INTEGRATIONS_INTERNAL_SECRET`
   *  service-binding gate. */
  internalSecret: string | null;
  /** Public origin of the Console (e.g. `https://app.example.com`). Used to
   *  absolutize a relative return path when an install callback has no
   *  usable `returnUrl` — the gateway runs on its OWN origin
   *  (`integrations.<domain>`), which serves no Console, so a bare
   *  `/integrations/github` redirect would strand the user on a 404 instead
   *  of taking them back to OMA. Optional: when unset the relative path is
   *  emitted unchanged (previous behavior). */
  consoleOrigin?: string | null;
  /** Optional rate-limit hooks. Soft-pass when absent. */
  rateLimit?: RateLimitHooks;
}

export function buildIntegrationsGatewayRoutes(deps: IntegrationsGatewayDeps) {
  const app = new Hono();

  // ─── Linear ──────────────────────────────────────────────────────────
  // GET /linear/oauth/pub/:pubId/callback?code=&state=
  //
  // Publication-first OAuth callback. The pub_id in the URL was minted at
  // publication-create time and baked into the user's Linear OAuth-app
  // config; the InstallBridge resolves it to the publication row and
  // completes the install (or rotates tokens for the reauth state-kind).
  app.get("/linear/oauth/pub/:pubId/callback", async (c) => {
    const pubId = c.req.param("pubId");
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) return c.json({ error: "linear_oauth_denied", details: error }, 400);
    if (!pubId || !code || !state) {
      return c.json({ error: "missing pubId, code, or state" }, 400);
    }
    try {
      const result = await deps.installBridge.continueInstall({
        provider: "linear",
        providerInstallationId: pubId,
        code,
        state,
      });
      if (!result.returnUrl) {
        return c.json({ ok: true, publicationId: result.publicationId, flow: "complete" });
      }
      const target = new URL(result.returnUrl);
      target.searchParams.set("publication_id", result.publicationId);
      target.searchParams.set("install", "ok");
      return c.redirect(target.toString(), 302);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ op: "linear.oauth.callback.failed", pubId, err: msg }, "linear callback failed");
      return c.json({ error: "install_failed", details: msg }, 500);
    }
  });

  // Legacy `/linear-setup/<token>` handoff page is gone with the
  // publication-first refactor — admins receive a `/linear/oauth/pub/...`
  // callback URL directly via the new wizard flow rather than a
  // form-token-backed splash page.

  // ─── GitHub ──────────────────────────────────────────────────────────
  // GET /github/oauth/pub/:pubId/callback?installation_id=&setup_action=&state=
  // Publication-first install callback. The setup URL on the GitHub App is
  // keyed on the publication id (not the legacy app_oma_id), so retries
  // route to the same publication row regardless of the user re-creating
  // an App. Same `installation_id` + `state` query semantics as the legacy
  // path; provider's continueInstall switches on payload.kind.
  app.get("/github/oauth/pub/:pubId/callback", async (c) => {
    const pubId = c.req.param("pubId");
    const url = new URL(c.req.url);
    const installationId = url.searchParams.get("installation_id");
    const setupAction = url.searchParams.get("setup_action");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) return c.json({ error: "github_install_denied", details: error }, 400);
    if (!pubId || !installationId || !state) {
      return c.json({ error: "missing pubId, installation_id, or state" }, 400);
    }
    if (setupAction === "request") {
      // Org admin requested the install but it's pending approval — show
      // a pending page rather than 500-ing on missing installation token.
      return c.html(githubRequestPendingPage(setupAction), 200);
    }
    try {
      const result = await deps.installBridge.continueInstall({
        provider: "github",
        providerInstallationId: pubId,
        state,
        extra: { installationId, setupAction, publicationFirst: true },
      });
      return redirectPublicationInstall(c, {
        returnUrl: result.returnUrl,
        publicationId: result.publicationId,
        probe: result.capabilityProbe,
        consoleOrigin: deps.consoleOrigin,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ op: "github.oauth.pub.callback.failed", pubId, err: msg }, "github callback failed");
      return c.json({ error: "install_failed", details: msg }, 500);
    }
  });

  // GET /github/managed/callback?installation_id=&setup_action=&state=
  // The ONE fixed Setup URL configured on the shared managed GitHub App
  // (github.com → the App's "Setup URL"); GitHub hits it after the user
  // installs the App on an org. A managed App has exactly one Setup URL no
  // matter how many flows use it, so BOTH managed install flows land here
  // and we dispatch on the state JWT's `kind`:
  //
  //   github.install.workspace — "Connect" (no agent bound). The bridge
  //     records only a github_installations row + credential vault; we send
  //     the browser back to the state's returnUrl with `?managed_install=ok`
  //     (+ `&login=<org login>` when known).
  //   github.install.pub — "Bind an agent" via the managed App. Identical
  //     completion to the dedicated `/github/oauth/pub/:pubId/callback`
  //     route; the publication id isn't in the path here so we read it off
  //     the state. Redirects with `?install=ok&publication_id=…`, which is
  //     what the Console wizard listens for.
  //
  // Before this dispatch a managed agent-bind install always failed here
  // with "invalid state kind" and bounced the user to
  // `?managed_install=error`, leaving the publication stuck in
  // `awaiting_install`.
  app.get("/github/managed/callback", async (c) => {
    const url = new URL(c.req.url);
    const installationId = url.searchParams.get("installation_id");
    const setupAction = url.searchParams.get("setup_action");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    // Best-effort decode: the state carries both the flow kind and the
    // returnUrl, so error/denied paths can still land the user back on the
    // console. GitHub also hits this URL with NO state at all — installs
    // started from the App's own github.com page, and `setup_on_update`
    // permission-change redirects — in which case we fall back to the
    // console's GitHub integrations page.
    let decoded: { kind?: string; returnUrl?: string; publicationId?: string } | null = null;
    if (state) {
      try {
        decoded = await deps.jwt.verify<{
          kind?: string;
          returnUrl?: string;
          publicationId?: string;
        }>(state);
      } catch {
        decoded = null;
      }
    }
    const returnUrl = decoded?.returnUrl ?? null;
    const consoleOrigin = deps.consoleOrigin;

    if (error) return redirectManagedInstall(c, returnUrl, "error", null, consoleOrigin);
    if (setupAction === "request") {
      // Org admin requested the install but it's pending approval.
      return c.html(githubRequestPendingPage(setupAction), 200);
    }
    if (installationId && !state) {
      // The App really is installed on GitHub, we just can't attribute it to
      // an OMA user: no state means the install was started from the App's
      // own github.com page (or is a `setup_on_update` permission-change
      // redirect). Land the user on the Console with a distinct status so
      // the page can tell them to re-run Connect rather than showing a
      // generic failure.
      return redirectManagedInstall(c, returnUrl, "unlinked", null, consoleOrigin);
    }
    if (!installationId || !state) {
      return redirectManagedInstall(c, returnUrl, "error", null, consoleOrigin);
    }

    if (decoded?.kind === "github.install.pub") {
      if (!decoded.publicationId) {
        log.warn(
          { op: "github.managed.callback.failed", err: "state missing publicationId" },
          "github managed publication callback failed",
        );
        return redirectManagedInstall(c, returnUrl, "error", null, consoleOrigin);
      }
      try {
        const result = await deps.installBridge.continueInstall({
          provider: "github",
          providerInstallationId: decoded.publicationId,
          state,
          extra: { installationId, setupAction, publicationFirst: true },
        });
        return redirectPublicationInstall(c, {
          returnUrl: result.returnUrl ?? returnUrl,
          publicationId: result.publicationId,
          probe: result.capabilityProbe,
          consoleOrigin,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          { op: "github.managed.callback.failed", pubId: decoded.publicationId, err: msg },
          "github managed publication callback failed",
        );
        return redirectManagedInstall(c, returnUrl, "error", null, consoleOrigin);
      }
    }

    try {
      const result = await deps.installBridge.continueInstall({
        provider: "github",
        state,
        extra: { installationId, setupAction, workspaceManaged: true },
      });
      return redirectManagedInstall(
        c,
        result.returnUrl ?? returnUrl,
        "ok",
        result.login ?? null,
        consoleOrigin,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        { op: "github.managed.callback.failed", err: msg },
        "github managed workspace callback failed",
      );
      return redirectManagedInstall(c, returnUrl, "error", null, consoleOrigin);
    }
  });

  // GET /github/managed/link/callback?code=&state=
  // Reconcile callback — the managed App's OAuth "Callback URL" on
  // github.com. Unlike the Setup URL above there is no `installation_id`
  // here: the `code` identifies the *user*, and the bridge exchanges it for
  // a user token to enumerate the installations that user administers,
  // writing a `github_installations` row for each of ours that has none.
  // Redirects back with `?managed_install=linked&linked=<n>` (or `ok` when
  // everything was already recorded).
  app.get("/github/managed/link/callback", async (c) => {
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    // Present when the App has "Request user authorization (OAuth) during
    // installation" enabled: GitHub sends the *install* here (Callback URL)
    // rather than to the Setup URL. Recording it directly is what makes an
    // install stick on deployments whose App has no Setup URL configured.
    const installationId = url.searchParams.get("installation_id");
    const consoleOrigin = deps.consoleOrigin;

    let returnUrl: string | null = null;
    if (state) {
      try {
        const decoded = await deps.jwt.verify<{ returnUrl?: string }>(state);
        returnUrl = decoded.returnUrl ?? null;
      } catch {
        returnUrl = null;
      }
    }
    if (error || !state || (!code && !installationId)) {
      return redirectManagedInstall(c, returnUrl, "error", null, consoleOrigin);
    }

    try {
      const result = await deps.installBridge.continueInstall({
        provider: "github",
        code: code ?? undefined,
        state,
        extra: { linkExisting: true, installationId },
      });
      const linked = result.linked ?? 0;
      return redirectToConsole(
        c,
        result.returnUrl && result.returnUrl.trim() ? result.returnUrl : returnUrl ?? CONSOLE_GITHUB_PATH,
        consoleOrigin,
        {
          managed_install: linked > 0 ? "linked" : "ok",
          connected: "1",
          linked: String(linked),
          ...(result.login ? { login: result.login } : {}),
        },
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        { op: "github.managed.link.failed", err: msg },
        "github managed install link failed",
      );
      return redirectManagedInstall(c, returnUrl, "error", null, consoleOrigin);
    }
  });

  // GET /github/install/app/:appOmaId/callback?installation_id=&setup_action=&state=
  // Legacy install callback — kept for installations created before
  // migration 0002. Same semantics, just keyed on app_oma_id rather than
  // pub_id. Once all live publications are publication-first this can go.
  app.get("/github/install/app/:appOmaId/callback", async (c) => {
    const appOmaId = c.req.param("appOmaId");
    const url = new URL(c.req.url);
    const installationId = url.searchParams.get("installation_id");
    const setupAction = url.searchParams.get("setup_action");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) return c.json({ error: "github_install_denied", details: error }, 400);
    if (!appOmaId || !installationId || !state) {
      return c.json({ error: "missing appOmaId, installation_id, or state" }, 400);
    }
    if (setupAction === "request") {
      return c.html(githubRequestPendingPage(setupAction), 200);
    }
    try {
      const result = await deps.installBridge.continueInstall({
        provider: "github",
        providerInstallationId: appOmaId,
        state,
        extra: { installationId, setupAction },
      });
      // Surface the vendor capability probe (e.g. Slack MCP toggle) as
      // query params so the wizard's success page can show the right
      // green-check or warning-with-deeplink banner.
      return redirectPublicationInstall(c, {
        returnUrl: result.returnUrl,
        publicationId: result.publicationId,
        probe: result.capabilityProbe,
        consoleOrigin: deps.consoleOrigin,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ op: "github.install.callback.failed", appOmaId, err: msg }, "github callback failed");
      return c.json({ error: "install_failed", details: msg }, 500);
    }
  });

  // GET /github/manifest/callback?code=&state=
  app.get("/github/manifest/callback", async (c) => {
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code || !state) {
      return c.html(errorPage("missing code or state in GitHub redirect"), 400);
    }
    try {
      const result = await deps.installBridge.continueInstall({
        provider: "github",
        code,
        state,
        extra: { manifest: true },
      });
      if (!result.returnUrl) {
        return c.html(githubAutoRedirectPage({ installUrl: "/", returnUrl: "" }));
      }
      const target = new URL(result.returnUrl);
      target.searchParams.set("publication_id", result.publicationId);
      return c.redirect(target.toString(), 302);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return c.html(errorPage(`manifest exchange failed: ${msg}`), 500);
    }
  });

  // GET /github-setup/:token
  app.get("/github-setup/:token", async (c) => {
    const token = c.req.param("token");
    let form: { persona: { name: string }; userId: string; agentId: string; appOmaId: string };
    try {
      form = await deps.jwt.verify<typeof form>(token);
    } catch (err) {
      return c.html(errorPage(err instanceof Error ? err.message : String(err)), 400);
    }
    return c.html(githubLandingPage({ token, personaName: form.persona.name }));
  });

  // POST /github/internal/refresh-by-vault — App-JWT install token mint.
  // Gated by INTEGRATIONS_INTERNAL_SECRET so it stays internal-only even
  // when mounted on a public Node port.
  app.post("/github/internal/refresh-by-vault", async (c) => {
    const expected = deps.internalSecret;
    if (!expected) return c.json({ error: "internal endpoints not configured" }, 503);
    const provided = c.req.header("x-internal-secret");
    if (!provided || provided !== expected) return c.json({ error: "unauthorized" }, 401);
    let body: { userId?: string; vaultId?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (!body.userId || !body.vaultId) {
      return c.json({ error: "userId, vaultId required" }, 400);
    }
    try {
      const refreshed = await deps.installBridge.refreshGithubVault({
        userId: body.userId,
        vaultId: body.vaultId,
      });
      return c.json({ ok: true, token: refreshed.token, expiresAt: refreshed.expiresAt });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Match the CF route's 404 / 502 split rather than blanket 500 — the
      // session-create path branches on 404 vs 5xx.
      if (/no github installation|app row missing|private key missing/i.test(msg)) {
        return c.json({ error: msg }, 404);
      }
      return c.json({ error: "github_token_mint_failed", details: msg }, 502);
    }
  });

  // POST /github/internal/list-repos — enumerate the repos an installation
  // can see, for the Console's GitHub-issues board repo picker. Resolves an
  // installation token via the same App-JWT path as refresh-by-vault, reused
  // from `boardInstallationToken`'s in-memory cache while it's still valid,
  // then calls GitHub's `GET /installation/repositories`. Internal-only: the
  // public-facing route in integrations/index.ts resolves installation →
  // vaultId + ownership before forwarding here with the internal secret.
  app.post("/github/internal/list-repos", async (c) => {
    const gate = checkInternalSecret(c, deps.internalSecret);
    if (gate) return gate;
    let body: { userId?: string; vaultId?: string; page?: number };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (!body.userId || !body.vaultId) {
      return c.json({ error: "userId, vaultId required" }, 400);
    }
    try {
      const token = await boardInstallationToken(deps, body.userId, body.vaultId);
      const startPage = Number.isFinite(body.page) && body.page! > 0 ? Math.floor(body.page!) : 1;
      // Follow pagination: a >100-repo org used to silently lose everything
      // past page 1. The result is cached by the caller, so the extra round
      // trips are paid once per TTL, and the page cap bounds a pathological
      // org rather than looping forever.
      type RawRepo = {
        name: string;
        full_name: string;
        private: boolean;
        default_branch?: string;
        html_url?: string;
        owner?: { login?: string };
      };
      const raw: RawRepo[] = [];
      let total = 0;
      let hasMore = false;
      for (let i = 0; i < BOARD_REPO_MAX_PAGES; i++) {
        const page = startPage + i;
        const res = await githubApiGet(
          token,
          `/installation/repositories?per_page=100&page=${page}`,
        );
        if (!res.ok) {
          return c.json({ error: "github_api_error", details: res.text.slice(0, 200) }, 502);
        }
        const parsed = JSON.parse(res.text) as {
          total_count?: number;
          repositories?: RawRepo[];
        };
        const batch = parsed.repositories ?? [];
        raw.push(...batch);
        total = parsed.total_count ?? raw.length;
        // Fewer than a full page means GitHub has nothing left to give.
        if (batch.length < 100) {
          hasMore = false;
          break;
        }
        hasMore = page * 100 < total;
        if (!hasMore) break;
      }
      const repos = raw.map((r) => ({
        owner: r.owner?.login ?? r.full_name.split("/")[0] ?? "",
        name: r.name,
        full_name: r.full_name,
        private: !!r.private,
        default_branch: r.default_branch ?? null,
        html_url: r.html_url ?? `https://github.com/${r.full_name}`,
      }));
      return c.json({ data: repos, has_more: hasMore });
    } catch (err) {
      return githubMintError(c, err);
    }
  });

  // POST /github/internal/list-assignees — users assignable to issues in one
  // repo, backing the board's Assignee combobox. Same internal-secret gate
  // and token mint as its siblings.
  app.post("/github/internal/list-assignees", async (c) => {
    const gate = checkInternalSecret(c, deps.internalSecret);
    if (gate) return gate;
    let body: { userId?: string; vaultId?: string; owner?: string; repo?: string };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (!body.userId || !body.vaultId || !body.owner || !body.repo) {
      return c.json({ error: "userId, vaultId, owner, repo required" }, 400);
    }
    try {
      const token = await boardInstallationToken(deps, body.userId, body.vaultId);
      const res = await githubApiGet(
        token,
        `/repos/${encodeURIComponent(body.owner)}/${encodeURIComponent(body.repo)}/assignees?per_page=100`,
      );
      if (!res.ok) return c.json({ error: "github_api_error", details: res.text.slice(0, 200) }, 502);
      const parsed = JSON.parse(res.text) as Array<{
        login?: string;
        avatar_url?: string;
      }>;
      const users = (Array.isArray(parsed) ? parsed : [])
        .filter((u) => !!u.login)
        .map((u) => ({ login: u.login as string, avatar_url: u.avatar_url ?? null }));
      return c.json({ data: users });
    } catch (err) {
      return githubMintError(c, err);
    }
  });

  // POST /github/internal/list-issues — search issues in one repo with the
  // board's filters (state / labels / assignee / free-text keywords). Uses
  // GitHub's search API so every filter collapses into a single `q`, and
  // `is:issue` keeps pull requests out. Same token-mint + internal-secret
  // gate as list-repos.
  app.post("/github/internal/list-issues", async (c) => {
    const gate = checkInternalSecret(c, deps.internalSecret);
    if (gate) return gate;
    let body: {
      userId?: string;
      vaultId?: string;
      owner?: string;
      repo?: string;
      state?: string;
      labels?: string[];
      assignee?: string;
      q?: string;
      page?: number;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "invalid json" }, 400);
    }
    if (!body.userId || !body.vaultId || !body.owner || !body.repo) {
      return c.json({ error: "userId, vaultId, owner, repo required" }, 400);
    }
    try {
      const token = await boardInstallationToken(deps, body.userId, body.vaultId);
      const search = buildIssueSearchQuery(body);
      const page = Number.isFinite(body.page) && body.page! > 0 ? Math.floor(body.page!) : 1;
      const res = await githubApiGet(
        token,
        `/search/issues?q=${encodeURIComponent(search)}&sort=updated&order=desc&per_page=30&page=${page}`,
      );
      if (!res.ok) return c.json({ error: "github_api_error", details: res.text.slice(0, 200) }, 502);
      const parsed = JSON.parse(res.text) as {
        total_count?: number;
        items?: Array<Record<string, unknown>>;
      };
      const issues = (parsed.items ?? [])
        .filter((it) => !it.pull_request)
        .map((it) => serializeGithubIssue(it));
      return c.json({ data: issues, total_count: parsed.total_count ?? issues.length });
    } catch (err) {
      return githubMintError(c, err);
    }
  });

  // ─── Slack ───────────────────────────────────────────────────────────
  // GET /slack/oauth/pub/:pubId/callback?code=&state=
  //
  // Publication-first install: the OMA publication id (not Slack's app id) is
  // the path parameter. Provider reads creds straight off the publication
  // row (`slack_publications.client_*_cipher`), exchanges code, materializes
  // installation/vaults/apps, binds them back onto the publication, flips
  // status to 'live'. See SlackProvider.completeInstall.
  app.get("/slack/oauth/pub/:pubId/callback", async (c) => {
    const pubId = c.req.param("pubId");
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) return c.json({ error: "slack_oauth_denied", details: error }, 400);
    if (!pubId || !code || !state) {
      return c.json({ error: "missing pubId, code, or state" }, 400);
    }
    try {
      const result = await deps.installBridge.continueInstall({
        provider: "slack",
        providerInstallationId: pubId,
        code,
        state,
      });
      if (!result.returnUrl) {
        // Defensive fallback: callers should always pass returnUrl in the
        // form-token JWT. When they don't (early reissueFormToken bug
        // 2026-05-20 left it empty), redirect to a known good
        // same-origin path so the user lands on a real UI instead of a
        // raw JSON envelope. Slack's integrations list page already
        // honors the install=ok/probe_* query params for the success
        // banner.
        const fallback = new URL(c.req.url);
        fallback.pathname = "/integrations/slack";
        fallback.search = "";
        fallback.searchParams.set("publication_id", result.publicationId);
        fallback.searchParams.set("install", "ok");
        const fbProbe = result.capabilityProbe;
        if (fbProbe) {
          fallback.searchParams.set("probe_kind", fbProbe.kind);
          fallback.searchParams.set("probe_ok", fbProbe.ok ? "1" : "0");
          if (fbProbe.message) fallback.searchParams.set("probe_message", fbProbe.message);
          if (fbProbe.fixUrl) fallback.searchParams.set("probe_fix_url", fbProbe.fixUrl);
        }
        return c.redirect(fallback.pathname + fallback.search, 302);
      }
      const target = new URL(result.returnUrl);
      target.searchParams.set("publication_id", result.publicationId);
      target.searchParams.set("install", "ok");
      // Surface the vendor capability probe (e.g. Slack MCP toggle) as
      // query params so the wizard's success page can show the right
      // green-check or warning-with-deeplink banner.
      const probe = result.capabilityProbe;
      if (probe) {
        target.searchParams.set("probe_kind", probe.kind);
        target.searchParams.set("probe_ok", probe.ok ? "1" : "0");
        if (probe.message) target.searchParams.set("probe_message", probe.message);
        if (probe.fixUrl) target.searchParams.set("probe_fix_url", probe.fixUrl);
      }
      return c.redirect(target.toString(), 302);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ op: "slack.oauth.pub.callback.failed", pubId, err: msg }, "slack callback failed");
      return c.json({ error: "install_failed", details: msg }, 500);
    }
  });

  // Legacy callback path retained for any in-flight installs that started
  // on the old per-app id flow. Delegates to the same install bridge with
  // the legacy provider-installation-id (Slack app id). Will become a 404
  // once those installs drain (~1h after deploy).
  app.get("/slack/oauth/app/:appId/callback", async (c) => {
    const appId = c.req.param("appId");
    const url = new URL(c.req.url);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) return c.json({ error: "slack_oauth_denied", details: error }, 400);
    if (!appId || !code || !state) {
      return c.json({ error: "missing appId, code, or state" }, 400);
    }
    try {
      const result = await deps.installBridge.continueInstall({
        provider: "slack",
        providerInstallationId: appId,
        code,
        state,
      });
      if (!result.returnUrl) {
        return c.json({
          ok: true,
          publicationId: result.publicationId,
          capabilityProbe: result.capabilityProbe ?? null,
        });
      }
      const target = new URL(result.returnUrl);
      target.searchParams.set("publication_id", result.publicationId);
      target.searchParams.set("install", "ok");
      const probe = result.capabilityProbe;
      if (probe) {
        target.searchParams.set("probe_kind", probe.kind);
        target.searchParams.set("probe_ok", probe.ok ? "1" : "0");
        if (probe.message) target.searchParams.set("probe_message", probe.message);
        if (probe.fixUrl) target.searchParams.set("probe_fix_url", probe.fixUrl);
      }
      return c.redirect(target.toString(), 302);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn({ op: "slack.oauth.callback.failed", appId, err: msg }, "slack callback failed");
      return c.json({ error: "install_failed", details: msg }, 500);
    }
  });

  // GET /slack-setup/:token
  app.get("/slack-setup/:token", async (c) => {
    const token = c.req.param("token");
    let form: { persona: { name: string }; userId: string; agentId: string };
    try {
      form = await deps.jwt.verify<typeof form>(token);
    } catch (err) {
      return c.html(errorPage(err instanceof Error ? err.message : String(err)), 400);
    }
    return c.html(slackLandingPage({ token, personaName: form.persona.name }));
  });

  // ─── Webhooks ────────────────────────────────────────────────────────
  // Same /provider/webhook/app/:appId shape CF used. Each handler reads
  // the raw body, lowercases headers, and asks the provider via the
  // injected webhook closure. Always returns 200 (provider contract).
  if (deps.webhooks.linear) mountLinearWebhook(app, deps.webhooks.linear, deps.rateLimit);
  if (deps.webhooks.github) mountGithubWebhook(app, deps.webhooks.github, deps.rateLimit);
  if (deps.webhooks.githubManaged) {
    mountGithubManagedWebhook(app, deps.webhooks.githubManaged, deps.rateLimit);
  }
  if (deps.webhooks.slack) mountSlackWebhook(app, deps.webhooks.slack, deps.rateLimit);

  // ─── Linear MCP ──────────────────────────────────────────────────────
  app.post("/linear/mcp/:sessionId", async (c) => {
    return handleLinearMcp(c, deps.installBridge);
  });

  return app;
}

// ─── Webhook receivers (same shape as apps/integrations/src/routes/*) ──

function mountLinearWebhook(
  app: Hono,
  handler: WebhookHandler,
  rl: RateLimitHooks | undefined,
) {
  // Publication-first: webhook URL is keyed on pub_id (the user pasted
  // `/linear/webhook/pub/<pubId>` into Linear's OAuth-app webhook config
  // at publication create time). The handler walks pub_id → installation
  // for credentials and dispatch — see LinearProvider.handleWebhook.
  app.post("/linear/webhook/pub/:pubId", async (c) => {
    const pubId = c.req.param("pubId");
    const rawBody = await c.req.raw.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    const deliveryId = headers["linear-delivery"] ?? safeJsonField(rawBody, "webhookId");
    const outcome = await handler({
      providerId: "linear",
      // installationId is a misnomer left over from the legacy app-id
      // keying — for the publication-first flow it carries the pub_id.
      // Renaming the field would mean churning every WebhookRequest
      // call site across the three providers, which is outside the scope
      // of this refactor.
      installationId: pubId ?? null,
      deliveryId,
      headers,
      rawBody,
    });
    if (outcome.tenantId && rl?.shouldDropForTenant) {
      await rl.shouldDropForTenant(outcome.tenantId);
    }
    return c.json({ ok: outcome.handled, reason: outcome.reason ?? null }, 200);
  });
}

/**
 * Stable webhook URL for the ONE shared managed GitHub App
 * (`GITHUB_MANAGED_*` env config) — configure github.com's App webhook URL
 * as `<gateway-origin>/github/webhook/managed`. Unlike the per-App route
 * above there's no per-publication id in the path (a managed App has
 * exactly one webhook URL regardless of how many publications install
 * it); `GitHubProvider.handleManagedWebhook` resolves the publication
 * from the payload's `installation.id` instead.
 */
function mountGithubManagedWebhook(
  app: Hono,
  handler: WebhookHandler,
  rl: RateLimitHooks | undefined,
) {
  app.post("/github/webhook/managed", async (c) => {
    const rawBody = await c.req.raw.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    const deliveryId = headers["x-github-delivery"] ?? null;
    const outcome = await handler({
      providerId: "github",
      installationId: null,
      deliveryId,
      headers,
      rawBody,
    });
    if (outcome.tenantId && rl?.shouldDropForTenant) {
      await rl.shouldDropForTenant(outcome.tenantId);
    }
    return c.json({ ok: outcome.handled, reason: outcome.reason ?? null }, 200);
  });
}

function mountGithubWebhook(
  app: Hono,
  handler: WebhookHandler,
  rl: RateLimitHooks | undefined,
) {
  app.post("/github/webhook/app/:appOmaId", async (c) => {
    const appOmaId = c.req.param("appOmaId");
    const rawBody = await c.req.raw.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    const deliveryId = headers["x-github-delivery"] ?? null;
    const outcome = await handler({
      providerId: "github",
      installationId: appOmaId,
      deliveryId,
      headers,
      rawBody,
    });
    if (outcome.tenantId && rl?.shouldDropForTenant) {
      await rl.shouldDropForTenant(outcome.tenantId);
    }
    return c.json({ ok: outcome.handled, reason: outcome.reason ?? null }, 200);
  });
}

function mountSlackWebhook(
  app: Hono,
  handler: WebhookHandler,
  rl: RateLimitHooks | undefined,
) {
  // Publication-first webhook URL. Manifest baked at api.slack.com points
  // here from minute 1 (pub_id is known at shell-create time, before the
  // Slack app exists). Provider's handleWebhook reads x-internal-pub-id,
  // resolves the publication's slack_app_id, and continues exactly the
  // same dispatch path the legacy app-id route uses.
  app.post("/slack/webhook/pub/:pubId", async (c) => {
    const pubId = c.req.param("pubId");
    const rawBody = await c.req.raw.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    if (pubId) headers["x-internal-pub-id"] = pubId;
    const outcome = await handler({
      providerId: "slack",
      installationId: pubId,
      deliveryId: null,
      headers,
      rawBody,
    });
    if (outcome.challengeResponse !== undefined) {
      return new Response(outcome.challengeResponse, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (outcome.tenantId && rl?.shouldDropForTenant) {
      const dropped = await rl.shouldDropForTenant(outcome.tenantId);
      if (dropped) return c.json({ ok: false, reason: "tenant_rate_limited" }, 200);
    }
    if (outcome.deferredWork) {
      const work = outcome.deferredWork().catch((err) => {
        log.warn(
          { op: "slack.webhook.deferred.failed", err: err instanceof Error ? err.message : String(err) },
          "slack deferred work failed",
        );
      });
      try {
        c.executionCtx?.waitUntil(work);
      } catch {
        // see legacy route below
      }
    }
    return c.json({ ok: outcome.handled, reason: outcome.reason ?? null }, 200);
  });

  // Legacy app-keyed route. Pre-publication-first installs still have
  // this URL persisted in their Slack app config; keep the route alive
  // so existing live publications keep delivering until they're
  // re-installed under the new pub-keyed URL.
  app.post("/slack/webhook/app/:appId", async (c) => {
    const appId = c.req.param("appId");
    const rawBody = await c.req.raw.text();
    const headers: Record<string, string> = {};
    c.req.raw.headers.forEach((value, key) => (headers[key.toLowerCase()] = value));
    if (appId) headers["x-internal-app-id"] = appId;
    const outcome = await handler({
      providerId: "slack",
      installationId: appId,
      deliveryId: null,
      headers,
      rawBody,
    });
    if (outcome.challengeResponse !== undefined) {
      return new Response(outcome.challengeResponse, {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }
    if (outcome.tenantId && rl?.shouldDropForTenant) {
      const dropped = await rl.shouldDropForTenant(outcome.tenantId);
      if (dropped) return c.json({ ok: false, reason: "tenant_rate_limited" }, 200);
    }
    if (outcome.deferredWork) {
      // Run in background — Slack's 3sec budget rules out inline. On
      // Cloudflare Workers, the isolate is terminated as soon as we
      // return the response, so a bare `void promise.catch()` would have
      // its work yanked mid-flight (and dispatchEvent's sessions.create /
      // attachSession would never complete — webhook_events row stuck at
      // session_id=null + error=null). Hand it to executionCtx.waitUntil
      // so CF keeps the isolate alive until it settles. On Node, where
      // executionCtx may be absent, fall through to plain background.
      const work = outcome.deferredWork().catch((err) => {
        log.warn(
          { op: "slack.webhook.deferred.failed", err: err instanceof Error ? err.message : String(err) },
          "slack deferred work failed",
        );
      });
      try {
        c.executionCtx?.waitUntil(work);
      } catch {
        // c.executionCtx accessor throws on Node when not provided; the
        // promise still runs in the background.
      }
    }
    return c.json({ ok: outcome.handled, reason: outcome.reason ?? null }, 200);
  });
}

// ─── Linear MCP JSON-RPC ──────────────────────────────────────────────

const PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "OMA Linear", version: "0.3.0" } as const;

interface JsonRpcReq {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: unknown;
}

async function handleLinearMcp(
  c: import("hono").Context,
  bridge: InstallBridge,
): Promise<Response> {
  const sessionId = c.req.param("sessionId");
  if (!sessionId) return jsonRpcError(null, -32001, "missing sessionId");
  const auth = c.req.header("authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : null;
  if (!bearer) return jsonRpcError(null, -32001, "missing bearer token");

  let cred;
  try {
    cred = await bridge.lookupLinearCredentialForSession({ sessionId, bearerToken: bearer });
  } catch (err) {
    return jsonRpcError(null, -32001, `auth failed: ${(err as Error).message}`);
  }

  let body: JsonRpcReq;
  try {
    body = (await c.req.json()) as JsonRpcReq;
  } catch {
    return jsonRpcError(null, -32700, "parse error");
  }
  if (body?.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return jsonRpcError(body?.id ?? null, -32600, "invalid request");
  }

  const id = body.id ?? null;
  switch (body.method) {
    case "initialize":
      return jsonRpcOk(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "OMA-side Linear escape hatch. Most issue/comment/state operations " +
          "should go through Linear's hosted MCP (mcp.linear.app/mcp), which " +
          "is also attached to this session. Use this server's `linear_graphql` " +
          "tool only when hosted MCP doesn't cover what you need.",
      });
    case "notifications/initialized":
      return new Response(null, { status: 204 });
    case "tools/list":
      return jsonRpcOk(id, { tools: [LINEAR_GRAPHQL_TOOL_DESCRIPTOR] });
    case "tools/call": {
      const params = (body.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };
      if (params.name !== "linear_graphql") {
        return jsonRpcError(id, -32601, `unknown tool: ${params.name}`);
      }
      try {
        const result = await runLinearGraphQL(cred, params.arguments ?? {});
        return jsonRpcOk(id, result);
      } catch (err) {
        return jsonRpcError(id, -32603, `tool failed: ${(err as Error).message}`);
      }
    }
    default:
      return jsonRpcError(id, -32601, `method not found: ${body.method}`);
  }
}

const LINEAR_GRAPHQL_TOOL_DESCRIPTOR = {
  name: "linear_graphql",
  title: "Raw Linear GraphQL escape hatch",
  description:
    "Run a single GraphQL query or mutation against Linear directly. Use " +
    "this for operations not covered by the curated tools above — creating " +
    "sub-issues, adding labels, attaching files, fetching team workflows, " +
    "etc.\n\n" +
    "Restrictions: exactly one operation per call (no multi-op documents). " +
    "Auth uses the publication's installation token, so the bot's effective " +
    "permissions are the OAuth app's scopes (read, write, app:assignable, " +
    "app:mentionable) — for personal-token installations, the PAT owner's " +
    "permissions.\n\n" +
    "Returns raw JSON. Errors come back as a structured `errors` array.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "GraphQL query or mutation source. Single operation only." },
      variables: { type: "object", description: "Optional GraphQL variables map." },
    },
    required: ["query"],
  },
};

async function runLinearGraphQL(
  cred: import("@duyet/oma-integrations-core").LinearMcpCredentialLookupResult,
  args: Record<string, unknown>,
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const query = String(args.query ?? "").trim();
  if (!query) return errResult("query required");
  const opMatches = query.match(/\b(query|mutation|subscription)\b/g) ?? [];
  if (opMatches.length > 1) {
    return errResult("multi-operation documents are not allowed; submit one operation per call");
  }
  const variables =
    args.variables && typeof args.variables === "object" && !Array.isArray(args.variables)
      ? (args.variables as Record<string, unknown>)
      : undefined;

  let token = cred.accessToken;
  let res = await linearGraphQLFetch(token, { query, variables });
  if (isAuthError(res.errors as Array<{ extensions?: { code?: string } }> | undefined)) {
    try {
      token = await cred.refreshAccessToken();
      res = await linearGraphQLFetch(token, { query, variables });
    } catch {
      // fall through with the original error
    }
  }
  const isError = Array.isArray(res.errors) && (res.errors as unknown[]).length > 0;
  const text = JSON.stringify({ data: res.data ?? null, errors: res.errors ?? null }, null, 2);
  return isError ? errResult(text) : okResult(text);
}

async function linearGraphQLFetch(
  accessToken: string,
  payload: { query: string; variables?: Record<string, unknown> },
): Promise<{ data?: unknown; errors?: unknown }> {
  const res = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: {
      // PAT (`lin_api_…`) MUST be raw; OAuth tokens MUST be `Bearer <token>`.
      // Linear returns INPUT_ERROR if you Bearer-wrap a PAT.
      authorization: accessToken.startsWith("lin_api_") ? accessToken : `Bearer ${accessToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  return (await res.json()) as { data?: unknown; errors?: unknown };
}

function isAuthError(errs: Array<{ extensions?: { code?: string } }> | undefined): boolean {
  if (!errs?.length) return false;
  return errs.some((e) => e.extensions?.code === "AUTHENTICATION_ERROR");
}

function okResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
function errResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function jsonRpcOk<T>(id: string | number | null, result: T): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}
function jsonRpcError(
  id: string | number | null,
  code: number,
  message: string,
  data?: unknown,
): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message, data } });
}

// ─── GitHub board helpers (repo picker + issues board) ────────────────

const GITHUB_API_ORIGIN = "https://api.github.com";

/**
 * Short-lived installation-token cache for the read-only board endpoints.
 *
 * `refreshGithubVault` is expensive: it lists installations, decrypts the
 * App private key, signs a JWT, POSTs GitHub's access-tokens endpoint, then
 * rotates two vault credentials — five-plus round trips before the board's
 * own GitHub call even starts. GitHub installation tokens are valid for an
 * hour, so re-minting one per board request (and the board fires a repos +
 * issues pair on every filter change) is pure latency.
 *
 * Scope is deliberately narrow: process memory only (never persisted),
 * keyed by the exact (userId, vaultId) pair the caller already proved it
 * owns, dropped well before the token's own expiry, and used only by the
 * two read-only board endpoints — `refresh-by-vault` still mints fresh
 * every time, because its callers depend on the vault rotation side effect.
 */
/** Page cap for list-repos' pagination follow — 10 pages × 100 = 1000 repos. */
const BOARD_REPO_MAX_PAGES = 10;
const BOARD_TOKEN_SAFETY_MS = 5 * 60_000;
const BOARD_TOKEN_CACHE_MAX = 200;
const boardTokenCache = new Map<string, { token: string; expiresAtMs: number }>();

async function boardInstallationToken(
  deps: IntegrationsGatewayDeps,
  userId: string,
  vaultId: string,
): Promise<string> {
  const key = `${userId} ${vaultId}`;
  const hit = boardTokenCache.get(key);
  if (hit && hit.expiresAtMs - BOARD_TOKEN_SAFETY_MS > Date.now()) return hit.token;

  const { token, expiresAt } = await deps.installBridge.refreshGithubVault({ userId, vaultId });
  const expiresAtMs = expiresAt ? Date.parse(expiresAt) : NaN;
  if (Number.isFinite(expiresAtMs)) {
    // Cheap bound on an unbounded-in-principle map: a full cache drops its
    // oldest insertion rather than growing with the tenant count.
    if (boardTokenCache.size >= BOARD_TOKEN_CACHE_MAX) {
      const oldest = boardTokenCache.keys().next();
      if (!oldest.done) boardTokenCache.delete(oldest.value);
    }
    boardTokenCache.set(key, { token, expiresAtMs });
  }
  return token;
}

/** Plain authenticated GET against the GitHub REST API using an installation
 *  token. Kept dependency-free (raw fetch, like linearGraphQLFetch) so
 *  http-routes stays clear of `@duyet/oma-github`. */
async function githubApiGet(
  installationToken: string,
  path: string,
): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(`${GITHUB_API_ORIGIN}${path}`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${installationToken}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "open-managed-agents",
    },
  });
  const text = await res.text();
  return { ok: res.status >= 200 && res.status < 300, status: res.status, text };
}

/** Map a token-mint / GitHub failure onto the same 404 / 502 split the
 *  refresh-by-vault route uses, so callers branch identically. */
function githubMintError(c: import("hono").Context, err: unknown): Response {
  const msg = err instanceof Error ? err.message : String(err);
  if (/no github installation|app row missing|private key missing/i.test(msg)) {
    return c.json({ error: msg }, 404);
  }
  return c.json({ error: "github_board_failed", details: msg }, 502);
}

/** Build a GitHub search query string scoping to one repo's issues plus the
 *  board's structured filters. `assignee: "none"` maps to `no:assignee`. */
function buildIssueSearchQuery(body: {
  owner?: string;
  repo?: string;
  state?: string;
  labels?: string[];
  assignee?: string;
  q?: string;
}): string {
  const parts: string[] = [`repo:${body.owner}/${body.repo}`, "is:issue"];
  const state = body.state === "closed" ? "closed" : body.state === "open" ? "open" : null;
  if (state) parts.push(`state:${state}`);
  for (const label of body.labels ?? []) {
    const trimmed = label.trim();
    if (trimmed) parts.push(`label:"${trimmed.replace(/"/g, "")}"`);
  }
  const assignee = body.assignee?.trim();
  if (assignee) parts.push(assignee.toLowerCase() === "none" ? "no:assignee" : `assignee:${assignee}`);
  const free = body.q?.trim();
  if (free) parts.push(free);
  return parts.join(" ");
}

/** Narrow a GitHub search-API issue item to the fields the board renders. */
function serializeGithubIssue(it: Record<string, unknown>) {
  const labels = Array.isArray(it.labels)
    ? (it.labels as Array<Record<string, unknown>>).map((l) => ({
        name: String(l.name ?? ""),
        color: typeof l.color === "string" ? l.color : null,
      }))
    : [];
  const assignee = it.assignee as { login?: string; avatar_url?: string } | null | undefined;
  const user = it.user as { login?: string } | null | undefined;
  return {
    number: typeof it.number === "number" ? it.number : 0,
    title: String(it.title ?? ""),
    state: it.state === "closed" ? "closed" : "open",
    html_url: String(it.html_url ?? ""),
    body: typeof it.body === "string" ? it.body : "",
    labels,
    assignee: assignee?.login
      ? { login: assignee.login, avatar_url: assignee.avatar_url ?? null }
      : null,
    user: user?.login ? { login: user.login } : null,
    comments: typeof it.comments === "number" ? it.comments : 0,
    updated_at: String(it.updated_at ?? ""),
  };
}

function safeJsonField(body: string, field: string): string | null {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const v = parsed[field];
    return typeof v === "string" ? v : null;
  } catch {
    return null;
  }
}

/** Console path an install callback falls back to when the state carried no
 *  usable returnUrl (missing / expired / install started from GitHub's own
 *  App page). */
const CONSOLE_GITHUB_PATH = "/integrations/github";

/**
 * Resolve a console target that may be absolute (the returnUrl the frontend
 * supplied) or relative (our fallback path). A relative path left as-is is
 * resolved by the browser against the *gateway* origin
 * (`integrations.<domain>`), which serves no Console — the user lands on a
 * 404 instead of back in OMA. `consoleOrigin` fixes that; when it's unset we
 * emit the relative path unchanged rather than guessing.
 */
function resolveConsoleTarget(
  base: string,
  consoleOrigin: string | null | undefined,
): string {
  try {
    return new URL(base).toString();
  } catch {
    if (consoleOrigin) {
      try {
        return new URL(base, consoleOrigin).toString();
      } catch {
        // Misconfigured consoleOrigin — fall through to the relative path.
      }
    }
    return base;
  }
}

/** Append query params to a console target, absolute or relative. */
function redirectToConsole(
  c: import("hono").Context,
  base: string,
  consoleOrigin: string | null | undefined,
  params: Record<string, string>,
): Response {
  const resolved = resolveConsoleTarget(base, consoleOrigin);
  try {
    const target = new URL(resolved);
    for (const [key, value] of Object.entries(params)) {
      target.searchParams.set(key, value);
    }
    return c.redirect(target.toString(), 302);
  } catch {
    // Relative path — build the query string by hand.
    const query = new URLSearchParams(params).toString();
    const sep = resolved.includes("?") ? "&" : "?";
    return c.redirect(`${resolved}${sep}${query}`, 302);
  }
}

/**
 * Build the 302 back to the console after a managed workspace install.
 * Appends `?managed_install=<status>` (+ `&login=<login>` on success).
 * Success also carries `connected=1`, the documented public contract for
 * "the App round-tripped back to the Console" (`/integrations/github?connected=1`).
 */
function redirectManagedInstall(
  c: import("hono").Context,
  returnUrl: string | null | undefined,
  status: "ok" | "error" | "unlinked",
  login?: string | null,
  consoleOrigin?: string | null,
): Response {
  const base = returnUrl && returnUrl.trim() ? returnUrl : CONSOLE_GITHUB_PATH;
  const params: Record<string, string> = { managed_install: status };
  if (status === "ok") params.connected = "1";
  if (login) params.login = login;
  return redirectToConsole(c, base, consoleOrigin, params);
}

/**
 * Build the 302 back to the console after a publication-first install
 * completes. Appends `?install=ok&publication_id=…` plus the vendor
 * capability probe params the wizard's success banner reads.
 */
function redirectPublicationInstall(
  c: import("hono").Context,
  opts: {
    returnUrl: string | null | undefined;
    publicationId: string;
    probe?: { kind: string; ok: boolean; message?: string; fixUrl?: string } | null;
    consoleOrigin?: string | null;
  },
): Response {
  const base =
    opts.returnUrl && opts.returnUrl.trim() ? opts.returnUrl : CONSOLE_GITHUB_PATH;
  const params: Record<string, string> = {
    publication_id: opts.publicationId,
    install: "ok",
  };
  const probe = opts.probe;
  if (probe) {
    params.probe_kind = probe.kind;
    params.probe_ok = probe.ok ? "1" : "0";
    if (probe.message) params.probe_message = probe.message;
    if (probe.fixUrl) params.probe_fix_url = probe.fixUrl;
  }
  return redirectToConsole(c, base, opts.consoleOrigin, params);
}

// ─── Setup-page HTML (verbatim from CF impl) ─────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function errorPage(message: string): string {
  return `<!DOCTYPE html>
<html><body style="font:15px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 20px">
<h1>Link is invalid or expired</h1>
<p>${escapeHtml(message)}</p>
<p>Ask the original sender to generate a new setup link.</p>
</body></html>`;
}

function linearLandingPage(_opts: { token: string; personaName: string }): string {
  // Removed with the publication-first refactor; the wizard now hands an
  // OAuth callback URL directly. Function kept as a deprecated stub so any
  // forgotten import surfaces a build error rather than runtime null.
  throw new Error(
    "linearLandingPage removed in publication-first refactor — use POST /v1/integrations/linear/publications instead",
  );
}

function githubLandingPage(opts: { token: string; personaName: string }): string {
  const escapedToken = escapeHtml(opts.token);
  const escapedName = escapeHtml(opts.personaName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>GitHub App setup — ${escapedName}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; max-width: 640px; margin: 40px auto; padding: 0 20px; color: #111; }
    h1 { margin: 0 0 8px; font-size: 22px; }
    p, li { color: #444; }
    code { background: #f2f2f2; padding: 1px 6px; border-radius: 4px; font-size: 13px; word-break: break-all; }
    label { display: block; font-weight: 600; margin: 16px 0 4px; }
    input, textarea { width: 100%; padding: 8px 10px; border: 1px solid #ccc; border-radius: 6px; font: inherit; box-sizing: border-box; font-family: ui-monospace, monospace; font-size: 12px; }
    textarea { min-height: 120px; }
    button { margin-top: 16px; padding: 10px 16px; background: #111; color: #fff; border: 0; border-radius: 6px; font: inherit; cursor: pointer; }
    button:disabled { opacity: 0.5; cursor: default; }
    .ok { color: #060; margin-top: 12px; }
    .err { color: #b00; margin-top: 12px; }
    .pillbar { display: flex; gap: 6px; flex-wrap: wrap; }
    .pillbar code { font-size: 11px; padding: 2px 6px; }
  </style>
</head>
<body>
  <h1>Install "${escapedName}" GitHub App on your org</h1>
  <p>Someone on your team is publishing Oma's <strong>${escapedName}</strong> agent
  to GitHub. GitHub App registration on an org requires an admin — that's where you come in.</p>
  <ol>
    <li>Open GitHub → Settings → Developer settings → New GitHub App.</li>
    <li>After saving, on the App's page download a <strong>private key</strong> (.pem). Note the <strong>App ID</strong> at the top.</li>
    <li>Paste the App ID, the contents of the .pem file, and the webhook secret you chose:</li>
  </ol>
  <form id="f">
    <label for="appid">App ID</label>
    <input id="appid" name="appid" required autocomplete="off" placeholder="e.g. 1234567">
    <label for="pkey">Private key (full PEM)</label>
    <textarea id="pkey" name="pkey" required autocomplete="off"></textarea>
    <label for="whsec">Webhook secret</label>
    <input id="whsec" name="whsec" type="password" required autocomplete="off">
    <button id="submit" type="submit">Continue →</button>
    <p id="msg"></p>
  </form>
  <script>
    const TOKEN = ${JSON.stringify(escapedToken)};
    document.getElementById("f").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("submit");
      const msg = document.getElementById("msg");
      btn.disabled = true;
      msg.textContent = "Validating with GitHub…";
      msg.className = "";
      try {
        const res = await fetch("/github/publications/credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            formToken: TOKEN,
            appId: document.getElementById("appid").value.trim(),
            privateKey: document.getElementById("pkey").value,
            webhookSecret: document.getElementById("whsec").value,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.textContent = "Error: " + (data.details || data.error || res.status);
          msg.className = "err";
          btn.disabled = false;
          return;
        }
        msg.textContent = "Redirecting to GitHub to install the App on your org…";
        msg.className = "ok";
        window.location.href = data.url;
      } catch (err) {
        msg.textContent = "Network error: " + err.message;
        msg.className = "err";
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

function githubRequestPendingPage(action: string): string {
  return `<!DOCTYPE html>
<html><body style="font:15px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 20px">
<h1>Install requested</h1>
<p>The GitHub App install request was sent to an org owner (action: <code>${escapeHtml(action)}</code>).
Once they approve, GitHub will redirect here again with <code>setup_action=install</code> and OMA will
finish the publish then. You can close this tab.</p>
</body></html>`;
}

function githubAutoRedirectPage(opts: { installUrl: string; returnUrl: string }): string {
  const escUrl = escapeHtml(opts.installUrl);
  const escRet = escapeHtml(opts.returnUrl || "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8"><title>App created — installing…</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="refresh" content="0;url=${escUrl}">
</head>
<body style="font:15px/1.5 system-ui;max-width:560px;margin:60px auto;padding:0 20px;text-align:center">
  <h1>App created. Picking org / repos…</h1>
  <p>Redirecting to GitHub to install. If you're not redirected, <a href="${escUrl}">click here</a>.</p>
  ${escRet ? `<p style="font-size:13px;color:#666">After install you'll come back to <a href="${escRet}">your console</a>.</p>` : ""}
</body></html>`;
}

function slackLandingPage(opts: { token: string; personaName: string }): string {
  const escapedToken = escapeHtml(opts.token);
  const escapedName = escapeHtml(opts.personaName);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Slack app setup — ${escapedName}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="font:15px/1.5 system-ui;max-width:560px;margin:40px auto;padding:0 20px;color:#111">
  <h1>Set up "${escapedName}" in your Slack workspace</h1>
  <p>Open <a href="https://api.slack.com/apps" target="_blank">api.slack.com/apps → Create New App</a>
  and follow the wizard. Then paste the credentials below.</p>
  <form id="f" style="margin-top:16px">
    <label>Client ID<input id="cid" required autocomplete="off"></label><br>
    <label>Client Secret<input id="csec" type="password" required autocomplete="off"></label><br>
    <label>Signing Secret<input id="ssec" type="password" required autocomplete="off"></label><br>
    <button id="submit" type="submit">Continue →</button>
    <p id="msg"></p>
  </form>
  <script>
    const TOKEN = ${JSON.stringify(escapedToken)};
    document.getElementById("f").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("submit");
      const msg = document.getElementById("msg");
      btn.disabled = true;
      msg.textContent = "Validating…";
      try {
        const res = await fetch("/slack/publications/credentials", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            formToken: TOKEN,
            clientId: document.getElementById("cid").value.trim(),
            clientSecret: document.getElementById("csec").value.trim(),
            signingSecret: document.getElementById("ssec").value.trim(),
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          msg.textContent = "Error: " + (data.details || data.error || res.status);
          btn.disabled = false;
          return;
        }
        msg.textContent = "Redirecting to Slack to authorize…";
        window.location.href = data.url;
      } catch (err) {
        msg.textContent = "Network error: " + err.message;
        btn.disabled = false;
      }
    });
  </script>
</body>
</html>`;
}

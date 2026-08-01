// AnyRouter upstream provider — OAuth (PKCE) "connect" routes.
//
// Runs AnyRouter's MCP OAuth 2.1 + PKCE + Dynamic Client Registration flow
// (packages/anyrouter has the pure protocol logic) to mint an `sk-ar-…`
// inference key for the signed-in AnyRouter user, without the user ever
// copy-pasting a key out of the AnyRouter dashboard. The minted key is
// persisted as a `static_bearer` credential (provider: "anyrouter") in a
// dedicated "AnyRouter" vault for the caller's tenant, exactly like the
// GitHub/Linear install flows persist their tokens.
//
// Endpoints:
//   GET  /connect      — start the flow (redirects the browser to AnyRouter)
//   GET  /callback      — AnyRouter's OAuth redirect target
//   GET  /status         — is this tenant connected?
//   POST /disconnect    — archive the credential
//   GET  /models        — cached AnyRouter model catalog + saved presets (GET /api/v1/models)
//   GET  /credits       — cached AnyRouter credit balance (GET /api/v1/credits)
//
// Model-card bind (#136): on a successful callback, when `services.modelCards`
// is wired (Cloudflare — see apps/main/src/lib/cf-route-services.ts), the
// connected key is also upserted into a `model_cards` row keyed on the fixed
// handle `model_id: "anyrouter"`, so `{"model": "anyrouter"}` on any agent
// resolves through `resolveModelCardCredentials` (session-do.ts) with zero
// env vars / pasted keys. Idempotent: a reconnect finds the existing card by
// model_id and rotates only its `api_key` (the minted token doesn't
// self-refresh, so "reconnect" IS the rotation mechanism) — it never
// clobbers a `model` the user picked via the Console model picker. Disconnect
// deletes the card outright (ModelCardService has no soft-delete) so a
// revoked connection can't silently keep routing agents through a
// now-invalid key.
//
// Node self-host has no D1 model-cards store (see apps/main-node/src/index.ts
// buildModel) — its model provider is process-global env vars
// (ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL/OMA_API_COMPAT), so `services.modelCards`
// stays undefined there and the upsert/delete below no-op. `hooks.onConnected`
// / `onDisconnected` let the Node entrypoint hot-swap that in-process provider
// cache so a fresh OAuth connect takes effect without a restart.

import { Hono } from "hono";
import {
  ANYROUTER_API_BASE,
  ANYROUTER_API_COMPAT,
  ANYROUTER_OAUTH_SCOPE,
  buildAuthorizeUrl,
  buildModelsRequest,
  buildRegisterRequest,
  buildTokenRequest,
  generatePkcePair,
  generateState,
  parseModelsResponse,
  parsePresetsResponse,
  parseRegisterResponse,
  parseTokenResponse,
} from "@duyet/oma-anyrouter";
import type { AnyRouterModel, AnyRouterPreset } from "@duyet/oma-anyrouter";
import type { KvStore } from "@duyet/oma-kv-store";
import type { RouteServices, RouteServicesArg } from "../types";
import { resolveServices } from "../types";

/** Fixed tenant-facing handle the auto-minted card is upserted under.
 *  `{"model": "anyrouter"}` on an agent resolves to this card. */
const MODEL_CARD_MODEL_ID = "anyrouter";

/** Sane default `provider/model` target for a freshly-connected tenant with
 *  no prior card. Validated against the live catalog at connect time when
 *  possible (falls back to this literal if the probe fails or the id isn't
 *  in the catalog — never blocks the connect flow on it). */
const DEFAULT_TARGET_MODEL = "anthropic/claude-sonnet-4-6";

/** Sibling model cards the one-click "starter agents" action provisions, each
 *  sharing the connected key but pinned to a distinct AnyRouter target so the
 *  two starter agents differ in cost/capability. Handles are tenant-unique
 *  `model_id`s an agent's `{"model": …}` resolves through the same
 *  `resolveModelCardCredentials` path as the base "anyrouter" card. The model
 *  ids mirror the two known-good Anthropic defaults used elsewhere in the
 *  Console (no invented ids — issue #183). */
const PRESET_CARDS: {
  modelId: string;
  model: string;
  role: "strong" | "fast";
  label: string;
}[] = [
  {
    modelId: "anyrouter-strong",
    model: "anthropic/claude-sonnet-4-6",
    role: "strong",
    label: "Claude Sonnet 4-6",
  },
  {
    modelId: "anyrouter-fast",
    model: "anthropic/claude-haiku-4-5",
    role: "fast",
    label: "Claude Haiku 4-5",
  },
];

interface Vars {
  Variables: { tenant_id: string; user_id?: string };
}

const KV_CLIENT_KEY = "anyrouter:oauth_client";
const KV_PENDING_PREFIX = "anyrouter:oauth_pending:";
/** Global models catalog cache — the upstream /models catalog is the same
 *  for every account, so caching it globally is a pure win (one upstream
 *  call per hour across all tenants instead of N). */
const KV_MODELS_CACHE_KEY = "anyrouter:models_cache";
/** Per-tenant presets cache — saved presets are account-specific (each
 *  AnyRouter user curates their own), so caching them globally would leak
 *  one tenant's presets into another's picker. Separate key prefix keeps
 *  the shared catalog cold-free while keeping presets isolated. */
const KV_PRESETS_CACHE_PREFIX = "anyrouter:presets_cache:";
const KV_CREDITS_CACHE_PREFIX = "anyrouter:credits_cache:";
const PENDING_TTL_SECONDS = 10 * 60;
const MODELS_CACHE_TTL_MS = 60 * 60 * 1000;
const PRESETS_CACHE_TTL_MS = 15 * 60 * 1000;
const CREDITS_CACHE_TTL_MS = 60 * 1000;
const VAULT_NAME = "AnyRouter";
const CREDENTIAL_DISPLAY_NAME = "AnyRouter inference key";
const CLIENT_NAME = "Open Managed Agents";

interface StoredClient {
  clientId: string;
  redirectUri: string;
}

interface PendingAuth {
  verifier: string;
  tenantId: string;
  createdAt: number;
}

export interface AnyRouterConnectedInfo {
  tenantId: string;
  vaultId: string;
  credentialId: string;
  apiKey: string;
}

export interface AnyRouterConnectHooks {
  /** Fired right after a new key is persisted, so the caller can hot-swap an
   *  in-process model-provider cache. Best-effort: hook failures are logged
   *  but never fail the OAuth callback response. */
  onConnected?: (info: AnyRouterConnectedInfo) => void | Promise<void>;
  onDisconnected?: (tenantId: string) => void | Promise<void>;
}

export interface AnyRouterRoutesDeps {
  services: RouteServicesArg;
  /** Public origin this OMA deployment is reachable at, e.g.
   *  "https://oma.example.com" (no trailing slash). Used to build the fixed
   *  OAuth redirect_uri registered with AnyRouter — must be HTTPS, or
   *  http+loopback per AnyRouter's redirect_uri validator. */
  publicOrigin: string;
  /** Where to send the browser after connect/disconnect completes, e.g. a
   *  Console URL such as "https://console.example.com/model_cards". */
  returnUrl: string;
  hooks?: AnyRouterConnectHooks;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

export function buildAnyRouterRoutes(deps: AnyRouterRoutesDeps) {
  const app = new Hono<Vars>();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const redirectUri = `${deps.publicOrigin.replace(/\/+$/, "")}/v1/providers/anyrouter/callback`;

  async function ensureClient(kv: KvStore): Promise<StoredClient> {
    const cached = await kv.get(KV_CLIENT_KEY);
    if (cached) {
      const parsed = JSON.parse(cached) as StoredClient;
      if (parsed.clientId && parsed.redirectUri === redirectUri) return parsed;
    }
    const req = buildRegisterRequest({ clientName: CLIENT_NAME, redirectUris: [redirectUri] });
    const res = await fetchImpl(req.url, { method: req.method, headers: req.headers, body: req.body });
    const body = await res.text();
    if (!res.ok) {
      throw new Error(`AnyRouter client registration failed: HTTP ${res.status} ${body.slice(0, 200)}`);
    }
    const client = parseRegisterResponse(body);
    const stored: StoredClient = { clientId: client.clientId, redirectUri };
    await kv.put(KV_CLIENT_KEY, JSON.stringify(stored));
    return stored;
  }

  async function ensureVault(services: RouteServices, tenantId: string): Promise<string> {
    const vaults = await services.vaults.list({ tenantId, includeArchived: false });
    const existing = vaults.find((v) => v.name === VAULT_NAME);
    if (existing) return existing.id;
    const created = await services.vaults.create({ tenantId, name: VAULT_NAME });
    return created.id;
  }

  /** Scan every vault for an active `provider: "anyrouter"` credential. Node
   *  self-host tenants have a small number of vaults, so an N+1 list is
   *  cheap; revisit with a dedicated lookup if that stops being true. */
  async function findCredential(
    services: RouteServices,
    tenantId: string,
  ): Promise<{ vaultId: string; credentialId: string; token: string; createdAt: string } | null> {
    const vaults = await services.vaults.list({ tenantId, includeArchived: false });
    for (const v of vaults) {
      const creds = await services.credentials.list({ tenantId, vaultId: v.id, includeArchived: false });
      const hit = creds.find((c) => c.auth?.provider === "anyrouter" && !c.archived_at);
      if (hit?.auth.token) {
        return { vaultId: v.id, credentialId: hit.id, token: hit.auth.token, createdAt: hit.created_at };
      }
    }
    return null;
  }

  /** Best-effort pick of a target `provider/model` for a freshly-created
   *  card: validates DEFAULT_TARGET_MODEL against the live catalog and
   *  falls back to the catalog's first entry when it's missing, or the
   *  literal default when the catalog probe itself fails. Never throws —
   *  a broken catalog fetch must not block the connect flow. */
  async function pickDefaultTargetModel(apiKey: string): Promise<string> {
    try {
      const req = buildModelsRequest(apiKey);
      const res = await fetchImpl(req.url, { headers: req.headers });
      if (!res.ok) return DEFAULT_TARGET_MODEL;
      const models = parseModelsResponse(await res.text());
      if (models.some((m) => m.id === DEFAULT_TARGET_MODEL)) return DEFAULT_TARGET_MODEL;
      return models[0]?.id ?? DEFAULT_TARGET_MODEL;
    } catch {
      return DEFAULT_TARGET_MODEL;
    }
  }

  /** Every model card bound to this tenant's AnyRouter connection — the
   *  auto-minted "anyrouter" card, the starter siblings, and anything the
   *  Console's "Add model" action created. Identified structurally (the
   *  AnyRouter compat + base URL) rather than by a handle whitelist, so a
   *  user-named card still rotates/cleans up with the connection. */
  async function listBoundCards(services: RouteServices, tenantId: string) {
    if (!services.modelCards) return [];
    const all = await services.modelCards.list({ tenantId });
    return all.filter(
      (c) => c.provider === ANYROUTER_API_COMPAT && c.base_url === ANYROUTER_API_BASE,
    );
  }

  /** Rotate the stored key on every bound card. Reconnect is the only
   *  rotation mechanism (the minted token doesn't self-refresh), so a
   *  sibling card left on the old key would silently 401 at agent-run
   *  time. Best-effort per the connect flow's contract. */
  async function rotateBoundCards(
    services: RouteServices,
    tenantId: string,
    apiKey: string,
  ): Promise<void> {
    if (!services.modelCards) return;
    try {
      for (const card of await listBoundCards(services, tenantId)) {
        await services.modelCards.update({ tenantId, cardId: card.id, apiKey });
      }
    } catch (err) {
      services.logger?.warn({ err }, "anyrouter: sibling card key rotation failed");
    }
  }

  /**
   * Upsert the `model_cards` row a connected key binds to. Idempotent on
   * `model_id: "anyrouter"` — a reconnect finds the same row and rotates
   * only `api_key`, leaving `model` (and anything else the Console model
   * picker set) untouched. First connect creates the row with a
   * catalog-validated default target model. No-ops when this deployment
   * has no model-cards store (self-host Node — see module doc comment).
   * Never throws — best-effort, same contract as `hooks.onConnected`.
   */
  async function upsertModelCard(
    services: RouteServices,
    tenantId: string,
    apiKey: string,
  ): Promise<void> {
    if (!services.modelCards) return;
    try {
      const existing = await services.modelCards.findByModelId({
        tenantId,
        modelId: MODEL_CARD_MODEL_ID,
      });
      if (existing) {
        await services.modelCards.update({ tenantId, cardId: existing.id, apiKey });
        return;
      }
      const model = await pickDefaultTargetModel(apiKey);
      await services.modelCards.create({
        tenantId,
        modelId: MODEL_CARD_MODEL_ID,
        provider: ANYROUTER_API_COMPAT,
        model,
        apiKey,
        baseUrl: ANYROUTER_API_BASE,
      });
    } catch (err) {
      services.logger?.warn({ err }, "anyrouter: model card upsert failed");
    }
  }

  /** Mirror of upsertModelCard for disconnect: deletes EVERY bound card
   *  (base card + starter siblings + user-added ones) so a revoked
   *  connection can't keep routing agents through a dead key. They all
   *  share the one revoked key, so keeping them would only leave cards
   *  that 401 at agent-run time. ModelCardService has no soft-delete, so
   *  this is a hard delete — matches the credential side, which is
   *  archived (not deletable) but functionally dead once archived.
   *  No-ops when unwired (Node). */
  async function deleteModelCards(services: RouteServices, tenantId: string): Promise<void> {
    if (!services.modelCards) return;
    try {
      for (const card of await listBoundCards(services, tenantId)) {
        await services.modelCards.delete({ tenantId, cardId: card.id });
      }
    } catch (err) {
      services.logger?.warn({ err }, "anyrouter: model card delete failed");
    }
  }

  // ── Start the flow ─────────────────────────────────────────────────────
  app.get("/connect", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    if (!tenantId) return c.json({ error: "authentication required" }, 401);

    let client: StoredClient;
    try {
      client = await ensureClient(services.kv);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "client registration failed" }, 502);
    }

    const { verifier, challenge } = await generatePkcePair();
    const state = generateState();
    const pending: PendingAuth = { verifier, tenantId, createdAt: Date.now() };
    await services.kv.put(`${KV_PENDING_PREFIX}${state}`, JSON.stringify(pending), {
      expirationTtl: PENDING_TTL_SECONDS,
    });

    const url = buildAuthorizeUrl({
      clientId: client.clientId,
      redirectUri,
      state,
      codeChallenge: challenge,
      scope: ANYROUTER_OAUTH_SCOPE,
    });
    return c.redirect(url, 302);
  });

  // ── AnyRouter's redirect target ─────────────────────────────────────────
  app.get("/callback", async (c) => {
    const services = resolveServices(deps.services, c);
    const fail = (msg: string) =>
      c.redirect(`${deps.returnUrl}?anyrouter_error=${encodeURIComponent(msg)}`, 302);

    const oauthError = c.req.query("error");
    if (oauthError) return fail(oauthError);

    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return fail("missing code or state");

    const pendingRaw = await services.kv.get(`${KV_PENDING_PREFIX}${state}`);
    if (!pendingRaw) return fail("expired or unknown state");
    await services.kv.delete(`${KV_PENDING_PREFIX}${state}`);
    const pending = JSON.parse(pendingRaw) as PendingAuth;

    const clientRaw = await services.kv.get(KV_CLIENT_KEY);
    if (!clientRaw) return fail("no registered oauth client — retry /connect");
    const client = JSON.parse(clientRaw) as StoredClient;

    const tokenReq = buildTokenRequest({
      clientId: client.clientId,
      redirectUri,
      code,
      codeVerifier: pending.verifier,
    });
    const res = await fetchImpl(tokenReq.url, {
      method: tokenReq.method,
      headers: tokenReq.headers,
      body: tokenReq.body,
    });
    const body = await res.text();
    if (!res.ok) return fail(`token exchange failed: HTTP ${res.status}`);

    let token: { accessToken: string };
    try {
      token = parseTokenResponse(body);
    } catch (err) {
      return fail(err instanceof Error ? err.message : "token parse error");
    }

    const vaultId = await ensureVault(services, pending.tenantId);

    // Archive any prior AnyRouter credential in this vault so reconnecting
    // doesn't accumulate stale keys the outbound proxy might still pick up.
    const existing = await services.credentials.list({ tenantId: pending.tenantId, vaultId });
    for (const cred of existing) {
      if (cred.auth?.provider === "anyrouter" && !cred.archived_at) {
        await services.credentials
          .archive({ tenantId: pending.tenantId, vaultId, credentialId: cred.id })
          .catch(() => {});
      }
    }

    const created = await services.credentials.create({
      tenantId: pending.tenantId,
      vaultId,
      displayName: CREDENTIAL_DISPLAY_NAME,
      auth: { type: "static_bearer", token: token.accessToken, provider: "anyrouter" },
    });

    // Bind the connected key to a model card so `{"model": "anyrouter"}`
    // resolves with zero further setup. Best-effort — never fails the
    // callback (mirrors the onConnected hook right below it).
    await upsertModelCard(services, pending.tenantId, token.accessToken);
    // …and rotate the key on every sibling card bound to this connection,
    // so a reconnect doesn't leave "add model" / starter cards on a dead key.
    await rotateBoundCards(services, pending.tenantId, token.accessToken);

    try {
      await deps.hooks?.onConnected?.({
        tenantId: pending.tenantId,
        vaultId,
        credentialId: created.id,
        apiKey: token.accessToken,
      });
    } catch (err) {
      services.logger?.warn({ err }, "anyrouter.onConnected hook failed");
    }

    return c.redirect(`${deps.returnUrl}?anyrouter_connected=1`, 302);
  });

  // ── Status + disconnect ─────────────────────────────────────────────────
  app.get("/status", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    if (!tenantId) return c.json({ error: "authentication required" }, 401);
    const hit = await findCredential(services, tenantId);
    if (!hit) return c.json({ connected: false });
    // Surface the bound card (when this deployment has a model-cards store)
    // so the Console's model picker can show + update the current target
    // model without a second lookup.
    const card = services.modelCards
      ? await services.modelCards.findByModelId({ tenantId, modelId: MODEL_CARD_MODEL_ID })
      : null;
    // Every card bound to this connection, so the Console can list + retarget
    // the siblings ("add model") without a second round-trip. Never carries a
    // key — only the handle + current wire target.
    const bound = await listBoundCards(services, tenantId);
    return c.json({
      connected: true,
      vault_id: hit.vaultId,
      credential_id: hit.credentialId,
      base_url: ANYROUTER_API_BASE,
      compat: ANYROUTER_API_COMPAT,
      connected_at: hit.createdAt,
      ...(card ? { model_card_id: card.id, model: card.model } : {}),
      cards: bound.map((b) => ({
        id: b.id,
        model_id: b.model_id,
        model: b.model,
        is_default: b.is_default,
      })),
    });
  });

  app.post("/disconnect", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    if (!tenantId) return c.json({ error: "authentication required" }, 401);
    const hit = await findCredential(services, tenantId);
    if (!hit) return c.json({ disconnected: false });
    await deleteModelCards(services, tenantId);
    await services.credentials.archive({ tenantId, vaultId: hit.vaultId, credentialId: hit.credentialId });
    try {
      await deps.hooks?.onDisconnected?.(tenantId);
    } catch (err) {
      services.logger?.warn({ err }, "anyrouter.onDisconnected hook failed");
    }
    return c.json({ disconnected: true });
  });

  // ── Starter-agent presets ───────────────────────────────────────────────
  //
  // Provisions the sibling model cards (PRESET_CARDS) a one-click "create
  // starter agents" action binds to. Runs backend-side because it needs the
  // connected key, which never leaves the server — each card stores it
  // through the same encrypted ModelCardService as the base "anyrouter" card.
  // Idempotent, mirroring upsertModelCard: an existing card rotates only its
  // api_key (preserving a `model` the user later retargeted); a fresh one is
  // created at the preset's default target. Returns the resolved card handles
  // so the Console can build the actual agents via its own formToConfig
  // machinery — this route deliberately doesn't create agents itself.
  app.post("/presets", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    if (!tenantId) return c.json({ error: "authentication required" }, 401);

    const hit = await findCredential(services, tenantId);
    if (!hit) return c.json({ error: "connect AnyRouter first", connect_required: true }, 400);

    // Self-host Node has no model-cards store, so preset handles wouldn't
    // resolve at agent-run time — surface that instead of minting nothing.
    if (!services.modelCards) {
      return c.json(
        { error: "model cards unavailable on this deployment", model_cards_unavailable: true },
        501,
      );
    }

    const cards: { model_id: string; model: string; role: string; label: string }[] = [];
    for (const p of PRESET_CARDS) {
      const existing = await services.modelCards.findByModelId({ tenantId, modelId: p.modelId });
      if (existing) {
        await services.modelCards.update({ tenantId, cardId: existing.id, apiKey: hit.token });
        cards.push({ model_id: p.modelId, model: existing.model, role: p.role, label: p.label });
      } else {
        await services.modelCards.create({
          tenantId,
          modelId: p.modelId,
          provider: ANYROUTER_API_COMPAT,
          model: p.model,
          apiKey: hit.token,
          baseUrl: ANYROUTER_API_BASE,
        });
        cards.push({ model_id: p.modelId, model: p.model, role: p.role, label: p.label });
      }
    }
    return c.json({ cards });
  });

  // ── Additional model cards on the connected key ─────────────────────────
  //
  // "Add model": mint another `model_cards` row pointing at a different
  // AnyRouter catalog model, reusing the SAME stored key. Runs backend-side
  // for the same reason /presets does — the key never leaves the server, so
  // the Console can't create such a card through the generic
  // `POST /v1/model_cards` route (it has no key to send). Retargeting or
  // deleting an existing card is plain `POST/DELETE /v1/model_cards/:id`;
  // neither needs the key, so they stay on the generic route.
  app.post("/cards", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    if (!tenantId) return c.json({ error: "authentication required" }, 401);

    const body = await c.req
      .json<{ model_id?: string; model?: string }>()
      .catch(() => ({}) as { model_id?: string; model?: string });
    const modelId = body.model_id?.trim();
    const model = body.model?.trim();
    if (!modelId || !model) return c.json({ error: "model_id and model are required" }, 400);

    const hit = await findCredential(services, tenantId);
    if (!hit) return c.json({ error: "connect AnyRouter first", connect_required: true }, 400);

    if (!services.modelCards) {
      return c.json(
        { error: "model cards unavailable on this deployment", model_cards_unavailable: true },
        501,
      );
    }

    const existing = await services.modelCards.findByModelId({ tenantId, modelId });
    if (existing) return c.json({ error: `model card "${modelId}" already exists` }, 409);

    const card = await services.modelCards.create({
      tenantId,
      modelId,
      provider: ANYROUTER_API_COMPAT,
      model,
      apiKey: hit.token,
      baseUrl: ANYROUTER_API_BASE,
    });
    return c.json({ id: card.id, model_id: card.model_id, model: card.model }, 201);
  });

  // ── Model catalog (for a model picker) ──────────────────────────────────
  //
  // Cache strategy: models are shared globally (the upstream catalog is the
  // same for every account), presets are per-tenant (each AnyRouter user
  // curates their own saved presets). Splitting them avoids leaking one
  // tenant's presets into another's picker while still letting the catalog
  // ride a single global hourly fetch across the whole deployment.
  app.get("/models", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    if (!tenantId) return c.json({ error: "authentication required" }, 401);

    const now = Date.now();

    // ── Read both caches ──────────────────────────────────────────────────
    const cachedModelsRaw = await services.kv.get(KV_MODELS_CACHE_KEY);
    const presetsCacheKey = `${KV_PRESETS_CACHE_PREFIX}${tenantId}`;
    const cachedPresetsRaw = await services.kv.get(presetsCacheKey);

    const cachedModels = cachedModelsRaw
      ? (JSON.parse(cachedModelsRaw) as { fetchedAt: number; models: AnyRouterModel[] })
      : null;
    const cachedPresets = cachedPresetsRaw
      ? (JSON.parse(cachedPresetsRaw) as { fetchedAt: number; presets: AnyRouterPreset[] })
      : null;

    const modelsFresh = cachedModels && now - cachedModels.fetchedAt < MODELS_CACHE_TTL_MS;
    const presetsFresh = cachedPresets && now - cachedPresets.fetchedAt < PRESETS_CACHE_TTL_MS;

    if (modelsFresh && presetsFresh) {
      return c.json({
        data: cachedModels.models,
        presets: cachedPresets.presets,
        cached: true,
      });
    }

    const hit = await findCredential(services, tenantId);
    if (!hit) return c.json({ data: [], connect_required: true });

    const req = buildModelsRequest(hit.token);
    const res = await fetchImpl(req.url, { headers: req.headers });
    if (!res.ok) return c.json({ data: [], error: `HTTP ${res.status}` }, 502);
    // AnyRouter's authenticated /models response carries both the catalog
    // (`data`) and the account's saved presets (`presets`) — cache them into
    // their respective stores off one read of the body.
    const body = await res.text();
    const models = parseModelsResponse(body);
    const presets = parsePresetsResponse(body);

    await services.kv.put(KV_MODELS_CACHE_KEY, JSON.stringify({ fetchedAt: now, models }));
    await services.kv.put(presetsCacheKey, JSON.stringify({ fetchedAt: now, presets }));

    return c.json({ data: models, presets });
  });

  // ── Credit balance ──────────────────────────────────────────────────────
  app.get("/credits", async (c) => {
    const services = resolveServices(deps.services, c);
    const tenantId = c.var.tenant_id;
    if (!tenantId) return c.json({ error: "authentication required" }, 401);

    const cacheKey = `${KV_CREDITS_CACHE_PREFIX}${tenantId}`;
    const cached = await services.kv.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached) as { fetchedAt: number; credits: Record<string, unknown> };
      if (Date.now() - parsed.fetchedAt < CREDITS_CACHE_TTL_MS) {
        return c.json({ ...parsed.credits, cached: true });
      }
    }

    const hit = await findCredential(services, tenantId);
    if (!hit) return c.json({ connect_required: true });

    const res = await fetchImpl(`${ANYROUTER_API_BASE}/credits`, {
      headers: { authorization: `Bearer ${hit.token}` },
    });
    if (!res.ok) return c.json({ error: `AnyRouter credits fetch failed: HTTP ${res.status}` }, 502);

    const raw = JSON.parse(await res.text()) as Record<string, unknown>;
    const credits = {
      balance: raw.balance,
      monthly_balance: raw.monthly_balance,
      topup_balance: raw.topup_balance,
      used: raw.used,
      today_cost: raw.today_cost,
      currency: raw.currency,
    };
    await services.kv.put(cacheKey, JSON.stringify({ fetchedAt: Date.now(), credits }));
    return c.json(credits);
  });

  return app;
}

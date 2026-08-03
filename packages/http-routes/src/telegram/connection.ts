/**
 * Per-tenant Telegram connection (Console → Integrations → Telegram).
 *
 * Two modes, mirroring GitHub's managed-App vs own-App duality:
 *
 *  - `shared_bot` — the deployment owns ONE bot ("omatherobot") whose token
 *    comes from the `TELEGRAM_SHARED_BOT_TOKEN` env secret. Connecting links
 *    the tenant to that bot; the token is never stored, never returned, and
 *    never leaves the host.
 *  - `own_bot` — the tenant pastes a BotFather token. It is validated with
 *    `getMe` and stored AES-256-GCM-encrypted at rest under
 *    TELEGRAM_CRYPTO_LABEL (the same PLATFORM_ROOT_SECRET machinery the vault
 *    and the federation registry use). Reads surface `has_token` + the bot
 *    username only.
 *
 * Chat capture uses Telegram's standard deep-link handshake: the row carries
 * a short-lived per-tenant nonce, the Console shows
 * `https://t.me/<bot>?start=<nonce>` (and `?startgroup=<nonce>` for groups),
 * and tapping it makes Telegram deliver `/start <nonce>` from the user's chat.
 * `POST /link/poll` reads that back via `getUpdates` and records the
 * `chat_id`. `getUpdates` is refused by Telegram (409) while a webhook is
 * registered for the same bot, so that failure is surfaced verbatim and the
 * manual `POST /chats` entry point stays available as the fallback.
 *
 * Storage follows the federation registry: one KV row per tenant
 * (`telegram_conn:<tenant>`), so this mounts identically on Cloudflare and
 * self-host Node with no migration.
 */

import { Hono } from "hono";
import type { CredentialBlobCrypto } from "@duyet/oma-shared";
import { TelegramClient, TelegramApiError } from "@duyet/oma-telegram";
import type { RouteServicesArg } from "../types";
import { resolveServices } from "../types";

interface Vars {
  Variables: { tenant_id: string };
}

export type TelegramConnectionMode = "shared_bot" | "own_bot";

export interface TelegramLinkedChat {
  chat_id: number;
  /** Chat title (groups) or the user's display name (private chats). */
  title?: string;
  type?: string;
  linked_at: number;
}

export interface TelegramConnectionRow {
  tenant_id: string;
  mode: TelegramConnectionMode;
  bot_username: string;
  bot_id: number;
  /** Only ever set for `own_bot` — AES-256-GCM ciphertext. */
  bot_token_enc?: string;
  chats: TelegramLinkedChat[];
  /** Deep-link handshake nonce + expiry. Absent once consumed/expired. */
  link_nonce?: string;
  link_nonce_expires_at?: number;
  /** getUpdates cursor so a poll never re-reads consumed updates. */
  updates_offset?: number;
  created_at: number;
  updated_at: number;
}

export function telegramConnectionKvKey(tenantId: string): string {
  return `telegram_conn:${tenantId}`;
}

const NONCE_TTL_MS = 15 * 60 * 1000;

function mintNonce(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 24);
}

function deepLinks(row: TelegramConnectionRow) {
  if (!row.link_nonce) return { start_url: null, start_group_url: null };
  return {
    start_url: `https://t.me/${row.bot_username}?start=${row.link_nonce}`,
    start_group_url: `https://t.me/${row.bot_username}?startgroup=${row.link_nonce}`,
  };
}

function toApiShape(row: TelegramConnectionRow) {
  const now = Date.now();
  const nonceLive = Boolean(row.link_nonce_expires_at && row.link_nonce_expires_at > now);
  return {
    connected: true,
    mode: row.mode,
    bot_username: row.bot_username,
    bot_id: row.bot_id,
    has_token: row.mode === "own_bot" ? Boolean(row.bot_token_enc) : false,
    chats: row.chats,
    link_expires_at: nonceLive ? row.link_nonce_expires_at : null,
    ...(nonceLive ? deepLinks(row) : { start_url: null, start_group_url: null }),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export interface TelegramConnectionRoutesDeps {
  services: RouteServicesArg;
  /** At-rest crypto for an own-bot token, built from PLATFORM_ROOT_SECRET
   *  under TELEGRAM_CRYPTO_LABEL. Absent ⇒ own-bot connects are refused
   *  (503) rather than storing a token in the clear. */
  crypto?:
    | CredentialBlobCrypto
    | ((c: import("hono").Context) => CredentialBlobCrypto | undefined);
  /** The deployment's shared bot token (`TELEGRAM_SHARED_BOT_TOKEN`).
   *  Absent ⇒ shared mode is unavailable and says so. */
  sharedBotToken?: string | ((c: import("hono").Context) => string | undefined);
  /** Injectable Telegram client factory — tests swap in a fake. */
  makeClient?: (token: string) => Pick<TelegramClient, "getMe" | "getUpdates">;
}

function resolveDep<T>(
  dep: T | ((c: import("hono").Context) => T | undefined) | undefined,
  c: import("hono").Context,
): T | undefined {
  return typeof dep === "function"
    ? (dep as (c: import("hono").Context) => T | undefined)(c)
    : dep;
}

function telegramErrorResponse(err: unknown): { message: string; status: 400 | 409 | 502 } {
  if (err instanceof TelegramApiError) {
    // 409 = "can't use getUpdates while webhook is active".
    if (err.errorCode === 409) return { message: err.telegramError, status: 409 };
    if (err.errorCode === 401) return { message: "bot token rejected by Telegram", status: 400 };
    return { message: err.telegramError, status: 502 };
  }
  return { message: err instanceof Error ? err.message : String(err), status: 502 };
}

export function buildTelegramConnectionRoutes(deps: TelegramConnectionRoutesDeps) {
  const app = new Hono<Vars>();
  const makeClient =
    deps.makeClient ?? ((token: string) => new TelegramClient(token));

  const loadRow = async (
    c: import("hono").Context,
    tenantId: string,
  ): Promise<TelegramConnectionRow | null> => {
    const kv = resolveServices(deps.services, c).kv;
    const raw = await kv.get(telegramConnectionKvKey(tenantId));
    return raw ? (JSON.parse(raw) as TelegramConnectionRow) : null;
  };

  const saveRow = async (c: import("hono").Context, row: TelegramConnectionRow) => {
    const kv = resolveServices(deps.services, c).kv;
    await kv.put(telegramConnectionKvKey(row.tenant_id), JSON.stringify(row));
  };

  /** The token this tenant's connection speaks to Telegram with. */
  const resolveToken = async (
    c: import("hono").Context,
    row: TelegramConnectionRow,
  ): Promise<string | null> => {
    if (row.mode === "shared_bot") return resolveDep(deps.sharedBotToken, c) ?? null;
    const keyCrypto = resolveDep(deps.crypto, c);
    if (!row.bot_token_enc || !keyCrypto) return null;
    return keyCrypto.decrypt(row.bot_token_enc);
  };

  // GET / — connection status. Never 404s: an unconnected tenant is a normal
  // state the Console renders as the connect form.
  app.get("/", async (c) => {
    const row = await loadRow(c, c.get("tenant_id"));
    const sharedAvailable = Boolean(resolveDep(deps.sharedBotToken, c));
    if (!row) {
      return c.json({
        connected: false,
        mode: null,
        shared_bot_available: sharedAvailable,
        chats: [],
      });
    }
    return c.json({ ...toApiShape(row), shared_bot_available: sharedAvailable });
  });

  // POST /connect — { mode: "shared_bot" } | { mode: "own_bot", bot_token }
  app.post("/connect", async (c) => {
    const tenantId = c.get("tenant_id");
    const body = (await c.req.json().catch(() => null)) as
      | { mode?: string; bot_token?: string }
      | null;
    const mode = body?.mode;
    if (mode !== "shared_bot" && mode !== "own_bot") {
      return c.json({ error: 'mode must be "shared_bot" or "own_bot"' }, 422);
    }

    let token: string;
    let tokenEnc: string | undefined;
    if (mode === "shared_bot") {
      const shared = resolveDep(deps.sharedBotToken, c);
      if (!shared) {
        return c.json(
          { error: "shared bot unavailable — TELEGRAM_SHARED_BOT_TOKEN is not configured" },
          503,
        );
      }
      token = shared;
    } else {
      if (typeof body?.bot_token !== "string" || body.bot_token.trim().length === 0) {
        return c.json({ error: "bot_token is required for mode=own_bot" }, 422);
      }
      const keyCrypto = resolveDep(deps.crypto, c);
      if (!keyCrypto) {
        return c.json(
          { error: "server cannot encrypt bot_token (PLATFORM_ROOT_SECRET unset)" },
          503,
        );
      }
      token = body.bot_token.trim();
      tokenEnc = await keyCrypto.encrypt(token);
    }

    let me: { id: number; username?: string };
    try {
      me = await makeClient(token).getMe();
    } catch (err) {
      const { message, status } = telegramErrorResponse(err);
      return c.json({ error: message }, status);
    }
    if (!me.username) {
      return c.json({ error: "bot has no username — recreate it with @BotFather" }, 400);
    }

    const now = Date.now();
    const existing = await loadRow(c, tenantId);
    const row: TelegramConnectionRow = {
      tenant_id: tenantId,
      mode,
      bot_username: me.username,
      bot_id: me.id,
      bot_token_enc: tokenEnc,
      // Switching bots invalidates previously linked chats — they belong to
      // the old bot and would silently never receive anything.
      chats: existing && existing.bot_id === me.id ? existing.chats : [],
      link_nonce: mintNonce(),
      link_nonce_expires_at: now + NONCE_TTL_MS,
      updates_offset: existing && existing.bot_id === me.id ? existing.updates_offset : undefined,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    };
    await saveRow(c, row);
    const shape = toApiShape(row);
    // Defense in depth: the plaintext token must never reach a response.
    return c.json(shape, existing ? 200 : 201);
  });

  // POST /link — mint a fresh deep-link nonce (the previous one expires).
  app.post("/link", async (c) => {
    const row = await loadRow(c, c.get("tenant_id"));
    if (!row) return c.json({ error: "telegram not connected" }, 404);
    row.link_nonce = mintNonce();
    row.link_nonce_expires_at = Date.now() + NONCE_TTL_MS;
    row.updated_at = Date.now();
    await saveRow(c, row);
    return c.json(toApiShape(row));
  });

  // POST /link/poll — consume pending updates and link any chat that sent
  // `/start <nonce>`.
  app.post("/link/poll", async (c) => {
    const row = await loadRow(c, c.get("tenant_id"));
    if (!row) return c.json({ error: "telegram not connected" }, 404);
    if (!row.link_nonce || (row.link_nonce_expires_at ?? 0) <= Date.now()) {
      return c.json({ error: "link expired — generate a new link" }, 409);
    }
    const token = await resolveToken(c, row);
    if (!token) return c.json({ error: "bot token unavailable for this connection" }, 503);

    let updates: Awaited<ReturnType<TelegramClient["getUpdates"]>>;
    try {
      updates = await makeClient(token).getUpdates({
        offset: row.updates_offset,
        limit: 100,
        allowed_updates: ["message"],
      });
    } catch (err) {
      const { message, status } = telegramErrorResponse(err);
      return c.json({ error: message }, status);
    }

    let linked = 0;
    for (const update of updates) {
      row.updates_offset = update.update_id + 1;
      const msg = update.message;
      const text = msg?.text;
      if (!msg || !text) continue;
      // `/start <nonce>` in private chats, `/start@bot <nonce>` in groups.
      const m = /^\/start(?:@\S+)?\s+(\S+)$/.exec(text.trim());
      if (!m || m[1] !== row.link_nonce) continue;
      if (row.chats.some((ch) => ch.chat_id === msg.chat.id)) continue;
      row.chats.push({
        chat_id: msg.chat.id,
        title: msg.chat.title ?? msg.from?.first_name,
        type: msg.chat.type,
        linked_at: Date.now(),
      });
      linked += 1;
    }
    row.updated_at = Date.now();
    await saveRow(c, row);
    return c.json({ ...toApiShape(row), linked });
  });

  // POST /chats — manual chat_id entry. The fallback for a bot whose updates
  // are already claimed by a registered webhook (getUpdates 409s there).
  app.post("/chats", async (c) => {
    const row = await loadRow(c, c.get("tenant_id"));
    if (!row) return c.json({ error: "telegram not connected" }, 404);
    const body = (await c.req.json().catch(() => null)) as
      | { chat_id?: unknown; title?: unknown }
      | null;
    const chatId =
      typeof body?.chat_id === "number"
        ? body.chat_id
        : typeof body?.chat_id === "string" && /^-?\d+$/.test(body.chat_id)
          ? Number(body.chat_id)
          : null;
    if (chatId === null) return c.json({ error: "chat_id must be an integer" }, 422);
    if (!row.chats.some((ch) => ch.chat_id === chatId)) {
      row.chats.push({
        chat_id: chatId,
        title: typeof body?.title === "string" ? body.title : undefined,
        linked_at: Date.now(),
      });
      row.updated_at = Date.now();
      await saveRow(c, row);
    }
    return c.json(toApiShape(row), 201);
  });

  // DELETE /chats/:chatId — unlink one chat.
  app.delete("/chats/:chatId", async (c) => {
    const row = await loadRow(c, c.get("tenant_id"));
    if (!row) return c.json({ error: "telegram not connected" }, 404);
    const chatId = Number(c.req.param("chatId"));
    if (!Number.isInteger(chatId)) return c.json({ error: "chat_id must be an integer" }, 422);
    row.chats = row.chats.filter((ch) => ch.chat_id !== chatId);
    row.updated_at = Date.now();
    await saveRow(c, row);
    return c.json(toApiShape(row));
  });

  // DELETE / — disconnect, dropping the stored token with the row.
  app.delete("/", async (c) => {
    const tenantId = c.get("tenant_id");
    const kv = resolveServices(deps.services, c).kv;
    await kv.delete(telegramConnectionKvKey(tenantId));
    return c.body(null, 204);
  });

  return app;
}

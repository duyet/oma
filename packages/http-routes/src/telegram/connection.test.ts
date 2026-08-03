// @ts-nocheck
// Route tests for the per-tenant Telegram connection. Same in-memory-KV
// harness the federation registry tests use, so this exercises exactly what
// apps/main and apps/main-node mount. The Telegram client is faked — no
// network, and the fake asserts which token each call was made with.

import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { buildTelegramConnectionRoutes, telegramConnectionKvKey } from "./connection";
import { InMemoryKvStore } from "@duyet/oma-kv-store";
import { buildLabeledCrypto, TELEGRAM_CRYPTO_LABEL } from "@duyet/oma-shared";
import { TelegramApiError } from "@duyet/oma-telegram";
import type { RouteServices } from "../types";

const TENANT = "tn_test";
const SHARED_TOKEN = "111:shared-bot-token";
const OWN_TOKEN = "222:own-bot-token";
const crypto = buildLabeledCrypto("root-secret-for-tests", TELEGRAM_CRYPTO_LABEL);

interface FakeState {
  tokensSeen: string[];
  updates: unknown[];
  getMeError?: unknown;
  getUpdatesError?: unknown;
}

function makeApp(
  kv: InMemoryKvStore,
  state: FakeState,
  opts: { sharedBotToken?: string; crypto?: unknown } = {},
) {
  const app = new Hono<{ Variables: { tenant_id: string } }>();
  app.use("*", async (c, next) => {
    c.set("tenant_id", TENANT);
    await next();
  });
  app.route(
    "/",
    buildTelegramConnectionRoutes({
      services: { kv } as unknown as RouteServices,
      crypto: "crypto" in opts ? opts.crypto : crypto,
      sharedBotToken: "sharedBotToken" in opts ? opts.sharedBotToken : SHARED_TOKEN,
      makeClient: (token: string) => {
        state.tokensSeen.push(token);
        return {
          async getMe() {
            if (state.getMeError) throw state.getMeError;
            return token === SHARED_TOKEN
              ? { id: 111, is_bot: true, first_name: "OMA", username: "omatherobot" }
              : { id: 222, is_bot: true, first_name: "Mine", username: "my_own_bot" };
          },
          async getUpdates() {
            if (state.getUpdatesError) throw state.getUpdatesError;
            return state.updates;
          },
        };
      },
    }),
  );
  return app;
}

const post = (app: Hono, path: string, body?: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

describe("telegram connection routes", () => {
  let kv: InMemoryKvStore;
  let state: FakeState;
  let app: Hono;

  beforeEach(() => {
    kv = new InMemoryKvStore();
    state = { tokensSeen: [], updates: [] };
    app = makeApp(kv, state);
  });

  it("reports an unconnected tenant without 404ing", async () => {
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.connected).toBe(false);
    expect(json.shared_bot_available).toBe(true);
    expect(json.chats).toEqual([]);
    // Named before connecting, so the user knows which bot to message.
    expect(json.shared_bot_username).toBe("omatherobot");
  });

  it("caches the shared bot identity instead of calling getMe on every status read", async () => {
    await app.request("/");
    const afterFirst = state.tokensSeen.length;
    const res = await app.request("/");
    expect((await res.json()).shared_bot_username).toBe("omatherobot");
    expect(state.tokensSeen.length).toBe(afterFirst);
  });

  it("still answers status when Telegram won't name the shared bot", async () => {
    state.getMeError = new Error("telegram down");
    const res = await app.request("/");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.shared_bot_available).toBe(true);
    expect(json.shared_bot_username).toBeNull();
  });

  it("connects to the shared bot without ever storing or echoing its token", async () => {
    const res = await post(app, "/connect", { mode: "shared_bot" });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.mode).toBe("shared_bot");
    expect(json.bot_username).toBe("omatherobot");
    expect(json.has_token).toBe(false);
    expect(json.start_url).toMatch(/^https:\/\/t\.me\/omatherobot\?start=[0-9a-f]{24}$/);
    expect(json.start_group_url).toContain("?startgroup=");
    expect(JSON.stringify(json)).not.toContain(SHARED_TOKEN);
    // The shared token belongs to the deployment, never to the tenant row.
    const raw = await kv.get(telegramConnectionKvKey(TENANT));
    expect(raw).not.toContain(SHARED_TOKEN);
    expect(JSON.parse(raw).bot_token_enc).toBeUndefined();
  });

  it("refuses shared mode when the deployment has no shared bot token", async () => {
    const bare = makeApp(kv, state, { sharedBotToken: undefined });
    const res = await post(bare, "/connect", { mode: "shared_bot" });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("TELEGRAM_SHARED_BOT_TOKEN");
    expect((await (await bare.request("/")).json()).shared_bot_available).toBe(false);
  });

  it("stores an own-bot token encrypted and never echoes it", async () => {
    const res = await post(app, "/connect", { mode: "own_bot", bot_token: OWN_TOKEN });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.mode).toBe("own_bot");
    expect(json.bot_username).toBe("my_own_bot");
    expect(json.has_token).toBe(true);
    expect(JSON.stringify(json)).not.toContain(OWN_TOKEN);

    const raw = await kv.get(telegramConnectionKvKey(TENANT));
    expect(raw).not.toContain(OWN_TOKEN);
    const row = JSON.parse(raw);
    expect(await crypto.decrypt(row.bot_token_enc)).toBe(OWN_TOKEN);
  });

  it("refuses an own-bot connect when the platform cannot encrypt", async () => {
    const noCrypto = makeApp(kv, state, { crypto: undefined });
    const res = await post(noCrypto, "/connect", { mode: "own_bot", bot_token: OWN_TOKEN });
    expect(res.status).toBe(503);
    expect(await kv.get(telegramConnectionKvKey(TENANT))).toBeNull();
  });

  it("surfaces a Telegram-rejected token as a 400 instead of connecting", async () => {
    state.getMeError = new TelegramApiError("getMe", "Unauthorized", 401, 401);
    const res = await post(app, "/connect", { mode: "own_bot", bot_token: "bad" });
    expect(res.status).toBe(400);
    expect(await kv.get(telegramConnectionKvKey(TENANT))).toBeNull();
  });

  it("links the chat that sent /start with the current nonce", async () => {
    const connected = await (await post(app, "/connect", { mode: "shared_bot" })).json();
    const nonce = new URL(connected.start_url).searchParams.get("start");
    state.updates = [
      { update_id: 1, message: { message_id: 1, chat: { id: 555, type: "private" }, from: { first_name: "Duyet" }, date: 0, text: `/start ${nonce}` } },
      { update_id: 2, message: { message_id: 2, chat: { id: 999, type: "group", title: "Ops" }, date: 0, text: "/start wrong-nonce" } },
    ];
    const res = await post(app, "/link/poll");
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.linked).toBe(1);
    expect(json.chats).toEqual([
      expect.objectContaining({ chat_id: 555, type: "private", title: "Duyet" }),
    ]);
    // Polls use the shared token, not a tenant-stored one.
    expect(state.tokensSeen).toContain(SHARED_TOKEN);
    // The offset advances past every update seen, matched or not.
    expect(JSON.parse(await kv.get(telegramConnectionKvKey(TENANT))).updates_offset).toBe(3);
  });

  it("links a group chat that sent /start@bot <nonce>", async () => {
    const connected = await (await post(app, "/connect", { mode: "shared_bot" })).json();
    const nonce = new URL(connected.start_url).searchParams.get("start");
    state.updates = [
      { update_id: 7, message: { message_id: 1, chat: { id: -100123, type: "supergroup", title: "Ops" }, date: 0, text: `/start@omatherobot ${nonce}` } },
    ];
    const json = await (await post(app, "/link/poll")).json();
    expect(json.chats).toEqual([expect.objectContaining({ chat_id: -100123, title: "Ops" })]);
  });

  it("surfaces Telegram's webhook conflict on poll rather than reporting no updates", async () => {
    await post(app, "/connect", { mode: "shared_bot" });
    state.getUpdatesError = new TelegramApiError(
      "getUpdates",
      "Conflict: can't use getUpdates method while webhook is active",
      409,
      409,
    );
    const res = await post(app, "/link/poll");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("webhook is active");
  });

  it("decrypts the own-bot token to poll", async () => {
    await post(app, "/connect", { mode: "own_bot", bot_token: OWN_TOKEN });
    state.tokensSeen = [];
    await post(app, "/link/poll");
    expect(state.tokensSeen).toEqual([OWN_TOKEN]);
  });

  it("accepts a manually entered chat id and unlinks it again", async () => {
    await post(app, "/connect", { mode: "shared_bot" });
    const created = await post(app, "/chats", { chat_id: "-100999", title: "Manual" });
    expect(created.status).toBe(201);
    expect((await created.json()).chats).toEqual([
      expect.objectContaining({ chat_id: -100999, title: "Manual" }),
    ]);
    const removed = await app.request("/chats/-100999", { method: "DELETE" });
    expect((await removed.json()).chats).toEqual([]);
  });

  it("drops previously linked chats when the tenant switches bots", async () => {
    await post(app, "/connect", { mode: "shared_bot" });
    await post(app, "/chats", { chat_id: 42 });
    const switched = await (
      await post(app, "/connect", { mode: "own_bot", bot_token: OWN_TOKEN })
    ).json();
    expect(switched.chats).toEqual([]);
  });

  it("disconnect removes the row and its stored token", async () => {
    await post(app, "/connect", { mode: "own_bot", bot_token: OWN_TOKEN });
    const res = await app.request("/", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await kv.get(telegramConnectionKvKey(TENANT))).toBeNull();
    expect((await (await app.request("/")).json()).connected).toBe(false);
  });

  it("refuses a poll once the link nonce has expired", async () => {
    await post(app, "/connect", { mode: "shared_bot" });
    const row = JSON.parse(await kv.get(telegramConnectionKvKey(TENANT)));
    row.link_nonce_expires_at = Date.now() - 1;
    await kv.put(telegramConnectionKvKey(TENANT), JSON.stringify(row));
    const res = await post(app, "/link/poll");
    expect(res.status).toBe(409);
    // ...and a fresh link makes it pollable again.
    expect((await post(app, "/link")).status).toBe(200);
    expect((await post(app, "/link/poll")).status).toBe(200);
  });
});

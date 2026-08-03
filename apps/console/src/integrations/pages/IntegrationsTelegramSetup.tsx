import { useCallback, useEffect, useState } from "react";
import {
  IntegrationSetupCard,
  CopyableCommand,
} from "../components/IntegrationSetupCard";
import { IntegrationsApi } from "../api/client";
import type { TelegramConnection } from "../api/types";
import { SecretInput, TextInput } from "../../components/Input";

const api = new IntegrationsApi();

// Telegram connects per-tenant in one of two modes, mirroring GitHub's
// managed-App vs own-App duality:
//
//   shared_bot — the deployment's own bot. Its token lives in the
//     TELEGRAM_SHARED_BOT_TOKEN env secret and is never stored per tenant.
//   own_bot    — a BotFather token the tenant pastes. Validated with getMe
//     and stored encrypted at rest; the Console only ever sees `has_token`.
//
// Either way chats are captured with Telegram's deep-link handshake: the
// backend mints a short-lived nonce, we render t.me/<bot>?start=<nonce>, and
// "I've messaged the bot" polls getUpdates for the resulting `/start <nonce>`.
// A bot that already has a webhook registered can't be polled (Telegram 409s)
// — that's what the manual chat-id field is for.

const BTN_PRIMARY =
  "px-4 py-2 rounded-md bg-brand text-brand-fg text-[14px] font-medium disabled:opacity-50";
const BTN_SECONDARY =
  "px-3 py-1.5 rounded-md border border-border text-[13px] text-fg hover:bg-bg-surface disabled:opacity-50";

export function IntegrationsTelegramSetup() {
  const [conn, setConn] = useState<TelegramConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [ownToken, setOwnToken] = useState("");
  const [manualChatId, setManualChatId] = useState("");

  const refresh = useCallback(async () => {
    try {
      setConn(await api.telegram.status());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Every mutation shares the same envelope: clear banners, disable the
  // buttons, replace the connection from the response.
  async function run(fn: () => Promise<TelegramConnection | void>, done?: string) {
    setError(null);
    setNotice(null);
    setWorking(true);
    try {
      const next = await fn();
      if (next) setConn(next);
      else await refresh();
      if (done) setNotice(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setWorking(false);
    }
  }

  const connected = Boolean(conn?.connected);
  const sharedAvailable = conn?.shared_bot_available ?? false;
  const chatCount = conn?.chats.length ?? 0;

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[820px] mx-auto px-4 sm:px-8 lg:px-10 py-10 lg:py-12">
        <header className="mb-8">
          <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg">
            Telegram integration
          </h1>
          <p className="mt-1.5 text-[14px] text-fg-muted max-w-xl">
            Talk to one of your agents from a Telegram chat, and send agent
            notifications to a chat you own. Connect the shared OMA bot, or
            bring your own bot from @BotFather.
          </p>
        </header>

        {error && (
          <div className="mb-4 rounded-md border border-danger/40 bg-danger-subtle px-3 py-2 text-[13px] text-danger">
            {error}
          </div>
        )}
        {notice && (
          <div className="mb-4 rounded-md border border-border bg-bg-surface px-3 py-2 text-[13px] text-fg-muted">
            {notice}
          </div>
        )}

        <IntegrationSetupCard
          name="Telegram"
          status={connected ? "connected" : sharedAvailable ? "not-connected" : "needs-config"}
          statusDetail={
            connected
              ? `@${conn?.bot_username} · ${chatCount} chat${chatCount === 1 ? "" : "s"}`
              : sharedAvailable
                ? "Shared bot available"
                : "Bring your own bot"
          }
          whatIsThis={
            <>
              A Telegram bot bound to your workspace. Use the shared OMA bot
              (nothing to create, nothing to host) or your own bot for a
              custom name, avatar and full control of its token.
            </>
          }
          requirements={[
            {
              label: "A Telegram account",
              detail: "you'll message the bot once to link your chat",
            },
            {
              label: "A bot token",
              detail: (
                <>
                  only for your own bot — created with{" "}
                  <a
                    className="text-brand underline"
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noreferrer"
                  >
                    @BotFather
                  </a>
                </>
              ),
              optional: true,
            },
          ]}
          steps={[
            {
              title: "Pick a bot",
              body: (
                <>
                  The shared bot is one tap. Your own bot needs a token from{" "}
                  <a
                    className="text-brand underline"
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noreferrer"
                  >
                    @BotFather
                  </a>{" "}
                  (<code className="font-mono text-fg">/newbot</code> → copy{" "}
                  <code className="font-mono text-fg">123456:ABC-DEF…</code>).
                  Tokens are stored encrypted and never shown again.
                </>
              ),
            },
            {
              title: "Open the link and press Start",
              body: (
                <>
                  Telegram delivers{" "}
                  <code className="font-mono text-fg">/start &lt;code&gt;</code>{" "}
                  from that chat, which is how we learn your{" "}
                  <code className="font-mono text-fg">chat_id</code> without you
                  hunting for it. Use the group link to add the bot to a group
                  instead.
                </>
              ),
            },
            {
              title: "Confirm the chat",
              body: (
                <>
                  Press <em>I've messaged the bot</em> and the chat appears
                  below. Paste the id manually if your bot already has a
                  webhook registered — Telegram won't let us poll a bot that
                  does.
                </>
              ),
            },
          ]}
        >
          {loading ? (
            <p className="text-[13px] text-fg-muted">Loading…</p>
          ) : connected && conn ? (
            <ConnectedPanel
              conn={conn}
              working={working}
              manualChatId={manualChatId}
              onManualChatId={setManualChatId}
              onNewLink={() => void run(() => api.telegram.newLink())}
              onPoll={() =>
                void run(async () => {
                  const next = await api.telegram.pollLink();
                  setNotice(
                    next.linked > 0
                      ? `Linked ${next.linked} chat${next.linked === 1 ? "" : "s"}.`
                      : "No new /start yet — open the link and press Start, then try again.",
                  );
                  return next;
                })
              }
              onAddChat={() =>
                void run(async () => {
                  const next = await api.telegram.addChat(manualChatId.trim());
                  setManualChatId("");
                  return next;
                }, "Chat added.")
              }
              onRemoveChat={(chatId) => void run(() => api.telegram.removeChat(chatId))}
              onDisconnect={() =>
                void run(async () => {
                  await api.telegram.disconnect();
                }, "Disconnected.")
              }
            />
          ) : (
            <div className="flex flex-col gap-4">
              <div>
                <button
                  type="button"
                  className={BTN_PRIMARY}
                  disabled={working || !sharedAvailable}
                  onClick={() => void run(() => api.telegram.connect({ mode: "shared_bot" }))}
                >
                  Connect the shared OMA bot
                </button>
                <p className="mt-1.5 text-[12px] text-fg-muted">
                  {sharedAvailable
                    ? "No token to manage — the deployment owns this bot."
                    : "Unavailable: this deployment has no TELEGRAM_SHARED_BOT_TOKEN set."}
                </p>
              </div>
              <form
                className="flex flex-col gap-2 border-t border-border pt-4"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run(() =>
                    api.telegram.connect({ mode: "own_bot", bot_token: ownToken.trim() }),
                  );
                }}
              >
                <label className="text-[13px] font-medium text-fg">
                  …or use your own bot
                </label>
                <SecretInput
                  value={ownToken}
                  onChange={(e) => setOwnToken(e.target.value)}
                  placeholder="123456:ABC-DEF…"
                />
                <div>
                  <button
                    type="submit"
                    className={BTN_PRIMARY}
                    disabled={working || ownToken.trim().length === 0}
                  >
                    Validate &amp; connect
                  </button>
                </div>
              </form>
            </div>
          )}
        </IntegrationSetupCard>

        <div className="mt-8">
          <h2 className="text-[15px] font-semibold text-fg mb-2">
            Routing chats to an agent
          </h2>
          <p className="text-[13px] text-fg-muted">
            Linking a chat above records the{" "}
            <code className="font-mono text-fg">chat_id</code> so it can be used
            as a <code className="font-mono text-fg">telegram_message</code>{" "}
            notify target on an agent or a schedule. Driving a full conversation
            (inbound messages becoming sessions) is still wired at the
            deployment level via the webhook below.
          </p>
          <div className="mt-3 flex flex-col gap-3">
            <CopyableCommand
              label="Bind an agent to inbound chats (Cloudflare, apps/integrations)"
              value={[
                "wrangler secret put TELEGRAM_BOT_TOKEN",
                "wrangler secret put TELEGRAM_AGENT_ID",
                "# optional:",
                "wrangler secret put TELEGRAM_ENVIRONMENT_ID",
                "wrangler secret put TELEGRAM_VAULT_IDS",
              ].join("\n")}
            />
            <CopyableCommand
              label="Register the webhook with Telegram (once per bot)"
              value={
                'curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook?url=https://<your-integrations-host>/telegram/webhook"'
              }
            />
          </div>
          <p className="mt-3 text-[12px] text-fg-muted">
            Note: a bot with a webhook registered can no longer be polled, so
            link its chats with the manual{" "}
            <code className="font-mono text-fg">chat_id</code> field. Inbound
            chat sessions are kept in-memory per worker isolate; idle chats are
            swept automatically — tune with{" "}
            <code className="font-mono text-fg">TELEGRAM_IDLE_TIMEOUT_MS</code>.
          </p>
        </div>
      </div>
    </div>
  );
}

interface ConnectedPanelProps {
  conn: TelegramConnection;
  working: boolean;
  manualChatId: string;
  onManualChatId: (v: string) => void;
  onNewLink: () => void;
  onPoll: () => void;
  onAddChat: () => void;
  onRemoveChat: (chatId: number) => void;
  onDisconnect: () => void;
}

function ConnectedPanel({
  conn,
  working,
  manualChatId,
  onManualChatId,
  onNewLink,
  onPoll,
  onAddChat,
  onRemoveChat,
  onDisconnect,
}: ConnectedPanelProps) {
  const linkLive = Boolean(conn.start_url);
  return (
    <div className="flex flex-col gap-5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
        <dt className="text-fg-muted">Mode</dt>
        <dd className="text-fg">
          {conn.mode === "shared_bot" ? "Shared OMA bot" : "Your own bot"}
          {conn.mode === "own_bot" && (
            <span className="ml-2 text-fg-muted">
              {conn.has_token ? "token stored (encrypted)" : "no token stored"}
            </span>
          )}
        </dd>
        <dt className="text-fg-muted">Bot</dt>
        <dd className="text-fg">
          <a
            className="text-brand underline"
            href={`https://t.me/${conn.bot_username}`}
            target="_blank"
            rel="noreferrer"
          >
            @{conn.bot_username}
          </a>
        </dd>
      </dl>

      <div>
        <h3 className="text-[13px] font-medium text-fg mb-1.5">Link a chat</h3>
        {linkLive ? (
          <div className="flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <a
                className={`${BTN_PRIMARY} inline-block`}
                href={conn.start_url as string}
                target="_blank"
                rel="noreferrer"
              >
                Open the bot in Telegram
              </a>
              <a
                className={`${BTN_SECONDARY} inline-flex items-center`}
                href={conn.start_group_url as string}
                target="_blank"
                rel="noreferrer"
              >
                Add to a group
              </a>
              <button type="button" className={BTN_SECONDARY} disabled={working} onClick={onPoll}>
                I've messaged the bot
              </button>
            </div>
            <p className="text-[12px] text-fg-muted">
              This link expires — press{" "}
              <button
                type="button"
                className="text-brand underline disabled:opacity-50"
                disabled={working}
                onClick={onNewLink}
              >
                New link
              </button>{" "}
              if it stops working.
            </p>
          </div>
        ) : (
          <button type="button" className={BTN_PRIMARY} disabled={working} onClick={onNewLink}>
            Generate a link
          </button>
        )}
      </div>

      <div>
        <h3 className="text-[13px] font-medium text-fg mb-1.5">Linked chats</h3>
        {conn.chats.length === 0 ? (
          <p className="text-[13px] text-fg-muted">
            None yet — open the link above and press Start.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {conn.chats.map((chat) => (
              <li
                key={chat.chat_id}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-[13px]"
              >
                <span className="text-fg">
                  <code className="font-mono">{chat.chat_id}</code>
                  {chat.title && <span className="ml-2 text-fg-muted">{chat.title}</span>}
                  {chat.type && <span className="ml-2 text-fg-subtle">{chat.type}</span>}
                </span>
                <button
                  type="button"
                  className="text-fg-muted hover:text-danger disabled:opacity-50"
                  disabled={working}
                  onClick={() => onRemoveChat(chat.chat_id)}
                >
                  Unlink
                </button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="mt-3 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            onAddChat();
          }}
        >
          <div className="flex-1">
            <TextInput
              value={manualChatId}
              onChange={(e) => onManualChatId(e.target.value)}
              placeholder="Or paste a chat id, e.g. -1001234567890"
            />
          </div>
          <button
            type="submit"
            className={BTN_SECONDARY}
            disabled={working || manualChatId.trim().length === 0}
          >
            Add
          </button>
        </form>
      </div>

      <div className="border-t border-border pt-4">
        <button
          type="button"
          className={BTN_SECONDARY}
          disabled={working}
          onClick={onDisconnect}
        >
          Disconnect Telegram
        </button>
      </div>
    </div>
  );
}

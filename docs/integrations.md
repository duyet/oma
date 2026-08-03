# Integrations

Publish an agent into a third-party tool and have it act as a real teammate there — assigned, mentioned, replied to like any other user.

## Linear

Make an agent a member of your Linear workspace with its own identity, avatar, and `@autocomplete` slot. The agent appears in the assignee dropdown, gets pinged on `@mentions`, replies in the Agent panel, and pushes status back to issues it's working on.

Two install kinds:

| Kind | When to pick | Setup |
|---|---|---|
| **`personal_token`** (PAT) | Single workspace, fastest path, no OAuth App | `oma linear install-pat --workspace <slug> --pat <linear-pat>` |
| **`dedicated`** (OAuth App) | Multi-workspace, proper bot identity, OAuth refresh | Console **Integrations → Linear → Publish agent** (wizard issues per-publication callback + webhook URLs to paste into your own Linear OAuth App at `linear.app/settings/api`) |

The full agent-side playbook (when to ask the human, how to offer browser automation, exactly what to paste into Linear's form) lives at [`skills/oma/integrations-linear.md`](../skills/oma/integrations-linear.md).

PAT-mode autopilot — let the bot pick up unassigned issues by label/state/project:

```bash
oma linear rules create <pub-id> --label triage --state Backlog --project "Inbox"
oma linear rules list <pub-id>
oma linear rules delete <rule-id>
```

Inspect / manage:

```bash
oma linear list                                       # workspaces
oma linear pubs <installation-id>                     # publications (status=live, persona, caps)
oma linear get <pub-id>                               # single publication
oma linear update <pub-id> --caps issue.read,comment.write,issue.update,…
oma linear unpublish <pub-id>
```

How it works:

| Piece | What it does |
|---|---|
| **Per-publication identity** | `dedicated` registers a per-agent Linear OAuth App; `personal_token` shares the human's PAT (no App registered) |
| **Inbound webhook** | Linear events become user messages on a session — assigned, `@mention`, comment-mention, new comment in an active thread, **Agent panel** (`agentSessionCreated` / `agentSessionPrompted`, `commentReply` for threaded continuation) |
| **Outbound MCP** | The agent talks back through `mcp.linear.app/mcp` with its own bearer (PAT or OAuth-refreshed), so writes are attributed to the persona |
| **Capability gate** | Per-publication allowlist (issues / comments / labels / assignment / triage) limits what the agent can do |

The Linear integration ships in `packages/linear/` (provider logic, webhook signing, MCP wiring) with thin CF wrappers in `apps/integrations/src/routes/linear/publications.ts`.

## GitHub

Give an agent its own GitHub App with a real bot identity — assignable on issues, requestable as a reviewer on PRs, posts comments under its own `@<slug>[bot]` handle. Each agent is a separate App on github.com (per-publication, not a shared marketplace bot), so credentials and audit trails stay isolated.

```bash
# (1) Console — humans clicking through a wizard
Integrations → GitHub → Publish agent

# (2) CLI — agents driving oma on a user's behalf
oma github bind <agent-id> --env <env-id>       # → opens one-click GitHub App Manifest flow
oma github handoff <form-token>                 # alt: 7-day URL for an org admin to complete
oma github list
oma github pubs <installation-id>
oma github update <pub-id> --caps pr.read,pr.review.write,issue.comment.write,…
oma github unpublish <pub-id>
```

`bind` returns a `manifestStartUrl`; opening it auto-POSTs an App manifest to `github.com/settings/apps/new` with redirect URL + webhook URL + recommended permissions baked in. After confirming, GitHub redirects through to "Install on org" and the publication flips to `live`. Manual fallback: `oma github submit <form-token> --app-id … --private-key-file … --webhook-secret …` if you registered the App by hand.

**Engagement is label-based.** On install OMA auto-creates a label (default: lowercased persona name) in every selected repo. Add the label to any issue/PR to engage the bot for every subsequent activity on that thread; remove the label to mute. `@<slug>[bot]` mention in body or comment is the fallback path (GitHub's `@` autocomplete excludes Bot accounts, so it's plain-text).

How it works:

| Piece | What it does |
|---|---|
| **Per-publication App** | Each agent registers its own GitHub App via Manifest flow; credentials stored encrypted per-publication |
| **Inbound webhook** | `issues`, `issue_comment`, `pull_request`, `pull_request_review`, `pull_request_review_comment` become user messages on a session (one per `<repo>#<num>`) |
| **Outbound MCP** | Agent talks to GitHub's hosted MCP at `api.githubcopilot.com/mcp/` with the installation token; same token also injected as `GITHUB_TOKEN` for sandbox `gh` / `git` |
| **Token rotation** | 1-hour installation token auto-refreshed via App JWT on every webhook dispatch |
| **Capability gate** | Per-publication allowlist; destructive ops (`pr.merge`, `repo.branch.delete`, `workflow.dispatch`, `release.create`, `*.delete`) require explicit opt-in |

The GitHub integration ships in `packages/github/` with thin CF wrappers in `apps/integrations/src/routes/github/`.

## Slack

Publish an agent into a Slack workspace as a dedicated bot — `@mention`able in channels, replies in threads, joins DMs, hosts the AI assistant pane. Per-channel sessions: one running session per `(publication, channel)`, with all events in that channel converging on the same session id.

```bash
# (1) Console — humans clicking through a wizard
Integrations → Slack → Publish agent   # ↑ opens api.slack.com with a pre-filled manifest

# (2) CLI — agents driving oma on a user's behalf
oma slack publish <agent-id> --env <env-id>    # → returns manifestLaunchUrl + formToken (60 min TTL)
oma slack submit <form-token> --client-id … --client-secret … --signing-secret …
oma slack handoff <form-token>                 # alt: 7-day shareable URL for a workspace admin
oma slack list
oma slack pubs <installation-id>
oma slack update <pub-id> --caps message.write,thread.reply,reaction.add,…
oma slack unpublish <pub-id>
```

**One-click managed install.** When the operator configures a single distributable Slack App (`SLACK_MANAGED_CLIENT_ID` / `SLACK_MANAGED_CLIENT_SECRET` / `SLACK_MANAGED_SIGNING_SECRET`), the publish wizard shows an **Add to Slack** button that skips the manifest + paste-credentials steps and goes straight to OAuth (`POST /slack/publications/start-managed`). One app installs into **many** workspaces from one events URL — inbound events fan in by `team_id` to the right per-workspace installation. Without the three secrets it falls back to the bring-your-own-App manifest flow above. Full operator + end-user guide: [`slack-integration.md`](slack-integration.md).

The full agent-side playbook (manifest-flow caveats, `GATEWAY_ORIGIN` HTTPS requirement, what to paste where, MCP toggle probe) lives at [`skills/oma/integrations-slack.md`](../skills/oma/integrations-slack.md).

How it works:

| Piece | What it does |
|---|---|
| **Per-publication App** | Each agent registers as its own dedicated Slack App via the "Create from manifest" URL flow — own client id, signing secret, bot user; no shared marketplace App |
| **Inbound webhook** | `app_mention` / DM / thread reply → `direct_invocation` signal; top-level channel post → debounced `channel_scan_armed` (90 s window); reactions on bot-authored messages → `reaction_on_bot_message`; `member_joined`/`member_left_channel` for the bot → `joined_channel` / `session_closed`; `channel_archive` / `channel_unarchive` → close / reopen |
| **Dual-token outbound** | OAuth v2 yields both bot (`xoxb-`) and user (`xoxp-`) tokens. The `xoxp-` vault binds to `mcp.slack.com/mcp` for typed `mcp__slack__*` tools (search, history, canvases); the `xoxb-` vault binds to `slack.com/api` for `chat.postMessage`, reactions, etc. Bot replies default to in-thread |
| **Capability gate** | Per-publication allowlist (`message.read/write/update/delete`, `thread.reply`, `reaction.add/remove`, `user.read`, `search.read`, `canvas.write`) |
| **Resumable install** | Publication-first — the row exists from minute one with callback + webhook URLs baked into the manifest. Mid-flow failures stay resumable from Console (`pending_setup` → `credentials_filled` → `awaiting_install` → `live`) |

The Slack integration ships in `packages/slack/` with thin CF wrappers in `apps/integrations/src/routes/slack/`.

**Operator setup:** the integrations gateway needs `GATEWAY_ORIGIN` pointing at a publicly-reachable HTTPS host — Slack verifies both the OAuth redirect URL and the Events Request URL before letting an install complete.

## Telegram

Two halves that can be adopted independently: a **per-tenant connection**
(Console → Integrations → Telegram) that links chats to your workspace, and the
**deployment-level inbound bot** that turns chat messages into sessions.

### Per-tenant connection (Console)

`/integrations/telegram` connects the workspace to a bot in one of two modes,
mirroring GitHub's managed-App vs own-App duality:

| Mode | Bot | Token storage |
|---|---|---|
| `shared_bot` | the deployment's own bot (e.g. **@omatherobot**) | the operator's `TELEGRAM_SHARED_BOT_TOKEN` env secret — never written to a tenant row, never returned by the API |
| `own_bot` | a bot the tenant created with [@BotFather](https://t.me/BotFather) | validated with `getMe`, then AES-256-GCM encrypted at rest under a `telegram.bot_token` key derived from `PLATFORM_ROOT_SECRET` (the same machinery vault credentials and federation API keys use). Reads surface `has_token` + the bot username only |

**Chat capture — the deep-link handshake.** A bot cannot discover which chats
want it; the chat has to speak first, and Telegram's standard answer is the
`start` deep-link parameter. The backend mints a short-lived per-tenant nonce
and the Console renders `https://t.me/<bot>?start=<nonce>` (plus
`?startgroup=<nonce>` to add the bot to a group). Tapping it makes Telegram
deliver `/start <nonce>` — `/start@<bot> <nonce>` in groups — from that chat,
and `POST /link/poll` reads it back with `getUpdates`, matches the nonce, and
records `message.chat.id`. That is how the `chat_id` is learned without asking
a user to hunt for their numeric id.

Two consequences worth knowing:

- **Nonce, not identity.** The nonce is single-purpose and expires (15 min);
  minting a new link invalidates the old one. Anyone holding a live link can
  bind *their* chat to the workspace, so treat it like an invite link.
- **A webhook claims the update stream.** Telegram refuses `getUpdates` (409)
  for a bot that has a webhook registered — including the shared bot on a
  deployment that wired the inbound bot below. The 409 is surfaced verbatim
  rather than reported as "no updates", and the Console's manual `chat_id`
  field is the documented fallback. Webhook-side capture of the same `/start`
  payload is the follow-up that removes this seam.

Routes (tenant-scoped, mounted on **both** runtimes at `/v1/integrations/telegram`;
storage is one KV row per tenant — no migration):

```http
GET    /v1/integrations/telegram              # status (unconnected is 200, not 404)
POST   /v1/integrations/telegram/connect      # { mode: "shared_bot" } | { mode: "own_bot", bot_token }
POST   /v1/integrations/telegram/link         # mint a fresh deep-link nonce
POST   /v1/integrations/telegram/link/poll    # capture chats that sent /start <nonce>
POST   /v1/integrations/telegram/chats        # manual chat_id entry (webhook fallback)
DELETE /v1/integrations/telegram/chats/:chatId
DELETE /v1/integrations/telegram              # disconnect (drops the stored token)
```

A linked `chat_id` is what a
[`telegram_message` notify target](../AGENTS.md#notify-targets) needs, so the
page doubles as the discovery step for agent/schedule notifications.

**Follow-ups (deliberately out of scope):** capturing `/start` from the webhook
route so a webhook-bound bot needs no manual entry; using the stored `own_bot`
token as the send-side credential for `telegram_message` (today the notify
dispatcher resolves its own); and per-chat agent binding from the Console.

### Deployment-level inbound bot

Turning chat messages into sessions is still wired entirely through env vars on
the integrations gateway — set `TELEGRAM_BOT_TOKEN` (BotFather) plus
`TELEGRAM_AGENT_ID` (and optionally `TELEGRAM_VAULT_IDS` /
`TELEGRAM_ENVIRONMENT_ID`), then point BotFather's webhook at
`/telegram/webhook`. One session per chat.

- **Attachments** — inbound photos and documents are downloaded and forwarded to
  the agent as image / document content blocks (caption becomes the text); an
  oversized or expired file degrades to a text placeholder so the turn still lands.
- **Auto-idle** — a periodic sweep pauses the sandbox of any chat idle longer than
  `TELEGRAM_IDLE_TIMEOUT_MS` (default 5 minutes) to stop paying for idle
  containers. The next message implicitly resumes it (the sandbox warms lazily),
  so no explicit resume is needed.

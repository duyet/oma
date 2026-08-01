<p align="center">
  <img src="logo.svg" alt="oma" height="80" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0 License" />
  <img src="https://github.com/duyet/oma/actions/workflows/ci.yml/badge.svg" alt="CI" />
  <img src="https://img.shields.io/badge/API-Anthropic%20Compatible-blueviolet" alt="Anthropic Compatible" />
</p>

# Open Managed Agents

**Open-source alternative to Claude Managed Agents** — and a foundation for open-source, self-hosted Claude Tag-style agents.

🌐 **[oma.duyet.net](https://oma.duyet.net)** · 📖 **[docs.oma.duyet.net](https://docs.oma.duyet.net)** · 💬 **[github.com/duyet/oma](https://github.com/duyet/oma)**

Write a harness. Deploy. The platform runs it — with sessions, sandboxes, tools, memory, vaults, Slack/GitHub/Linear integrations, and crash recovery out of the box. Drop-in compatible with the Claude Managed Agents API; runs on Cloudflare Workers + Durable Objects, or `docker compose up` on your own box.

Use Open Managed Agents when you want:

- A self-hosted Claude Managed Agents API implementation.
- An open-source, self-hosted Claude Tag-style workflow with BYOK model credentials.
- MCP, private tools, encrypted vaults, and durable sessions under your own deployment boundary.

Compare: [Open Tag](https://oma.duyet.net/open-tag/) · [Open-source Claude Tag](https://oma.duyet.net/claude-tag-open-source/) · [Self-hosted Claude Tag](https://oma.duyet.net/self-hosted-claude-tag/)

<p align="center">
  <img src="docs/assets/screenshots/console-session.jpg" alt="OMA Console — a coding agent session, streaming tool calls and output in real time" width="800" />
</p>

<details>
<summary>More Console screenshots</summary>
<br>

| | |
|---|---|
| ![Sandbox Runtimes — every backend behind one interface](docs/assets/screenshots/console-sandbox-runtimes.jpg) | ![GitHub integrations page](docs/assets/screenshots/console-github-integration.jpg) |
| Sandbox Runtimes — every backend behind one interface | GitHub integrations — issues assigned to an agent spawn a briefed session |
| ![Skills library](docs/assets/screenshots/console-skills.jpg) | |
| Skills library | |

</details>

---

## Two ways to run OMA

The same harness, business logic, and event-log model run on both. Pick the
one that matches your hosting story:

| | **Self-host (Node)** | **Cloudflare** |
|---|---|---|
| Where it lives | Your VPS / Mac / Docker host / fly.io / your k8s | Cloudflare Workers + DO + Containers |
| Storage | SQLite or Postgres + local FS | D1 + KV + R2 |
| Sandbox | Multi-provider: LocalSubprocess / LiteBox / Daytona / E2B / BoxRun / Kubernetes + BYOK | Cloudflare Sandbox (Containers) |
| Time to running | `docker compose up` (~2 min) | wrangler deploy (~10 min once configured) |
| Best for | OSS users, on-prem, no CF account, data-resident deploys | Edge scale, no host management, already on CF |

**Same SDK.** Same `/v1/agents` / `/v1/sessions` API. Same Console UI. Same
crash-recovery semantics. Switch between them by changing env vars, not code.

---

## Quick start: self-host (Docker)

```bash
git clone https://github.com/duyet/oma.git
cd oma
cp .env.example .env

# Two secrets are required before first boot (server refuses to start
# without them) — both generated locally:
#   BETTER_AUTH_SECRET   — signs Console sessions
#   PLATFORM_ROOT_SECRET — encrypts credentials, model-card API keys, integration tokens at rest
#                          (lose it and every encrypted row is unreadable — back it up)
# A third, API_KEY, is optional but the smoke test below needs it (otherwise
# every curl 401s — there's no Console session cookie yet on a fresh install):
$EDITOR .env
# BETTER_AUTH_SECRET=$(openssl rand -hex 32)
# PLATFORM_ROOT_SECRET=$(openssl rand -base64 32)
# API_KEY=$(openssl rand -hex 24)
#
# Optional: ANTHROPIC_API_KEY lets the first agent run without a Model Card.
# In production, add a Model Card per tenant from the Console instead.

# SQLite + LocalSubprocess sandbox (default — fastest path)
docker compose up -d

# Or Postgres backend
# docker compose -f docker-compose.postgres.yml up -d

curl localhost:8787/health
# → {"status":"ok","backends":{"db":"sqlite ..."}, ...}

open http://localhost:8787   # Console UI on the same port
```

Smoke test the harness end-to-end (uses the `API_KEY` you set in `.env` above):

```bash
KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

AID=$(curl -s -X POST localhost:8787/v1/agents -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"hello","model":"claude-sonnet-4-6","tools":[{"type":"agent_toolset_20260401"}]}' | jq -r .id)

SID=$(curl -s -X POST localhost:8787/v1/sessions -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d "{\"agent\":\"$AID\"}" | jq -r .id)

curl -s -X POST localhost:8787/v1/sessions/$SID/events -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Run: uname -a"}]}]}'
```

Skipped `API_KEY` and want zero auth friction instead for a single-user local
trial? `echo "AUTH_DISABLED=1" >> .env`, restart, and drop the `-H
"x-api-key: ..."` from every curl above — every request becomes
`tenant_id="default"`. Full auth modes (email/password sign-up, OTP, Google
OAuth): **[docs.oma.duyet.net/self-host/node-docker#login](https://docs.oma.duyet.net/self-host/node-docker/#login)**.

Full self-host guide (sandbox modes, Postgres, BoxRun, vault sidecar,
Console UI, operator gotchas): **[docs.oma.duyet.net/self-host/overview](https://docs.oma.duyet.net/self-host/overview/)**

---

## Quick start: Cloudflare deploy

Requires [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) (for Durable Objects + Containers).

```bash
git clone https://github.com/duyet/oma.git
cd oma
pnpm install

# Local dev (no CF account needed) — wrangler dev with simulators
cp .dev.vars.example .dev.vars && $EDITOR .dev.vars
# PLATFORM_ROOT_SECRET is required to start; API_KEY ships prefilled with a
# dev-only placeholder (dev-test-key-change-me) so the smoke test below
# works out of the box — change it before exposing this past localhost.
pnpm dev
# API   → http://localhost:8787
# Console → http://localhost:5173

# Deploy — one wizard: creates the D1 databases, KV namespace, and R2
# buckets; patches wrangler.jsonc in apps/main + apps/agent + apps/integrations
# with the resulting IDs; generates and sets PLATFORM_ROOT_SECRET,
# INTEGRATIONS_INTERNAL_SECRET, BETTER_AUTH_SECRET, and API_KEY as Worker
# secrets; applies D1 migrations; deploys all three workers in dependency
# order (integrations → agent → main).
npx wrangler login
./scripts/setup-cf.sh
# → prints each worker's URL; the main worker serves both the API and the
#   bundled Console UI. Re-run anytime — it's idempotent (reuses existing
#   resources, skips secrets that are already set). Flags: --no-deploy
#   (provision only), --skip-secrets (already set them), --reset-secrets
#   (rotate everything).

# Optional — only if you want a tenant-less default LLM (otherwise add a
# Model Card in the Console): export ANTHROPIC_API_KEY before running the
# wizard, or set it interactively when prompted.
```

What gets deployed:

| Component | What it does |
|---|---|
| **Main Worker** (`oma-managed-agents`) | API routes — agents, sessions, environments, vaults, memory, files — plus the bundled Console UI |
| **Agent Worker** (`oma-sandbox-default`) | SessionDO + harness + sandbox per environment |
| **Integrations Worker** (`oma-managed-agents-integrations`) | Linear / GitHub / Slack OAuth + webhook gateway |
| **D1** (`oma-auth`, `oma-integrations`) | Control-plane + tenant data; integration provider tables |
| **KV** (`CONFIG_KV`) | Config storage for agents, environments, credentials |
| **R2** (files, workspace, memory, backups) | Uploaded files, sandbox workspace persistence, memory-store bytes, snapshot backups |

Want Kubernetes-backed sandboxes instead of Cloudflare Containers? See the
[k8s-bridge quickstart](docs/deploy/k8s-bridge-quickstart.md) (full guide:
[docs/deploy/k8s-bridge.md](docs/deploy/k8s-bridge.md)).

### Create your first agent

For local dev (`pnpm dev` above), the API is already reachable with the
`.dev.vars` placeholder key. For a Cloudflare deploy, open the main worker
URL `setup-cf.sh` printed, sign up (the first account becomes that tenant's
owner), and mint a key from **Console → API Keys** — `setup-cf.sh` generates
its own `API_KEY` secret directly on the worker, so that value is never
shown to you. Either way, the minimal API equivalent to clicking through the
Console:

```bash
BASE=http://localhost:8787          # local pnpm dev — swap for your deployed URL
KEY=dev-test-key-change-me          # .dev.vars.example's default (local only —
                                     # for a deploy, use the key you minted above)

AGENT=$(curl -s $BASE/v1/agents \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "Coder",
    "model": "claude-sonnet-4-6",
    "system": "You are a helpful coding assistant.",
    "tools": [{ "type": "agent_toolset_20260401" }]
  }' | jq -r .id)

SESSION=$(curl -s $BASE/v1/sessions \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\"}" | jq -r .id)

# Send a turn AND stream the reply token-by-token in one shot
curl -N -X POST $BASE/v1/sessions/$SESSION/messages \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"content":"Write a Python script that fetches HN top stories"}'
```

For long-lived sessions use `GET /v1/sessions/$SESSION/events/stream` — replays history on connect, never closes. For the full Console-driven flow (Model Cards, vaults, integrations) see **[docs.oma.duyet.net/quickstart](https://docs.oma.duyet.net/quickstart)**.

### Deploying the website

The marketing site (`apps/web`) auto-deploys via CI. See [docs/website-deploy.md](docs/website-deploy.md).

---

## Examples

[`examples/`](examples/) has copy-paste-ready agent configs for common
personas (coding assistant, data analyst, research agent) plus full harness
demos (`claude-agent-sdk`, GitHub-repo attach, self-improvement-agent)
with pre-built Docker images published to GHCR by
[`build-example-images.yml`](.github/workflows/build-example-images.yml), plus
a build-it-yourself provider-swap demo (`grok-coding-agent`).
See [`examples/README.md`](examples/README.md).

---

## Architecture

A **meta-harness** is not an agent — it's the platform that runs agents: the
platform prepares *what* is available (tools, skills, history, sandbox), a
pluggable harness decides *how* to deliver it to the model. Full write-up,
diagrams, and the platform-vs-harness responsibility split:
**[docs/architecture.md](docs/architecture.md)**.

## Write a Harness

The default harness works out of the box. When you need custom behavior —
different caching, compaction, context engineering — implement
`HarnessInterface` and register it by name. Worked example, the full hook
contract, and the `/new-harness` scaffold: [docs/architecture.md § Implications for Custom Harnesses](docs/architecture.md#implications-for-custom-harnesses)
and [AGENTS.md § Custom Harness](AGENTS.md#custom-harness).

---

## API

Compatible with the [Claude Managed Agents API](https://docs.anthropic.com/en/docs/agents/managed-agents). Same endpoints, same event types, works with existing SDKs. Full route reference (Agents, Environments, Sessions, Vaults, Memory Stores, Files & Skills): **[docs/api-reference.md](docs/api-reference.md)**.

---

## Built-in Tools

`agent_toolset_20260401` ships `bash`, `read`, `write`, `edit`, `glob`, `grep`, `web_fetch`, `web_search`, plus scheduling and opt-in `browser`/derived tools (`call_agent_*`, `mcp__<server>__<tool>`). Full catalog and behavior details: **[docs/tools.md](docs/tools.md)**.

---

## MCP servers

OMA registers any [Model Context Protocol](https://modelcontextprotocol.io) server attached to an agent (`mcp__<server>__<tool>`, up to 20 per agent), with a tenant-level registry and credential-resolving outbound proxy. Full guide: **[docs/mcp-servers.md](docs/mcp-servers.md)**.

---

## Skills

A skill is a `SKILL.md` plus reference files, mounted into the sandbox and inlined into the system prompt at session start. Format is compatible with Anthropic's [Claude Code skills](https://github.com/anthropics/skills). Full guide: **[docs/skills.md](docs/skills.md)**.

---

## Vaults & outbound credentials

**Tools never see your tokens.** An outbound resolver matches request hostnames against the session's vaults and injects credentials at the network layer — a prompt-injected agent has nothing to leak. Full guide: **[docs/vaults-and-credentials.md](docs/vaults-and-credentials.md)** (design deep-dive: [docs/mcp-credential-architecture.md](docs/mcp-credential-architecture.md)).

---

## Integrations

Publish an agent into Linear, GitHub, Slack, or Telegram and have it act as a real teammate there — assigned, mentioned, replied to like any other user. Full guide: **[docs/integrations.md](docs/integrations.md)** (Slack operator setup detail: [docs/slack-integration.md](docs/slack-integration.md)).

---

## Publish an agent to consumers

Publish an agent as a standalone bot end users talk to without an OMA account — hosted chat page, embeddable widget, guest auth, optional per-message billing. Full guide: **[docs/publishing.md](docs/publishing.md)**.

## Schedule an agent

Fire sessions on a cron cadence with no human turn — digests, polling, recurring maintenance. Full guide: **[docs/schedules.md](docs/schedules.md)**.

---

## Project Structure

See **[docs/project-structure.md](docs/project-structure.md)** for the full `apps/` and `packages/` layout.

---

## Configuration

The variables that gate boot and at-rest safety (`PLATFORM_ROOT_SECRET`, `BETTER_AUTH_SECRET`, `API_KEY`, sandbox provider keys, telemetry toggles, …): **[docs/configuration.md](docs/configuration.md)**.

---

## Telemetry

OMA collects **anonymous, opt-out** usage telemetry (instance UUID, version, aggregate counts only — never prompts, messages, or credentials). Opt out with `OMA_TELEMETRY_DISABLED=1`. Full details: **[docs/telemetry.md](docs/telemetry.md)**.

---

## Model Cards

Per-tenant LLM credentials — an agent references one via `agent.model = "<model_id>"`; the worker signs the outbound request with its api_key/base_url/headers. Supports `ant` / `ant-compatible` / `oai` / `oai-compatible`. Full guide: **[docs/model-cards.md](docs/model-cards.md)**.

---

## Testing

```bash
npm test          # unit + integration suite
npm run typecheck # zero errors
```

---

## Documentation

The user-facing docs site lives at [`apps/docs`](apps/docs/) (Astro Starlight) and is published to **[docs.oma.duyet.net](https://docs.oma.duyet.net)**.

```bash
pnpm dev:docs       # local preview at http://localhost:4321
pnpm build:docs     # static build into apps/docs/dist/
pnpm deploy:docs    # build + wrangler deploy (Cloudflare Worker static assets)
```

The `docs/` folder at the repo root contains **internal design RFCs** — not the user-facing site, but useful reference while working in this repo:

| Topic | Doc |
|---|---|
| Architecture (meta-harness design) | [docs/architecture.md](docs/architecture.md) · [docs/architecture-overview.md](docs/architecture-overview.md) (中文, deep dive) |
| API reference | [docs/api-reference.md](docs/api-reference.md) |
| Built-in tools | [docs/tools.md](docs/tools.md) |
| MCP servers | [docs/mcp-servers.md](docs/mcp-servers.md) · [docs/mcp-credential-architecture.md](docs/mcp-credential-architecture.md) |
| Skills | [docs/skills.md](docs/skills.md) |
| Vaults & outbound credentials | [docs/vaults-and-credentials.md](docs/vaults-and-credentials.md) |
| Integrations (Linear, GitHub, Slack, Telegram) | [docs/integrations.md](docs/integrations.md) · [docs/slack-integration.md](docs/slack-integration.md) |
| Publishing agents to consumers | [docs/publishing.md](docs/publishing.md) |
| Scheduling agents | [docs/schedules.md](docs/schedules.md) |
| Project structure | [docs/project-structure.md](docs/project-structure.md) |
| Configuration / env vars | [docs/configuration.md](docs/configuration.md) |
| Telemetry | [docs/telemetry.md](docs/telemetry.md) |
| Model Cards | [docs/model-cards.md](docs/model-cards.md) |
| Deployment topologies | [docs/deployment.md](docs/deployment.md) · [docs/self-host.md](docs/self-host.md) · [docs/runtimes.md](docs/runtimes.md) |
| Quickstart (step-by-step) | [docs/quickstart.md](docs/quickstart.md) |
| Advanced / fleet features | [docs/features.md](docs/features.md) |
| Website deploy | [docs/website-deploy.md](docs/website-deploy.md) |

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feat/amazing-feature`)
3. Run tests (`npm test && npm run typecheck`)
4. Commit your changes
5. Open a Pull Request

---

## License

[Apache 2.0](LICENSE)

> Forked from [openma-ai/open-managed-agents](https://github.com/openma-ai/open-managed-agents).

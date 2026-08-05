<p align="center">
  <img src="logo.svg" alt="oma" height="80" />
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/Docker-compose-2496ED?logo=docker&logoColor=white" alt="Docker" />
  <img src="https://img.shields.io/badge/Kubernetes-ready-326CE5?logo=kubernetes&logoColor=white" alt="Kubernetes" />
  <img src="https://img.shields.io/badge/MCP-client%20%26%20server-6E56CF" alt="Model Context Protocol" />
  <img src="https://img.shields.io/badge/TypeScript-5.8-3178C6?logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/pnpm-monorepo-F69220?logo=pnpm&logoColor=white" alt="pnpm" />
  <img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="Apache 2.0 License" />
  <img src="https://github.com/duyet/oma/actions/workflows/ci.yml/badge.svg" alt="CI" />
  <img src="https://img.shields.io/badge/API-Anthropic%20Compatible-blueviolet" alt="Anthropic Compatible" />
</p>

# Open Managed Agents

**Open-source, self-hostable reimplementation of the Claude Managed Agents API.** A **meta-harness**: the platform prepares *what* an agent has — tools, skills, history, sandbox, credentials — and a pluggable harness decides *how* to drive the model loop. Drop-in compatible with the Claude Managed Agents API; the same business logic runs on **Cloudflare Workers + Durable Objects** or **`docker compose up`** on your own box.

🌐 **[oma.duyet.net](https://oma.duyet.net)** · 📖 **[docs.oma.duyet.net](https://docs.oma.duyet.net)** · 💬 **[github.com/duyet/oma](https://github.com/duyet/oma)**

Reach for OMA when you want a self-hosted Managed Agents implementation, an open-source Claude Tag-style workflow with BYOK model credentials, or MCP + private tools + encrypted vaults + durable sessions under your own deployment boundary.

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

## Two ways to run

The same harness, business logic, and event-log model run on both. Pick the one that matches your hosting story:

| | ![Docker](https://img.shields.io/badge/-Self--host%20(Node)-2496ED?logo=docker&logoColor=white) | ![Cloudflare](https://img.shields.io/badge/-Cloudflare-F38020?logo=cloudflare&logoColor=white) |
|---|---|---|
| Where it lives | Your VPS / Mac / Docker host / fly.io / your k8s | Cloudflare Workers + DO + Containers |
| Storage | SQLite or Postgres + local FS | D1 + KV + R2 |
| Sandbox | Multi-provider — see the [sandbox roster](#sandbox-providers) | Cloudflare Sandbox (Containers) + most of the same roster |
| Time to running | `docker compose up` (~2 min) | `wrangler deploy` (~10 min once configured) |
| Best for | OSS users, on-prem, no CF account, data-resident deploys | Edge scale, no host management, already on CF |

Same SDK. Same `/v1/agents` / `/v1/sessions` API. Same Console UI. Same crash-recovery semantics. Switch between them by changing env vars, not code. Full topology comparison: [docs/deployment.md](docs/deployment.md).

---

## Quick start

### Self-host (Docker)

```bash
git clone https://github.com/duyet/oma.git && cd oma
cp .env.example .env
# Three secrets in .env (server won't boot without the first two):
#   BETTER_AUTH_SECRET=$(openssl rand -hex 32)      # signs Console sessions
#   PLATFORM_ROOT_SECRET=$(openssl rand -base64 32) # encrypts credentials at rest — back it up!
#   API_KEY=$(openssl rand -hex 24)                 # optional, but the smoke test below needs it
$EDITOR .env

docker compose up -d        # SQLite + LocalSubprocess sandbox (default)
                            # …or: docker compose -f docker-compose.postgres.yml up -d
curl localhost:8787/health  # → {"status":"ok", ...}
open http://localhost:8787  # Console UI on the same port
```

Smoke test the harness end-to-end (uses the `API_KEY` from `.env`):

```bash
KEY=$(grep '^API_KEY=' .env | cut -d= -f2)

AID=$(curl -s -X POST localhost:8787/v1/agents -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"hello","model":"claude-sonnet-4-6","tools":[{"type":"agent_toolset_20260401"}]}' | jq -r .id)

SID=$(curl -s -X POST localhost:8787/v1/sessions -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d "{\"agent\":\"$AID\"}" | jq -r .id)

curl -s -X POST localhost:8787/v1/sessions/$SID/events -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Run: uname -a"}]}]}'
```

Single-user local trial with zero auth friction? `echo "AUTH_DISABLED=1" >> .env`, restart, and drop the `x-api-key` header — every request becomes `tenant_id="default"`.

Full self-host guide (sandbox modes, Postgres, BoxRun, vault sidecar, operator gotchas): **[docs/self-host.md](docs/self-host.md)** · **[docs/quickstart.md](docs/quickstart.md)**.

### Cloudflare

Requires a [Workers Paid plan](https://developers.cloudflare.com/workers/platform/pricing/) (Durable Objects + Containers).

```bash
git clone https://github.com/duyet/oma.git && cd oma
pnpm install

# Local dev (no CF account needed) — wrangler dev with simulators
cp .dev.vars.example .dev.vars && $EDITOR .dev.vars  # PLATFORM_ROOT_SECRET required; API_KEY prefilled
pnpm dev   # API → http://localhost:8787 · Console → http://localhost:5173

# Deploy — one idempotent wizard: provisions D1/KV/R2, sets secrets, applies
# migrations, deploys all three workers (integrations → agent → main).
npx wrangler login
./scripts/setup-cf.sh
```

For your first agent on a fresh CF deploy, open the main worker URL `setup-cf.sh` printed, sign up (first account becomes the tenant owner), and mint a key from **Console → API Keys**. Per-worker breakdown and flag reference: **[docs/deployment.md](docs/deployment.md)** · **[docs/deploy/cloudflare.md](docs/deploy/cloudflare.md)**. Want Kubernetes-backed sandboxes instead of Cloudflare Containers? See [docs/deploy/k8s-bridge-quickstart.md](docs/deploy/k8s-bridge-quickstart.md).

### Kubernetes (Helm)

Three charts — full control plane, sandbox-only bridge worker, or an in-cluster sandbox gateway. See [`charts/README.md`](charts/README.md) for the roster and [docs/deploy/kubernetes.md](docs/deploy/kubernetes.md) for topology.

---

## Features

### Bring your own model

![Anthropic](https://img.shields.io/badge/Anthropic-Claude-D97757?logo=anthropic&logoColor=white) ![OpenAI](https://img.shields.io/badge/OpenAI-compatible-412991?logo=openai&logoColor=white) ![Anthropic-Router](https://img.shields.io/badge/Anthropic--Router-one--click%20OAuth-2ea043)

Per-tenant **Model Cards** (`ant` / `ant-compatible` / `oai` / `oai-compatible`); one-click Anthropic Router OAuth from the Console; env-var fallback (`ANTHROPIC_API_KEY` / `ANTHROPIC-ROUTER_API_KEY`) so a fresh install runs immediately. The `poolside` harness drives poolside.ai `laguna`/`malibu` over the same loop. → [docs/model-cards.md](docs/model-cards.md) · [AGENTS.md § Model Configuration](AGENTS.md#model-configuration)

### Harnesses — pluggable "how"

| Harness | What it does |
|---|---|
| `default` | Standard AI-SDK tool loop, prompt-cache-safe context engineering |
| `claude-agent-sdk` | Runs the actual Claude Code CLI subprocess (self-host Node only) |
| `poolside` | Same loop, swapped model resolver for poolside.ai |
| `acp-proxy` | Delegates the whole loop to a local ACP agent (Claude Code, Codex) via `oma bridge daemon` |
| `oma-remote` | Proxies every turn to a session on a **federated** OMA instance |
| *custom* | Implement `HarnessInterface`, register by name — see [Write a Harness](#write-a-harness) |

### Sandbox providers

<a name="sandbox-providers"></a> Every sandbox — cloud container, local process, browser tab, or another cluster — sits behind one `SandboxExecutor` interface:

| Provider | Runs on | Provider | Runs on |
|---|---|---|---|
| Cloudflare Containers | Cloudflare | BoxRun | Both |
| docker-compose | Self-host Node | LiteBox | Self-host Node |
| k8s / k8s-remote | Both | Daytona / E2B | Self-host Node |
| OpenShell | Both | Local subprocess (`oma bridge daemon`) | Both (CF via relay) |
| Browser VM (WASM, v86) | Both (CF via relay) | Dynamic Workers (Code Mode) | Cloudflare only |
| oma-remote | Cloudflare (Node: not yet wired) | | |

Full Cloudflare-availability matrix and the k8s-remote vs openshell comparison: [AGENTS.md § Sandbox Provider on the Cloudflare Deployment](AGENTS.md#sandbox-provider-on-the-cloudflare-deployment).

### Vaults & outbound credentials

Tools never see your tokens. Credentials live encrypted in a vault; an outbound HTTP proxy matches hostnames and injects auth at the network layer — a prompt-injected agent has nothing to leak. Supports `static_bearer`, `mcp_oauth`, `cap_cli` (gh/aws/kubectl/wrangler). → [docs/vaults-and-credentials.md](docs/vaults-and-credentials.md)

### Sessions, events & crash recovery

Every session is an append-only **event log** (DO-SQLite), streamable over SSE, resumable after a crash with zero data loss. Sandbox **pause/resume** snapshots `/workspace` and tears down the container to stop paying for idle compute, independent of session lifecycle. → [AGENTS.md § Sessions](AGENTS.md#sessions)

### Memory stores

Persistent cross-session storage mounted at `/mnt/memory/<store>/`, read/written with the same file tools the agent already has — no bespoke memory API. Versioned, redactable, CAS-safe. → [AGENTS.md § Memory Stores](AGENTS.md#memory-stores)

### Skills

`SKILL.md` + reference files, mounted into the sandbox and inlined into the system prompt — format-compatible with Anthropic's [Claude Code skills](https://github.com/anthropics/skills). → [docs/skills.md](docs/skills.md)

### Schedules & deployments

- **Agent schedules** — cron-fire a session with no human turn, DST-correct timezones, run history, per-schedule alerts.
- **Deployments** — reusable bundles (agent + version pin + environment + vaults + memory stores) triggered manually, on a cron, or via an unauthenticated-but-token-secured webhook.

→ [docs/schedules.md](docs/schedules.md) · [AGENTS.md § Deployments](AGENTS.md#deployments)

### Cross-instance federation

Delegate a task — or an entire session — from one OMA instance to another. `callable_agents` gains a `remote_agent` type for one-off delegation; `sandbox_provider: "oma-remote"` binds a whole session so every turn runs on the remote while the Console, API, and event log stay local. → [AGENTS.md § Cross-Instance Federation](AGENTS.md#cross-instance-federation)

### MCP — client and server

![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-6E56CF)

- **As a client** — register any [MCP](https://modelcontextprotocol.io) server per-agent or in a tenant-level registry; calls proxy through the main worker so credentials never touch the sandbox, identically on every provider.
- **As a server** — OMA exposes its own MCP endpoint (`POST /v1/mcp`) so it can be driven from Claude Desktop, Claude Code, Cursor, or VS Code.

→ [docs/mcp-servers.md](docs/mcp-servers.md) · [AGENTS.md § OMA as an MCP Server](AGENTS.md#oma-as-an-mcp-server)

### Integrations

![GitHub](https://img.shields.io/badge/GitHub-issues%20%26%20PRs-181717?logo=github&logoColor=white) ![Slack](https://img.shields.io/badge/Slack-4A154B?logo=slack&logoColor=white) ![Telegram](https://img.shields.io/badge/Telegram-26A5E4?logo=telegram&logoColor=white) ![Linear](https://img.shields.io/badge/Linear-5E6AD2?logo=linear&logoColor=white) ![Matrix](https://img.shields.io/badge/Matrix-000000?logo=matrix&logoColor=white) ![Email](https://img.shields.io/badge/Email-transactional-EA4335?logo=gmail&logoColor=white) ![Webhook](https://img.shields.io/badge/Webhook-HMAC--signed-blue)

Publish agents into GitHub, Slack, Linear, or Telegram. Notify targets (`agent.notify`) fan session-status and sandbox-lifecycle alerts out to chat, email, or a signed generic webhook. → [docs/integrations.md](docs/integrations.md)

### Agent hooks

Claude-Code-style `pre_tool`/`post_tool` hooks that gate, redact, or modify a tool call via a signed outbound webhook — no custom code inside the Worker/DO. Prompt-cache-safe. → [AGENTS.md § Agent Hooks](AGENTS.md#agent-hooks)

### Publishing & payments

Publish an agent as a consumer-facing bot — hosted chat page, embeddable widget (`<script src=".../widget.js">`), guest/magic-link auth, and optional per-message or per-1k-token metering against a Stripe-backed credit wallet. → [docs/publishing.md](docs/publishing.md)

---

## Architecture

A meta-harness is not an agent — it's the platform that runs agents. The platform prepares *what* is available (tools, skills, history, sandbox); a pluggable harness decides *how* to deliver it to the model. Full write-up, diagrams, and the platform-vs-harness responsibility split: **[docs/architecture.md](docs/architecture.md)**.

## Write a Harness

The default harness works out of the box. When you need custom behavior — different caching, compaction, context engineering — implement `HarnessInterface` and register it by name. Worked example, the full hook contract, and the `/new-harness` scaffold: [docs/architecture.md § Implications for Custom Harnesses](docs/architecture.md#implications-for-custom-harnesses) and [AGENTS.md § Custom Harness](AGENTS.md#custom-harness).

## API

Compatible with the [Claude Managed Agents API](https://docs.anthropic.com/en/docs/agents/managed-agents). Same endpoints, same event types, works with existing SDKs. Full route reference: **[docs/api-reference.md](docs/api-reference.md)**. Built-in tool catalog (`agent_toolset_20260401`: `bash`, `read`, `write`, `edit`, `glob`, `grep`, `web_fetch`, `web_search`, plus opt-in `browser`/`run_dynamic_worker` and derived delegation/MCP tools): **[docs/tools.md](docs/tools.md)**.

## Examples

[`examples/`](examples/) has copy-paste agent configs for common personas (coding assistant, data analyst, research agent) plus full harness demos (`claude-agent-sdk`, GitHub-repo attach, self-improvement-agent) with pre-built Docker images on GHCR, and a build-it-yourself provider-swap demo (`grok-coding-agent`). See [`examples/README.md`](examples/README.md).

---

## Reference

| Topic | Doc |
|---|---|
| Project structure (`apps/*`, `packages/*`) | [docs/project-structure.md](docs/project-structure.md) |
| Configuration / env vars | [docs/configuration.md](docs/configuration.md) |
| Telemetry (anonymous, opt-out, `OMA_TELEMETRY_DISABLED=1`) | [docs/telemetry.md](docs/telemetry.md) |
| Domain reference (lifecycle, events, tools, federation, hooks) | [AGENTS.md](AGENTS.md) |
| Deployment topologies (self-host / CF local / CF prod) | [docs/deployment.md](docs/deployment.md) · [docs/runtimes.md](docs/runtimes.md) |
| Browser VM sandbox | [docs/browser-vm-sandbox.md](docs/browser-vm-sandbox.md) |
| Kubernetes sandbox backends | [docs/deploy/k8s-sandbox-backends.md](docs/deploy/k8s-sandbox-backends.md) |
| Website deploy | [docs/website-deploy.md](docs/website-deploy.md) |

The user-facing docs site lives at [`apps/docs`](apps/docs/) (Astro Starlight), published to **[docs.oma.duyet.net](https://docs.oma.duyet.net)**: `pnpm dev:docs` to preview locally, `pnpm build:docs` to build, `pnpm deploy:docs` to ship. The `docs/` folder at the repo root holds internal design RFCs referenced above.

---

## Contributing

Fork → branch (`feat/...`) → `pnpm typecheck && pnpm test` → PR. See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md) for conventions.

---

## License

[Apache 2.0](LICENSE)

> Forked from [openma-ai/open-managed-agents](https://github.com/openma-ai/open-managed-agents).

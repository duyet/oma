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

**Open-source alternative to Claude Managed Agents** — and a foundation for open-source, self-hosted Claude Tag-style agents.

🌐 **[oma.duyet.net](https://oma.duyet.net)** · 📖 **[docs.oma.duyet.net](https://docs.oma.duyet.net)** · 💬 **[github.com/duyet/oma](https://github.com/duyet/oma)**

Write a harness. Deploy. The platform runs it — with sessions, sandboxes, tools, memory, vaults, integrations, and crash recovery out of the box. Drop-in compatible with the Claude Managed Agents API; runs on **Cloudflare Workers + Durable Objects**, or **`docker compose up`** on your own box.

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

The same harness, business logic, and event-log model run on both. Pick the one that matches your hosting story:

| | ![Docker](https://img.shields.io/badge/-Self--host%20(Node)-2496ED?logo=docker&logoColor=white) | ![Cloudflare](https://img.shields.io/badge/-Cloudflare-F38020?logo=cloudflare&logoColor=white) |
|---|---|---|
| Where it lives | Your VPS / Mac / Docker host / fly.io / your k8s | Cloudflare Workers + DO + Containers |
| Storage | SQLite or Postgres + local FS | D1 + KV + R2 |
| Sandbox | Multi-provider — see the [sandbox roster](#sandbox-providers) | Cloudflare Sandbox (Containers) + most of the same roster |
| Time to running | `docker compose up` (~2 min) | `wrangler deploy` (~10 min once configured) |
| Best for | OSS users, on-prem, no CF account, data-resident deploys | Edge scale, no host management, already on CF |

**Same SDK.** Same `/v1/agents` / `/v1/sessions` API. Same Console UI. Same crash-recovery semantics. Switch between them by changing env vars, not code.

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

## Deploy

Three ways to get OMA running, each documented end to end:

| | Target | One-liner | Docs |
|---|---|---|---|
| ![Cloudflare](https://img.shields.io/badge/-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white) | Cloudflare Workers + Durable Objects + Containers | Edge-hosted, no servers to run — `./scripts/setup-cf.sh` provisions D1/KV/R2 and deploys all three workers | [Quick start above](#quick-start-cloudflare-deploy) · [docs/deployment.md](docs/deployment.md) |
| ![Docker](https://img.shields.io/badge/-Docker%20Compose-2496ED?logo=docker&logoColor=white) | Any Docker host (VPS, Mac, on-prem) | `docker compose up -d` — SQLite or Postgres, LocalSubprocess sandbox by default | [Quick start above](#quick-start-self-host-docker) · [docs/self-host.md](docs/self-host.md) |
| ![Kubernetes](https://img.shields.io/badge/-Kubernetes%20(Helm)-326CE5?logo=kubernetes&logoColor=white) | Self-host Node **on** a k8s cluster, with k8s-backed sandboxes | `helm install oma-k8s-bridge charts/oma-k8s-bridge …` installs the in-cluster gateway that hands OMA (Cloudflare or Node) real k8s-pod or OpenShell sandboxes | [docs/deploy/k8s-bridge-quickstart.md](docs/deploy/k8s-bridge-quickstart.md) · [docs/deploy/k8s-bridge.md](docs/deploy/k8s-bridge.md) · [docs/deploy/k8s-sandbox-backends.md](docs/deploy/k8s-sandbox-backends.md) |

**What "Kubernetes" means here precisely:** OMA's control plane itself still runs as either the Cloudflare Workers deployment or the self-host Node deployment (`apps/main-node`, which can itself run as a Deployment on the same cluster via `docker compose`-equivalent manifests). Kubernetes is the **sandbox backend** — the `charts/oma-k8s-bridge` Helm chart installs an in-cluster gateway (`k8s-sandbox-gateway` for raw pods, or a `k8s-bridge` running the OpenShell gRPC backend) that either runtime talks to over plain HTTP/gRPC to create, exec into, and destroy per-session sandboxes as real pods. There's a standalone CLI bridge daemon too (`deploy/cli-bridge-daemon/`) for the `subprocess` sandbox provider's relay, deployable in-cluster with no RBAC. See [AGENTS.md § Sandbox Provider on the Cloudflare Deployment](AGENTS.md#sandbox-provider-on-the-cloudflare-deployment) for the full k8s-remote vs openshell comparison.

---

## Feature highlights

### 🧠 Bring your own model

![Anthropic](https://img.shields.io/badge/Anthropic-Claude-D97757?logo=anthropic&logoColor=white) ![OpenAI](https://img.shields.io/badge/OpenAI-compatible-412991?logo=openai&logoColor=white) ![AnyRouter](https://img.shields.io/badge/AnyRouter-one--click%20OAuth-2ea043)

- **Model Cards** — per-tenant LLM credentials (`ant` / `ant-compatible` / `oai` / `oai-compatible`); an agent just references `agent.model = "<model_id>"`.
- **AnyRouter one-click connect** — OAuth into [AnyRouter](https://anyrouter.dev) from the Console, no pasted key. Auto-provisions `anyrouter-strong` / `anyrouter-fast` model cards, live credit balance, model + preset picker.
- **Default provider fallback** — `ANTHROPIC_API_KEY` or `ANYROUTER_API_KEY` env vars when no Model Card matches, so a fresh install can run an agent immediately.
- **Poolside** (`harness: "poolside"`) — drive [poolside.ai](https://poolside.ai) `laguna`/`malibu` agentic-coding models over the same OpenAI-compatible loop.

### 🧩 Harnesses — pluggable "how"

| Harness | What it does |
|---|---|
| `default` | Standard AI-SDK tool loop, prompt-cache-safe context engineering |
| `claude-agent-sdk` | Runs the actual Claude Code CLI subprocess (self-host Node only) |
| `poolside` | Same loop, swapped model resolver for poolside.ai |
| `acp-proxy` | Delegates the whole loop to a local ACP agent (Claude Code, Codex) via `oma bridge daemon` |
| `oma-remote` | Proxies every turn to a session on a **federated** OMA instance |
| *custom* | Implement `HarnessInterface`, register by name — see [Write a Harness](#write-a-harness) |

### 📦 Sandbox providers

Every sandbox — cloud container, local process, browser tab, or another cluster entirely — sits behind one `SandboxExecutor` interface.

<a name="sandbox-providers"></a>

| Provider | Runs on | Notes |
|---|---|---|
| ![Cloudflare](https://img.shields.io/badge/-Cloudflare%20Containers-F38020?logo=cloudflare&logoColor=white) | Cloudflare | Default CF sandbox |
| ![Docker](https://img.shields.io/badge/-docker--compose-2496ED?logo=docker&logoColor=white) | Self-host Node | Native Docker-socket driven |
| ![Kubernetes](https://img.shields.io/badge/-k8s%20/%20k8s--remote-326CE5?logo=kubernetes&logoColor=white) | Both | Direct in-cluster pods (Node); gateway-relayed pods on CF via **k8s-sandbox-gateway** |
| **OpenShell** | Both | Policy-enforced isolation via gRPC (Node) or a k8s-bridge relay (CF) |
| **BoxRun** | Both | Remote `boxlite serve` control plane over plain `fetch` |
| **LiteBox** | Self-host Node | Native micro-VM binding |
| **Daytona** / **E2B** | Self-host Node | Driver-SDK cloud sandboxes; not yet bundled into the CF Worker |
| **Local subprocess** (`oma bridge daemon`) | Both (CF via relay) | Runs sandbox ops on a paired local/dev machine over a WebSocket relay — with per-session outbound credential injection |
| **Browser VM** (WASM, v86) | Both (CF via relay) | A browser tab hosts the sandbox — open **Console → Runtimes → Open sandbox tab** |
| **Dynamic Workers** (Code Mode) | Cloudflare only | Ephemeral V8-isolate JS/Wasm eval — no filesystem, millisecond cold start |
| **oma-remote** | Cloudflare (Node: not yet wired) | No local sandbox at all — the whole turn proxies to another OMA instance ([federation](#federation)) |

Full provider-by-provider Cloudflare-availability matrix: [AGENTS.md § Sandbox Provider on the Cloudflare Deployment](AGENTS.md#sandbox-provider-on-the-cloudflare-deployment).

### 💻 Local runtime — ACP bridge

Run **Claude Code, Codex, or any [ACP](https://agentclientprotocol.com/)-compatible agent** as the harness, on the user's own machine, driven entirely from the OMA Console/API. `oma bridge daemon` pairs a machine as a runtime; `harness: "acp-proxy"` + `runtime_binding` targets it. Best-effort model/reasoning-effort overrides via ACP's experimental hooks.

### 🌐 Browser sandbox

No container at all — `sandbox_provider: "browser-vm"` runs the agent's shell inside a **WASM VM (v86) in a browser tab**. Open it from **Console → Runtimes → Open sandbox tab**; the tab pairs as a runtime and services exec/file ops in-browser. Zero-infra sandboxing for demos, workshops, and constrained environments.

### 🔐 Vaults & outbound credentials

**Tools never see your tokens.** Credentials live encrypted in a vault; an outbound HTTP proxy matches request hostnames and injects auth headers at the network layer — a prompt-injected agent has nothing to leak. Supports `static_bearer`, `mcp_oauth`, and `cap_cli` (gh/aws/kubectl/wrangler). Full guide: **[docs/vaults-and-credentials.md](docs/vaults-and-credentials.md)**.

### 🧵 Sessions, events & crash recovery

Every session is an **append-only event log** (DO-SQLite), streamable over SSE, resumable after a crash with zero data loss — the next message replays the log and rebuilds context. Sandbox **pause/resume** snapshots `/workspace` and tears down the container to stop paying for idle compute, independent of session lifecycle.

### 🧠 Memory stores

Persistent storage across sessions, mounted at `/mnt/memory/<store>/` and read/written with the *same* file tools the agent already has (`bash`/`read`/`write`/`edit`/`glob`/`grep`) — no bespoke memory API. Versioned, redactable, CAS-safe writes.

### 🧰 Skills

`SKILL.md` + reference files, mounted into the sandbox and inlined into the system prompt — format-compatible with Anthropic's [Claude Code skills](https://github.com/anthropics/skills).

### ⏱️ Schedules & deployments

- **Agent schedules** — cron-fire a session with no human turn, DST-correct timezones, run history, per-schedule alerts.
- **Deployments** — reusable bundles (agent + version pin + environment + vaults + memory stores) triggered manually, on a cron, or via an unauthenticated-but-token-secured webhook.

<a name="federation"></a>

### 🌍 Cross-instance federation

Delegate a task — or an **entire session** — from one OMA instance to another. `callable_agents` gains a `remote_agent` type for one-off delegation; `sandbox_provider: "oma-remote"` binds a whole session so every turn (and its sandbox) runs on the remote instance while the Console, API, and event log stay local. Depth-1 loop prevention, SSE mirroring, unified cross-instance listing (`?include_remotes=1`). Cloudflare only for now.

### 🔌 MCP — client and server

![MCP](https://img.shields.io/badge/MCP-Model%20Context%20Protocol-6E56CF)

- **As a client** — register any [MCP](https://modelcontextprotocol.io) server per-agent or in a tenant-level registry; calls proxy through the main worker so credentials never touch the sandbox, on every sandbox provider identically.
- **As a server** — OMA exposes its *own* MCP endpoint (`POST /v1/mcp`) so it can be driven from Claude Desktop, Claude Code, Cursor, or VS Code with `list_agents` / `create_agent` / `create_session` / `send_message` / `get_events`.

### 🔗 Integrations

![GitHub](https://img.shields.io/badge/GitHub-issues%20%26%20PRs-181717?logo=github&logoColor=white) ![Slack](https://img.shields.io/badge/Slack-4A154B?logo=slack&logoColor=white) ![Telegram](https://img.shields.io/badge/Telegram-26A5E4?logo=telegram&logoColor=white) ![Linear](https://img.shields.io/badge/Linear-5E6AD2?logo=linear&logoColor=white) ![Matrix](https://img.shields.io/badge/Matrix-000000?logo=matrix&logoColor=white) ![Email](https://img.shields.io/badge/Email-transactional-EA4335?logo=gmail&logoColor=white) ![Webhook](https://img.shields.io/badge/Webhook-HMAC--signed-blue)

Publish an agent into GitHub, Slack, Linear, or Telegram and have it act as a real teammate there — assigned, mentioned, replied to like any other user. Notify targets (`agent.notify`) fan session-status and sandbox-lifecycle alerts out to GitHub comments, Slack/Matrix/Telegram messages, transactional email, or a signed generic webhook. Full guide: **[docs/integrations.md](docs/integrations.md)**.

### 🪝 Agent hooks

Claude-Code-style `pre_tool`/`post_tool` hooks that gate, redact, or modify a tool call via a signed outbound webhook — no custom code inside the Worker/DO. Prompt-cache-safe (only `execute` is wrapped, tool schemas untouched).

### 💰 Publishing & payments

Publish an agent as a consumer-facing bot — hosted chat page, embeddable widget (`<script src=".../widget.js">`), guest/magic-link auth, and optional per-message or per-1k-token metering against a Stripe-backed credit wallet. Full guide: **[docs/publishing.md](docs/publishing.md)**.

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

`agent_toolset_20260401` ships `bash`, `read`, `write`, `edit`, `glob`, `grep`, `web_fetch`, `web_search`, plus scheduling and opt-in `browser`/`run_dynamic_worker`/derived tools (`call_agent_*`, `mcp__<server>__<tool>`). Full catalog and behavior details: **[docs/tools.md](docs/tools.md)**.

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
| Browser VM sandbox | [docs/browser-vm-sandbox.md](docs/browser-vm-sandbox.md) |
| Kubernetes sandbox backends | [docs/deploy/k8s-sandbox-backends.md](docs/deploy/k8s-sandbox-backends.md) |
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

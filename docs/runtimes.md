# Runtimes: harnesses, models, and sandbox images

Three independent choices determine how a coding agent runs. They're
independent on purpose — mixing them (e.g. Grok model + claude-agent-sdk
harness would be nonsensical, but Grok model + default harness + any
sandbox image is fine) is a config change, not a code change.

| Choice | Config field | Where it runs |
|---|---|---|
| **Harness** (model loop) | `agent.harness` | Platform (`apps/agent` for CF, `apps/main-node` for self-host — the self-host Node.js server, same control-plane API as `apps/main`) |
| **Model / provider** | `agent.model` (+ a Model Card) | Platform — the LLM API call itself never touches the sandbox |
| **Sandbox image** | `environment.config.image` (or CF's fixed sandbox-base) | Wherever the sandbox provider runs it (Cloudflare Containers, Daytona, E2B, k8s, local subprocess) |

Only the model call happens off-sandbox; **tool execution** (bash / read /
write / edit / glob / grep) always happens inside the sandbox regardless of
which harness or model is driving it — including for the claude-agent-sdk
harness, whose CLI subprocess bridges its tool calls into the same sandbox
via an in-process MCP server (see
`apps/agent/src/harness/claude-agent-sdk-loop.ts`). This is why a single
sandbox image works across harnesses and providers.

## Harnesses

Registered in `apps/agent/src/index.ts` (Cloudflare) and additionally in
`apps/main-node/src/index.ts` (self-host only):

| Harness | `agent.harness` | Runs on | Notes |
|---|---|---|---|
| Default | `"default"` (or omitted) | CF + self-host | In-process `generateText`/`streamText` loop over `ai-sdk`. |
| ACP proxy | `"acp-proxy"` | CF + self-host | Bridges an Agent Client Protocol server. |
| Long-running | `"long-running"` | CF + self-host | Default loop + periodic `agent.status` heartbeats. |
| Poolside | `"poolside"` | CF + self-host | Default loop against a [poolside.ai](https://poolside.ai) model (`laguna`/`malibu`) over plain OpenAI-compatible `/chat/completions` — pure `fetch`, no Node builtins. Requires `POOLSIDE_API_KEY`; defaults `agent.model` to `poolside/laguna-s-2.1`. See [`AGENTS.md` § Poolside models](../AGENTS.md#poolside-models-harness-poolside). |
| Claude Agent SDK | `"claude-agent-sdk"` | **self-host only** | Spawns Claude Code's CLI as a native subprocess via `@anthropic-ai/claude-agent-sdk`. Requires `child_process` + a real filesystem — unavailable inside a Cloudflare Workers isolate, so it's wired into `apps/main-node`'s harness router only, never the CF worker registry. A copy-paste Docker template for running it lives in `examples/claude-agent-sdk-server/`. |

### Recommended default: `claude-agent-sdk` on self-host

If you're self-hosting (`apps/main-node`, `docker compose`) and want agents
to behave like Claude Code rather than OMA's in-process loop, set
`harness: "claude-agent-sdk"` on the agent. To make this the default for
every agent that doesn't set `harness` explicitly, set the node process's
`DEFAULT_HARNESS` env var:

```bash
# docker-compose.yml / .env
DEFAULT_HARNESS=claude-agent-sdk
```

An agent's own `metadata.harness` (the marker `apps/main-node` actually
reads per-turn) always wins over `DEFAULT_HARNESS` — the env var only fills
the gap when neither `harness` nor `metadata.harness` is set. See
`selectHarnessName` in `apps/main-node/src/lib/harness-select.ts`.

`claude-agent-sdk` also needs auth for its CLI subprocess independently of
the platform's own model credentials: `ANTHROPIC_API_KEY`, or
`CLAUDE_CODE_OAUTH_TOKEN` (minted via `claude setup-token`) when that's
unset. Neither of the other harnesses need this — they use
`ANTHROPIC_API_KEY` (or a Model Card) through the normal `ai-sdk` path.

## Models: Claude vs. Grok (or any OpenAI-compatible provider)

Model choice is a [Model Card](../AGENTS.md#model-configuration), resolved
purely by matching `agent.model` against a card's `model_id` — the
`model_card_id` field some older docs mention is not consulted anywhere in
resolution and can be omitted. `provider` on the card selects the wire
format (`apps/agent/src/harness/provider.ts`):

- `"ant"` / `"ant-compatible"` — Anthropic `/v1/messages`.
- `"oai"` / `"oai-compatible"` — OpenAI `/v1/chat/completions` (never the
  Responses API — see the comment in `provider.ts` for why: third-party
  OpenAI-compat gateways, including xAI's Grok API, only implement
  chat/completions, and the Responses API's server-side function-call-id
  persistence breaks under Zero Data Retention).

xAI Grok is just another `"oai-compatible"` Model Card pointed at
`https://api.x.ai/v1`. See [`examples/grok-coding-agent`](../examples/grok-coding-agent)
for a full working example, side-by-side with
[`examples/coding-agent`](../examples/coding-agent) (Claude, default
provider fallback).

## Sandbox image matrix (`docker/`)

`docker/build.sh` builds and tags:

| Image | Kind | Use for |
|---|---|---|
| `oma-runtime-base` | `docker/base` | Generic toolset sandbox (git, gh, ripgrep, python3, build-essential). Default `config.image` for daytona/e2b/k8s/boxrun adapters. |
| `oma-runtime-claude-agent-sdk` | `docker/claude-agent-sdk` | Alias for `oma-runtime-base` today — see the file's own comment for why (the CLI subprocess runs on the platform host, not in the sandbox). Named separately so it's pinnable and can diverge later. |
| `oma-runtime-coding-agent-openai-compat` | `docker/coding-agent-openai-compat` | Alias for `oma-runtime-base` today, for the same reason. Named separately for the same forward-compat reason. |

```bash
docker/build.sh                    # build + tag all three
docker/build.sh claude-agent-sdk   # build just one kind
```

Cloudflare deployments don't use this matrix — CF sessions always run
`apps/agent/Dockerfile` (`ghcr.io/duyet/sandbox-base:latest`, built by
`.github/workflows/build-sandbox-image.yml`), which `docker/base/Dockerfile`
mirrors but isn't built FROM (that image is pinned to
`cloudflare/sandbox`'s HTTP exec surface, which the daytona/e2b/k8s
adapters don't use).

## Coding-agent-ready image (`sandbox-coding`)

We control the Cloudflare/k8s sandbox image (unlike E2B/Daytona, which bring
their **own** templates — see the note below), so we can pre-bake popular
coding-agent CLIs into a variant instead of cold-installing them per session.

`apps/agent/Dockerfile.coding` is `FROM ghcr.io/duyet/sandbox-base:latest` and
adds, at pinned versions:

| CLI | npm package | Auth env var(s) inside the sandbox |
|---|---|---|
| `claude` | `@anthropic-ai/claude-code` | `ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` (minted via `claude setup-token`) |
| `opencode` | `opencode-ai` | provider key in env — e.g. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` — per opencode's model config |
| `git`, `gh` | (already in `sandbox-base`) | `gh`: a GitHub token (or a `cap_cli` vault credential injected by the outbound proxy) |

Auth reaches the CLI as an ordinary process env var inside the sandbox. Prefer
vault credentials (outbound-proxy injection) over baking secrets into the image
or environment config — the sandbox never needs the raw key on disk.

The same GHCR pipeline (`.github/workflows/build-sandbox-image.yml`) builds and
pushes it as `ghcr.io/duyet/sandbox-coding:latest` (plus `:<claude-code-version>`
and `:sha-*` tags), in a `coding` job that `needs` the `base` job so it always
layers on the freshly-built base.

### Selecting it

Image selection is deployment-wide via the `SANDBOX_IMAGE` env var, which every
remote adapter reads (`boxrun`, `k8s-remote`, `k8s-bridge`, `openshell`,
`daytona`, `e2b`, `k8s`, `subprocess`, `docker-compose`). Point it at the
coding image:

```bash
# Cloudflare (remote providers)
wrangler secret put SANDBOX_IMAGE   # → ghcr.io/duyet/sandbox-coding:latest

# self-host Node / docker-compose (.env)
SANDBOX_IMAGE=ghcr.io/duyet/sandbox-coding:latest
```

The plain Cloudflare Containers path (`cloud` provider) is **fixed** to
`sandbox-base` — it doesn't read `SANDBOX_IMAGE` (it uses the container image
declared in `wrangler.toml`), so to run coding CLIs on Cloudflare you route the
environment through a remote provider (`boxrun` / `k8s-remote` / `k8s-bridge`
/ `openshell`) pointed at `sandbox-coding`.

**Gap (per-environment image):** today `SANDBOX_IMAGE` is a single
deployment-wide value — `environment.config.image` is **not** plumbed into the
adapters (`createRemoteSandbox` in `apps/agent/src/runtime/sandbox.ts` and each
adapter's `sandboxFactory` read `env.SANDBOX_IMAGE`, not the environment
record). So you can't yet pick `sandbox-coding` for one environment and
`sandbox-base` for another within the same deployment. Per-environment image
override is a small follow-up (thread `config.image` into the adapter `opts`),
intentionally out of scope here.

### E2B / Daytona: bring-your-own-template

E2B and Daytona don't run our image — they provision from their own
platform-side template/snapshot (E2B template id, Daytona image). To get the
coding CLIs there, bake them into **your** E2B/Daytona template (mirroring
`Dockerfile.coding`'s `npm install -g`) and set `SANDBOX_IMAGE` to that
template id. `sandbox-coding` is only directly usable on the providers we
control (Cloudflare Containers via a remote provider, k8s, boxrun, subprocess,
docker-compose).

## Choosing a sandbox provider per environment

An environment's `config.sandbox_provider` selects which adapter creates
its sandboxes (`packages/sandbox/src/provider-config.ts`):

| Provider id | Isolation | Config knob for image |
|---|---|---|
| `subprocess` | None — trusted local dev only | N/A (runs on the host) |
| `litebox` | Firecracker micro-VM, local | N/A (fixed rootfs) |
| `boxrun` | Firecracker micro-VM, remote control plane | `SANDBOX_IMAGE` / provider config `image` |
| `daytona` | Managed VM (Daytona SaaS) | provider config `image`, default `ghcr.io/duyet/oma-runtime-base:latest` |
| `e2b` | Firecracker microVM (E2B SaaS) | E2B template, default `node:22-slim`-equivalent |
| `k8s` | Pod via the agent-sandbox controller | provider config `image`, default `ghcr.io/duyet/oma-runtime-base:latest` |
| `cloud` | Cloudflare Containers | fixed — `ghcr.io/duyet/sandbox-base:latest` |
| `openshell` | NVIDIA OpenShell gateway (gRPC) | provider config `image`, default `ghcr.io/nvidia/openshell-community/sandboxes/base:latest` |
| `browser-vm` | Browser tab (WASM VM) — **Cloudflare only** | N/A — no image; the browser host page boots the engine itself (v86 by default). Self-host Node lists the provider but reports `not_configured`. See [Browser-VM Sandbox](browser-vm-sandbox.md). |

Point `daytona`/`e2b`/`k8s`/`boxrun` at `oma-runtime-base:latest` (or a
registry-pushed tag of it) instead of the bare `node:22-slim` default to
get git/gh/ripgrep/python3 pre-installed instead of cold-installing them
per session.

### Local (`subprocess`) environments on the Cloudflare deployment — the bridge relay

`sandbox_provider: "subprocess"` (alias `"local"`) means "run this
environment's sandbox on my own machine." On **self-host Node** it's the
`LocalSubprocessSandbox` running in-process. On the **Cloudflare
deployment** a Worker can't spawn `child_process`, so instead of failing,
OMA relays each sandbox op to a machine you paired with `oma bridge setup`:

```
[agent DO, CF]                       [your machine]
  BridgeRelaySandbox ── sandbox.op ──►  oma bridge daemon
   (exec/read/write/…)   over the        BridgeSandboxManager
                         RuntimeRoom DO   (child_process, per-session workdir
   sandbox.result ◄────  WebSocket        under ~/.local/share/oma/sandboxes/<sid>)
```

Enable it end-to-end:

1. On the machine that should execute the work:
   `npx @getoma/cli bridge setup` (pairs the machine, installs + starts the
   daemon service), then confirm `oma bridge status` shows *connected*.
2. Create an environment with `{"config": {"sandbox_provider": "subprocess"}}`
   (or `"local"`), and an agent/session that uses it. That's it — no
   `wrangler secret`.

When a session runs, the relay picks the tenant's most-recently-heartbeated
online runtime, opens a `sandbox:<sid>`-tagged WebSocket to that runtime's
`RuntimeRoom` Durable Object, and forwards ops correlated by `request_id`.
If **no** runtime is online, the first sandbox op fails loudly with a
`session.error`: *"no bridge runtime connected — run `npx @getoma/cli bridge
setup`…"* — it never silently substitutes a different sandbox.
`GET /v1/hosting_types` reports `subprocess` as `healthy` once any runtime is
online, `not_configured` otherwise.

### Outbound vault credentials on the relay path

The daemon starts a **local credential proxy** (`127.0.0.1`, ephemeral port,
one per relayed session — `packages/cli/src/bridge/lib/credential-proxy.ts`).
On each request it asks the platform which vault credential matches the target
host, over the *same* relay socket the sandbox ops use:

```
daemon → relay   { type: "sandbox.outbound.credential", request_id, session_id, host }
relay  → daemon  { type: "sandbox.outbound.credential.result", request_id, ok, token? }
```

The relay answers from `MAIN_MCP.lookupOutboundCredential` — the identical
resolver behind the cloud sandbox's outbound proxy — so the URL→credential
match rule lives in exactly one place. The token is held in the daemon's
memory only (60s TTL cache): it is never written to disk, never placed in the
relayed subprocess's environment, never written into a git config, and never
logged. The subprocess is only ever handed a loopback URL.

**What IS injected**

| Traffic | How |
|---|---|
| plain `http://` from any tool | `HTTP_PROXY` / `http_proxy` point at the local proxy |
| `git` over **HTTPS** | a per-session `GIT_CONFIG_GLOBAL` adds `url."http://127.0.0.1:<port>/__oma_outbound/https/<host>/".insteadOf = https://<host>/`, so git speaks plaintext to loopback and the proxy re-originates the TLS leg upstream |

The generated git config contains no secret, and `include`s your real
`~/.gitconfig` so your identity, aliases, and helpers still apply. It is only
written for hosts that actually have a matching vault credential — if none
does, git is left completely untouched and your own credential helper keeps
working exactly as before.

**What is NOT injected**

Anything that opens its own TLS session: `gh`, `curl https://…`, language HTTP
clients, and anything honoring `HTTPS_PROXY` (the proxy answers `CONNECT` with
405 rather than pretending). Intercepting those requires terminating TLS with a
locally generated CA that the user must trust machine-wide; OMA deliberately
does **not** generate or install one. Those calls reach upstream un-injected
and therefore still use **your machine's own** credentials (e.g. `gh auth
login`) — so only pair machines whose ambient credentials you're fine with the
agent using.

**Failure policy: fail open.** If the platform can't answer a lookup (relay
down, deployment without the `MAIN_MCP` binding), the request is forwarded
**without** injection — the pre-#318 behavior — and a clear warning is written
to the daemon log (`[oma credential-proxy] WARNING: … forwarding WITHOUT
injection`). Failing closed would turn a transient platform blip into a broken
agent turn while adding no protection, since the un-injected path is not a new
exposure.

**Other limitations of the relay path** (vs. self-host
`LocalSubprocessSandbox`): memory-store / session-outputs mounts aren't wired.
Standard file tools, `bash`, git, etc. all work against the per-session
workdir. Because the box runs on your own hardware with zero isolation, only
pair machines you trust the agent to run on.

## Cross-sandbox sub-agents

**Current behavior: a parent and its `callable_agents` children share the
same sandbox instance, not separate ones.** `SessionDO.runSubAgent`
(`apps/agent/src/runtime/session-do.ts`) builds the sub-agent's tools with
`buildTools(subAgent, sandbox, ...)`, passing through the *same*
`SandboxExecutor` the parent turn is already using — it does not provision
a new sandbox from the sub-agent's own environment. The synthesized
`"general"` sub-agent's system prompt says this explicitly: "You share the
same sandbox as the calling agent (files persist) but cannot delegate
further or use MCP tools."

This differs from `AGENTS.md`'s "Multi-Agent Delegation" description
("Creates a child session for the target agent") — a session-thread row and
`session.thread_created` event ARE created per delegation (so Console can
render a delegation tree and thread ids are addressable), but that thread
runs its harness turn against the parent's sandbox, not a freshly
provisioned one bound to the child agent's `environment_id`. A child
`callable_agents` entry's own environment / sandbox provider configuration
is therefore not honored today — every level of delegation runs inside
whatever sandbox the top-level session was created with.

Per-child sandboxes (provisioning each `callable_agents` entry's own
environment/sandbox provider) are on the roadmap but not implemented as of
this writing.

If you need a sub-agent that genuinely runs in a different sandbox
provider or runtime image, don't rely on `callable_agents` for that today —
create a separate top-level session against the desired environment and
orchestrate between the two sessions from outside OMA (e.g. via the REST
API), rather than through `call_agent_*` / `call_agents_parallel`.

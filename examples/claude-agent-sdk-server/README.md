# Self-host server image for the `claude-agent-sdk` harness

A **server-side** template: a Docker image + compose file that boots the
self-hosted Node runtime (`apps/main-node`) preconfigured to drive turns
through `ClaudeAgentSdkHarness` (Claude Code's CLI as a subprocess).

> This is the sibling of [`examples/claude-agent-sdk/`](../claude-agent-sdk),
> which is a **client** demo — an alpine + curl image that registers an agent
> against an already-running instance. That one assumes a server that can run
> the harness; *this* directory is how you get one.

## Prerequisites

- Docker + docker compose, run from the **repo root**.
- An Anthropic credential (see [Model auth](#model-auth)).

## Quick start

```bash
docker compose -f examples/claude-agent-sdk-server/docker-compose.yml up --build
curl localhost:8787/health

# register an agent + send one message
sh examples/claude-agent-sdk-server/run.sh
```

The Console SPA is served from the same port (`http://localhost:8787`).

## What the image adds

Nothing is installed on top of the base `apps/main-node` image — it already
carries the CLI. `@anthropic-ai/claude-agent-sdk` is a dependency of
`apps/agent`, and it ships Claude Code's per-platform CLI binary through
`optionalDependencies`, so the base image's `pnpm install --frozen-lockfile`
already placed it under `/app/node_modules`. There is no `npm i -g
@anthropic-ai/claude-code` step to add, and adding one would shadow the
version the SDK expects.

What the image *does* add is configuration: `DEFAULT_HARNESS=claude-agent-sdk`
plus the documented env surface below.

## Selecting the harness

Two levers, in precedence order
(`apps/main-node/src/lib/harness-select.ts`):

1. **Per agent** — `metadata.harness` on the agent config. Always wins:
   ```json
   { "name": "My agent", "model": "claude-sonnet-4-6",
     "metadata": { "harness": "claude-agent-sdk" } }
   ```
2. **Per deployment** — the `DEFAULT_HARNESS` env var (set to
   `claude-agent-sdk` by this image), applying to every agent that doesn't
   name one itself.

So an agent that explicitly sets `"harness": "default"` still gets OMA's
in-process loop even on this image.

`claude-agent-sdk` is **self-host Node only**. It is deliberately absent from
the Cloudflare Worker harness registry (`apps/agent/src/index.ts`) because the
SDK spawns a native subprocess and needs a real filesystem — neither exists in
a Workers isolate.

## Model auth

Supply exactly one of these to the container:

| Env var | When to use it |
|---|---|
| `ANTHROPIC_API_KEY` | Normal path. `sk-ant-…` from the Anthropic Console. |
| `CLAUDE_CODE_OAUTH_TOKEN` | CI/CD alternative for non-interactive deploys — mint with `claude setup-token`. Only consulted when `ANTHROPIC_API_KEY` is unset. |

Put whichever you use in a `.env` at the repo root; the compose file reads it.

### Pointing at AnyRouter (or another gateway) for cheaper models

`ANTHROPIC_BASE_URL` redirects the CLI at any **Anthropic-compatible**
endpoint, which is how you route this harness through a gateway such as
[AnyRouter](https://anyrouter.dev) to reach cheaper models:

```bash
# .env at the repo root
ANTHROPIC_BASE_URL=https://anyrouter.dev/v1
ANTHROPIC_API_KEY=sk-ar-v1-...
```

Two caveats:

- The gateway must speak the **Anthropic Messages** wire format on that URL,
  not OpenAI's. A gateway's OpenAI-compatible `/chat/completions` route will
  not work here — this harness is the Claude Code CLI, which only speaks
  Anthropic's protocol. (For OpenAI-compatible providers use a Model Card with
  the `default` harness, or the `poolside` harness — see AGENTS.md.)
- Model ids must be whatever that gateway expects. AnyRouter addresses models
  as `provider/model`, e.g. `anthropic/claude-sonnet-4-6`, so set the agent's
  `model` accordingly.

`ANTHROPIC_CUSTOM_HEADERS` is also honored for gateways needing extra headers.

## Sandbox provider

The compose file sets `SANDBOX_PROVIDER=subprocess` (alias `local`) — tool
calls run as child processes of the server, rooted at
`SANDBOX_WORKDIR=/app/data/sandboxes`, which is bind-mounted to `./data` on the
host so workspaces survive `docker stop`.

This is the zero-infrastructure default. On self-host Node the full
`SandboxProviderRegistry` is available, so you can instead select
`docker-compose`, `k8s`, `boxrun`, `litebox`, `daytona`, or `e2b` per
environment via an environment record's `config.sandbox_provider` — see the
sandbox provider table in [`AGENTS.md`](../../AGENTS.md).

Note that `subprocess` gives the agent real access to the server container's
filesystem and network. Treat the container as the trust boundary, and use a
`docker-compose` or `k8s` provider if you need per-session isolation.

## Credential injection

This compose file omits the `oma-vault` sidecar for brevity. To get vault
credential injection (so the agent can call authenticated APIs without ever
seeing the token), use the repo-root `docker-compose.yml` instead and add the
harness-selection env vars from this file to its `oma-server` service.

## Required secrets

- `PLATFORM_ROOT_SECRET` — at-rest encryption for stored credentials.
  **Back it up**; losing it makes every encrypted row unreadable.
  (`openssl rand -base64 32`)
- `BETTER_AUTH_SECRET` — signs Console sessions (`openssl rand -hex 32`).
  Not needed while `AUTH_DISABLED=1`.

`AUTH_DISABLED=1` is the compose default so the quick start works with no
setup; it makes every request tenant `default`. Turn it off for anything
shared.

## What happens at runtime

1. The Node session runtime receives a `user.message` and starts
   `ClaudeAgentSdkHarness`.
2. The harness calls `query()` from `@anthropic-ai/claude-agent-sdk`, which
   spawns the Claude Code CLI as a subprocess and speaks a JSON control
   protocol over its stdio.
3. The CLI's own built-in tools are disabled (`tools: []`); every model-facing
   tool call is instead bridged to OMA's sandbox through an in-process MCP
   server exposing bash/read/write/edit/glob/grep — so the agent never touches
   the host filesystem directly.
4. The SDK's message stream is translated into OMA `agent.message` /
   `agent.tool_use` / `agent.tool_result` events and persisted to the event
   log.

Because the CLI owns its own context window, OMA's compaction and
context-engineering ports are deliberate no-ops for these turns.

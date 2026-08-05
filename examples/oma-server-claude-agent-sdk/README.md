# OMA server — Claude Agent SDK harness

**Image:** `oma-server-claude-agent-sdk:dev`

Self-host **server** template: boots `apps/main-node` with
`DEFAULT_HARNESS=claude-agent-sdk` so turns run through Claude Code's CLI
subprocess (`ClaudeAgentSdkHarness`).

| Name | What it is |
|---|---|
| **`oma-server-claude-agent-sdk`** | This image — control plane + harness host |
| **`oma-runtime-claude-agent-sdk`** | Sandbox *tool* image alias under `docker/` — **not** this |
| **`oma/main-node:dev`** | Generic self-host server (no harness default) |

## Quick start

```bash
# from repo root
docker compose -f examples/oma-server-claude-agent-sdk/docker-compose.yml up --build
curl localhost:8787/health
sh examples/oma-server-claude-agent-sdk/run.sh
```

Console: `http://localhost:8787`.

## Harness choice (Console + API)

| Harness | Id | Where | When to use |
|---|---|---|---|
| **OMA Standard** | `default` | Cloudflare + self-host | Default in Console; full tools, skills, MCP, OpenAI-compat cards |
| **Claude Agent SDK** | `claude-agent-sdk` | **Self-host only** | Claude Code parity on this image |

Per-agent always wins over `DEFAULT_HARNESS`:

```json
{ "name": "My agent", "model": "claude-sonnet-4-6",
  "metadata": { "harness": "claude-agent-sdk" } }
```

An agent with `"harness": "default"` still gets the OMA Standard loop on this image.

## Skills

Skills attached on the agent are composed into the system prompt / platform
reminders before the harness runs (same as Standard). Attach via Console
**Skills** or `skills: [{ "skill_id": "…", "type": "prompt" }]`.

## MCP servers

Agent `mcp_servers` are discovered by the platform MCP proxy and bridged into
the Claude Agent SDK as additional in-process MCP servers (credentials stay
in the proxy — never in the CLI env). Configure MCP on the agent the same way
as for OMA Standard.

## AnyRouter / Anthropic-compatible gateways

```bash
# .env at repo root
ANTHROPIC_BASE_URL=https://anyrouter.dev/v1
ANTHROPIC_API_KEY=sk-ar-v1-...
```

- Gateway must speak **Anthropic Messages** (`/v1/messages`), not OpenAI chat/completions.
- Model ids must match the gateway (e.g. `anthropic/claude-sonnet-4-6`).
- Prefer per-agent **model cards** (`ant` / `ant-compatible`) when agents need different keys.

For OpenAI-compatible providers, use **OMA Standard** (or poolside), not this harness.

## Env reference

| Variable | Role |
|---|---|
| `DEFAULT_HARNESS` | Default `claude-agent-sdk` in this image |
| `ANTHROPIC_API_KEY` | CLI auth (normal path) |
| `CLAUDE_CODE_OAUTH_TOKEN` | CLI auth when key unset (`claude setup-token`) |
| `ANTHROPIC_BASE_URL` | Anthropic-compatible gateway (AnyRouter, …) |
| `SANDBOX_PROVIDER` | Default `subprocess` |
| `PLATFORM_ROOT_SECRET` | Required for encrypted vault/federation data |

## Runtime path

1. Node session runtime starts `ClaudeAgentSdkHarness`.
2. SDK `query()` spawns Claude Code CLI.
3. CLI built-ins disabled; tools = OMA sandbox MCP + bridged agent MCP.
4. Stream → OMA `agent.*` events.

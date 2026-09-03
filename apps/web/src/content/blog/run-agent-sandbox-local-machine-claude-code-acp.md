---
title: "Running the Agent Sandbox on Your Own Machine with Claude Code and ACP"
description: "Point OMA at your laptop instead of a cloud container. The subprocess sandbox provider relays tool calls to a local daemon; the ACP proxy harness runs Claude Code itself locally. Setup, commands, and the limitations."
publishedAt: 2026-07-18
author: OMA
tags: ["local", "bridge", "acp", "claude-code", "sandbox", "guide"]
---

Every OMA session needs somewhere to run `bash` / `read` / `write` — a
sandbox. By default that's a Cloudflare Container or whatever remote
provider your environment points at. Sometimes that's the wrong place:
the repo is huge and you don't want to re-clone it into a fresh
container every session, the code is private and you'd rather it never
leave your laptop, or you just want the agent to use the toolchain
you already have installed — your `gh` auth, your language versions,
your dotfiles.

`oma bridge` solves this by pairing your machine with the platform as a
**runtime**. Once paired, there are two independent ways to put it to
work, and it's worth being precise about which one you want:

| | Sandbox provider (`subprocess`) | ACP proxy harness (`acp-proxy`) |
|---|---|---|
| What runs locally | Tool execution only (`bash`, `read`, `write`, `edit`, `glob`, `grep`) | The entire agent loop — Claude Code, Codex, Grok Build, … |
| What still runs on the platform | The model loop (`generateText` against your model/vault) | Nothing — OMA just relays session events |
| Model auth | Platform's model resolution (vault / Model Card / env fallback) | The local ACP child's own auth |
| Agent config | `environment.config.sandbox_provider: "subprocess"` | `agent.harness: "acp-proxy"` + `runtime_binding` |
| Works with any harness/model | Yes | Any detected ACP child — Claude Code (`claude-acp`), Codex (`codex-acp`), Grok Build (`grok-build`), … |

You can use either on its own, or both together. This post covers the
one-time pairing, then each path.

## One-time setup: pair the machine

```bash
npx @getoma/cli bridge setup
```

This opens your browser to authorize the machine against your OMA
account, then installs a user-scope background service (launchd on
macOS, systemd on Linux, Task Scheduler on Windows) that keeps `oma
bridge daemon` running and reconnecting — including across reboots and
logins. If you'd rather not install a service (e.g. you're debugging,
or your platform doesn't have a supported service manager), pass
`--no-service` and the setup command execs straight into the daemon in
the foreground instead, so you still don't need a second command.

Check that it worked:

```bash
oma bridge status
```

This prints your `runtime_id`, the workspaces (tenants) the daemon is
authorized for, and whether the daemon process is actually alive right
now. You'll need `runtime_id` later for the ACP proxy harness — the
subprocess sandbox provider doesn't need it, it just relays to
whichever paired daemon most recently heartbeated.

If you have `claude` (Claude Code) installed locally, setup also offers
to install `@agentclientprotocol/claude-agent-acp`, the ACP wrapper
around your `claude` binary — accept it if you want the ACP proxy
harness path below. You can re-run this detection any time after
installing a new CLI:

```bash
oma bridge agents refresh --yes
```

## Path 1: tool execution on your machine (`subprocess` sandbox provider)

The agent still runs the normal way — OMA's harness drives the model
loop against whatever provider your agent is configured for — but
every tool call gets relayed over a WebSocket to your paired daemon,
executed on your machine, and streamed back. This works whether you're
on the hosted platform or self-hosting; no Cloudflare secret to set,
since the relay goes through the tenant's paired runtime rather than a
`wrangler secret`.

Create an environment that selects it:

```bash
ENV_ID=$(curl -s -X POST $BASE/v1/environments \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "my-laptop",
    "config": { "sandbox_provider": "subprocess" }
  }' | jq -r .id)
```

(`"local"` is accepted as an alias for `"subprocess"`.)

Create a session against it as usual:

```bash
SID=$(curl -s -X POST $BASE/v1/sessions \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d "{\"agent_id\":\"$AGENT_ID\",\"environment_id\":\"$ENV_ID\"}" | jq -r .id)

curl -s -X POST $BASE/v1/sessions/$SID/events \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"ls the workspace"}]}]}'
```

The first `bash` call in that session lands on your machine, not a
container. If no daemon is currently paired and online, the call fails
fast with a `session.error` telling you to run `bridge setup` — it
doesn't hang waiting for a container that will never boot.

## Path 2: the whole agent loop on your machine (`acp-proxy` harness)

This is the deeper integration: instead of OMA calling a model API and
dispatching tools itself, the platform spawns your own `claude` CLI —
via its ACP wrapper, `claude-agent-acp` (registry id `claude-acp`) — on
your machine for the session, and just proxies Agent Client Protocol
events back and forth. OMA never drives a `generateText` call for these
sessions; system prompt and skills land on your filesystem as
`AGENTS.md` / `.claude/skills/...` from a bundle the daemon fetches, not
through the events stream. Model calls happen through your local
`claude` CLI's own authentication — your Claude subscription or a local
`ANTHROPIC_API_KEY` — not the platform's model billing.

Grab your `runtime_id` from `oma bridge status` (or `GET /v1/runtimes`,
which lists every runtime paired to your account), then set the
harness and bind the agent to it:

```bash
RUNTIME_ID=rtm_xxx   # from `oma bridge status`

AID=$(curl -s -X POST $BASE/v1/agents \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "local-claude-code",
    "model": "claude-sonnet-4-6",
    "system": "You are a coding assistant running on the user'\''s own machine.",
    "harness": "acp-proxy",
    "runtime_binding": {
      "runtime_id": "'"$RUNTIME_ID"'",
      "acp_agent_id": "claude-acp"
    }
  }' | jq -r .id)
```

(`model` is mostly informational here for display — the actual model
call is whatever your local `claude` CLI is configured to use, not a
platform-side resolution.)

`runtime_binding.acp_agent_id` must be `"claude-acp"` — older docs and
some existing configs may reference the pre-rename aliases
`claude-agent-acp` or `claude-code-acp`; both canonicalize to
`claude-acp` automatically, but new agents should use the canonical id
directly.

Optionally hide specific locally-installed skills from this agent
without touching your real `~/.claude/skills/`:

```json
"runtime_binding": {
  "runtime_id": "...",
  "acp_agent_id": "claude-acp",
  "local_skill_blocklist": ["some-internal-skill-id"]
}
```

The daemon enforces this by not symlinking that skill's directory into
the per-session `CLAUDE_CONFIG_DIR` it builds for the spawned child —
everything else in `~/.claude/` (settings, credentials, agents,
commands, plugins) is symlinked through untouched.

Run a session the same way as any other agent — `POST /v1/sessions`,
then `user.message` events. The daemon spawns the ACP child on the
first turn and reuses it for subsequent turns in the same session.

## Limitations

Both paths trade platform guarantees for running on hardware OMA
doesn't control:

- **Vault injection on `subprocess` is loopback, not TLS MITM.** The
  daemon runs a per-session credential proxy on `127.0.0.1`. git over
  HTTPS and plain `http://` calls receive the session's vault token
  (a `cap_cli` `gh` token on `api.github.com` is enough to rewrite
  `github.com` remotes). `gh`, `curl https://…`, and any other tool
  that opens its own TLS session still use the machine's credentials —
  OMA does not install a CA. ACP children (`acp-proxy`) do not go
  through that proxy at all. MCP server calls are unaffected: those
  still go through `/v1/mcp-proxy`, so MCP credentials never touch
  your machine.
- **Memory-store and session-outputs mounts aren't wired** for either
  path. If an agent depends on `/mnt/memory/<store>/`, don't route it
  through `subprocess` or `acp-proxy` yet.
- **`acp-proxy` is not Claude-only.** The overlay first-class ids are
  `claude-acp`, `codex-acp`, `grok-build`, `hermes`, and `openclaw`;
  anything else the daemon detects from the live ACP registry also
  appears in the Console. This post still walks through Claude Code
  because that was the day-one path; Grok Build is the same binding
  with `acp_agent_id: "grok-build"` and `model: "grok-4.6"`.
- **If no daemon is online**, the first operation on either path fails
  loudly with a `session.error` rather than silently falling back to a
  cloud sandbox — that's intentional, so you're never surprised about
  where your code actually ran.

## Why bother

The two paths solve different problems. `subprocess` is the cheap
win if you just want the agent's shell to be *your* shell — your repo
already checked out, your build cache warm, no per-session container
cold start. `acp-proxy` is for when you want Claude Code's own loop —
the one you already trust and already pay for — driving the session,
with OMA contributing session lifecycle, event streaming, and
multi-agent orchestration around it rather than reimplementing the
loop itself.

Both start from the same one-time `oma bridge setup`. Try `subprocess`
first if you're not sure which you want — it's the smaller commitment
and works with any agent you've already built.

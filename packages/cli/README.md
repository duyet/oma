# @getoma/cli

Command-line client for [oma](https://oma.duyet.net) managed agents — agents, sessions, environments, vaults, memory, schedules, channel publishing (Linear / GitHub / Slack), and the local-runtime bridge.

> **Pre-1.0 (0.1.x).** API surface and command names may still change in a patch release.

## Run it

No install needed:

```bash
npx @getoma/cli auth login
npx @getoma/cli agents list
```

Or install globally to get the short `oma` binary:

```bash
npm i -g @getoma/cli
oma auth login
```

The examples below use `npx @getoma/cli`; with a global install, replace it with `oma`.

## Configure

Either log in interactively (recommended) or set env vars.

```bash
# Browser handoff (default), device-code, or paste-token for headless boxes
npx @getoma/cli auth login                 # opens the console, waits for the redirect back
npx @getoma/cli auth login --device        # print a code, approve it in any browser
npx @getoma/cli auth login --paste-token   # fully headless: paste a token minted in the console
```

Or point the CLI at a deployment directly:

```bash
export OMA_API_KEY=oma_...
export OMA_BASE_URL=https://app.oma.duyet.net   # default
```

Generate an API key from the [oma console](https://oma.duyet.net) → API Keys.

## Quick start

```bash
npx @getoma/cli agents create my-agent --model claude-sonnet-4-6
npx @getoma/cli envs create default
npx @getoma/cli sessions create --agent <agent-id> --env <env-id>
npx @getoma/cli sessions chat <session-id> "Run the test suite and summarize failures"
npx @getoma/cli sessions tail <session-id>     # follow the event stream live
```

## Command tree

Run `npx @getoma/cli --help` for flags and details on every command. The same
help is reachable per group and per command, so you never have to page the
full dump:

```bash
npx @getoma/cli --version          # print the CLI version (also -V, or `oma version`)
npx @getoma/cli sessions --help    # every command in the sessions group
npx @getoma/cli help sessions      # same thing, spelled the other way
npx @getoma/cli agents list --help # one command, with the endpoint it calls
```

`--json` on any list command prints the raw array instead of the human table,
so you can pipe it into `jq`. It works on an empty result too (`[]`, not a
"No rows." sentence), and it applies to `agents list`, `sessions list`,
`envs list`, `models list`, `keys list`, and `whoami`.

```bash
npx @getoma/cli agents list --json | jq -r '.[].id'
```

| Group | Commands |
|---|---|
| **Auth** | `auth login` (browser / `--device` / `--paste-token`), `auth logout`, `whoami`, `auth tenant ls`, `auth tenant use <id>` |
| **Agents** | `agents list` · `create <name> [--model <id>]` · `get <id>` · `delete <id>` |
| **Sessions** | `sessions list` · `create --agent <id> --env <id>` · `message <id> <text>` · `chat <id> <text>` (streamed) · `tail <id>` · `logs <id>` |
| **Environments** | `envs list` · `envs create <name>` · `envs get <id>` · `envs delete <id>` |
| **Model cards** | `models list` · `models create --model-id <id> --api-key <key>` |
| **API keys** | `keys list` · `keys create [name]` · `keys revoke <id>` |
| **Vaults** | `vaults list` · `vaults create <name>` · `creds list <vault-id>` · `cli add --vault <id> --cli-id <gh\|aws\|…> --token <t>` |
| **Skills** | `skills list` · `skills install <slug>` (from ClawHub) |
| **MCP** | `connect <server\|url> --vault <id>` (OAuth) |
| **Memory** | `memory stores create/list/get/archive/delete` · `memory write/read/ls/update/rm` · `memory versions/version/redact` |
| **Schedules** | `schedules create <agent-id> --cron <expr> --env <id> --input <text>` · `list` · `run` · `delete` |
| **Runtimes** | `runtime list` · `runtime rm <id>` |
| **Linear** | `linear list/pubs/get/publish/submit/handoff/update/unpublish/install-pat` · `linear rules list/create/patch/delete` |
| **GitHub** | `github list/pubs/get/bind/submit/handoff/update/unpublish` |
| **Slack** | `slack list/pubs/get/publish/submit/handoff/update/unpublish` |
| **Bridge** | see below |
| **API reference** | `api` · `api <resource>` — print the HTTP endpoint map |

## Bridge — relay a local machine into OMA

The bridge pairs a machine you own (laptop, workstation, homelab box) with your OMA deployment so agents can run against its local runtimes. It relays securely outbound — no inbound ports needed.

Two things run over the same relay: local **ACP agents** (Claude Code and friends), and **local environments** — an agent on the cloud deployment whose environment is `sandbox_provider: "subprocess"` (or `"local"`) has its sandbox ops (exec, file read/write, …) executed on this paired machine. So `bridge setup` is all you need to make cloud agents run against your own box.

```bash
npx @getoma/cli bridge setup        # pair this machine + install the daemon service
npx @getoma/cli bridge status       # daemon liveness + authorized workspaces + server probe
npx @getoma/cli bridge refresh      # reconcile authorized tenants + reload daemon
npx @getoma/cli bridge agents refresh   # re-detect local agents + offer wrapper installs
npx @getoma/cli bridge uninstall    # stop service + remove creds
```

Once paired, the machine appears on the Console's **Sandbox Runtime** page and can be revoked there or with `runtime rm`.

`bridge status` reports the local daemon's health alongside the server probe: whether the background process is running and currently connected, how fresh its last heartbeat is, its uptime, and the workspaces it's authorized to run agents for. It also lists the **running sessions** on this machine's runtime — session id, agent name, status, and started/last-activity age — with a clickable dashboard link (`<server>/sessions/<id>`) and an `oma sessions tail <id>` hint per row. The daemon keeps its connection alive with a 25s heartbeat, drops and reconnects (with jittered backoff) if the server stops responding, and survives transient network loss without killing in-flight conversations.

### Where relayed sandbox ops run

By default those ops run **directly on the paired machine** (`/bin/sh` in a per-session workdir): the agent sees your real files, toolchains, and CLI auth, with no isolation — that's the point of a local environment.

If you run an [OpenShell](https://github.com/NVIDIA/OpenShell) gateway on the same machine, you can have them run inside an OpenShell sandbox instead — isolated, with gateway-enforced egress, but **empty**: none of your repos or installed tools are visible. It's opt-in only; `bridge setup` offers it when it detects a gateway, or set `BRIDGE_SANDBOX_BACKEND=openshell` (plus `OPENSHELL_GATEWAY_ENDPOINT`) for the daemon. `bridge status` shows the active backend and, for OpenShell, whether the gateway is reachable.

This changes **only** sandbox-op execution — local ACP agents (Claude Code and friends) still spawn on the host either way. Two known limitations: the relay carries no environment config, so OMA's environment→policy mapping isn't applied (the gateway's own default policy governs egress), and a daemon crash leaves boxes behind on the gateway.

## Environment variables

| Var | Purpose |
|---|---|
| `OMA_BASE_URL` | API base (default `https://app.oma.duyet.net`) |
| `OMA_API_KEY` | API key — overrides stored credentials when set |
| `XDG_CONFIG_HOME` | Base dir for credentials (default `~/.config`) |
| `BRIDGE_SANDBOX_BACKEND` | `subprocess` (default) or `openshell` — where the bridge daemon runs relayed sandbox ops |
| `OPENSHELL_GATEWAY_ENDPOINT` | OpenShell gateway `host:port` (default `127.0.0.1:8080`) |
| `OPENSHELL_TOKEN` / `OPENSHELL_IMAGE` | Gateway bearer token / sandbox image |
| `OPENSHELL_GATEWAY_TLS`, `..._CA_PATH`, `..._CERT_PATH`, `..._KEY_PATH` | TLS / mTLS material for the gateway channel |

Stored credentials live at `~/.config/oma/credentials.json`.

## License

MIT

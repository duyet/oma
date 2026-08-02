# Agents Guide

This document covers the core concepts, lifecycle, and configuration of agents in Open Managed Agents.

---

## Core Concepts

Open Managed Agents is built around a **meta-harness** architecture with four key abstractions:

### Agent

An **agent** is a configuration object that defines _what_ an AI assistant can do. It specifies the model, system prompt, available tools, skills, and optional connections to other agents or MCP servers.

Agents are versioned — every update creates a new version. Sessions bind to a specific agent version at creation time.

### Session

A **session** is a running conversation between a user and an agent. It owns an append-only **event log** stored in a Durable Object backed by SQLite. Sessions are the unit of state — agents themselves are stateless configurations.

Sessions can be streamed in real-time via SSE, resumed after crashes, and archived when complete.

### Environment

An **environment** defines the execution sandbox — what packages are installed, what networking is allowed, and what container image to use. Environments are reusable across sessions and agents.

### Vault

A **vault** is a secure credential store. Credentials in vaults are **never exposed to sandboxes** — they're injected via an outbound proxy that intercepts HTTP requests and adds authentication headers transparently.

---

## Agent Lifecycle

```
                    ┌──────────┐
                    │  Create   │  POST /v1/agents
                    └────┬─────┘
                         │
                    ┌────▼─────┐
              ┌────►│  Active   │◄────┐
              │     └────┬─────┘     │
              │          │           │
         ┌────┴───┐ ┌───▼────┐ ┌───┴─────┐
         │ Update  │ │ Archive│ │ Sessions│
         │ (new    │ │        │ │ use it  │
         │ version)│ └───┬────┘ └─────────┘
         └─────────┘     │
                    ┌────▼─────┐
                    │ Archived  │
                    └──────────┘
```

1. **Create** — `POST /v1/agents` with name, model, system prompt, and tools
2. **Use** — Create sessions referencing the agent by ID
3. **Update** — `PUT /v1/agents/:id` creates a new version; existing sessions keep their original version
4. **Archive** — `POST /v1/agents/:id/archive` soft-deletes the agent

---

## Agent Configuration

### Minimal Agent

```json
{
  "name": "Assistant",
  "model": "claude-sonnet-4-6",
  "system": "You are a helpful assistant.",
  "tools": [{ "type": "agent_toolset_20260401" }]
}
```

### Full Configuration

```json
{
  "name": "Full-Stack Developer",
  "description": "A coding agent with access to tools, skills, and external services.",
  "model": "claude-sonnet-4-6",
  "system": "You are an expert full-stack developer. Write clean, tested code.",
  "tools": [
    {
      "type": "agent_toolset_20260401",
      "default_config": { "enabled": true },
      "configs": [
        { "name": "web_search", "enabled": false }
      ]
    },
    {
      "type": "custom",
      "name": "deploy",
      "description": "Deploy the application to production",
      "input_schema": {
        "type": "object",
        "properties": {
          "environment": { "type": "string", "enum": ["staging", "production"] }
        },
        "required": ["environment"]
      }
    }
  ],
  "mcp_servers": [
    { "name": "github", "type": "url", "url": "https://mcp.github.com/sse" }
  ],
  "skills": [
    { "skill_id": "skill_xxx", "type": "prompt" }
  ],
  "callable_agents": [
    { "type": "agent", "id": "agent_yyy" }
  ],
  "model_card_id": "mc_xxx",
  "aux_model": "claude-haiku-4-5",
  "harness": "default",
  "metadata": {
    "team": "platform",
    "owner": "alice"
  }
}
```

### Configuration Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Display name for the agent |
| `description` | string | No | Human-readable description |
| `model` | string or object | Yes | Model identifier (e.g. `"claude-sonnet-4-6"`) or `{ id, speed }` |
| `system` | string | Yes | System prompt — defines the agent's behavior and persona |
| `tools` | array | No | Tool configurations (toolsets, custom tools) |
| `mcp_servers` | array | No | External MCP server connections |
| `skills` | array | No | Skill references to mount into the sandbox |
| `callable_agents` | array | No | Other agents this agent can delegate to |
| `max_parallel_subagents` | number | No | Concurrency cap for `call_agents_parallel` (default 5, hard ceiling 10) |
| `model_card_id` | string | No | Reference to a model card for custom provider config |
| `aux_model` | string or object | No | Auxiliary model used by tools for in-process LLM work (e.g. `web_fetch` page summarization). Same shape as `model`. When unset, tools that would benefit from summarization fall back to returning raw content. |
| `aux_model_card_id` | string | No | Companion to `aux_model` — explicit model card binding when needed |
| `harness` | string | No | Harness implementation to use (default: `"default"`) |
| `metadata` | object | No | Arbitrary key-value metadata |
| `appendable_prompts` | string[] | No | Opt-in registry of prompt IDs to inject as additional system prompt segments at session/turn start. Empty/missing = no extra segments |
| `enable_general_subagent` | boolean | No | Opt-in built-in delegation tool. When true, the harness exposes a `general_subagent(task)` tool that spawns a generic sub-agent thread inheriting this agent's model + sandbox — bypasses the `callable_agents` roster |
| `notify` | array | No | Notification targets to post session-status updates to (issue/PR comments, chat messages) — see [Notify Targets](#notify-targets) |
| `hooks` | array | No | Declarative pre/post-tool + lifecycle hooks that gate/redact tool calls via a signed outbound webhook — see [Agent Hooks](#agent-hooks) |

See [`examples/`](examples/) for copy-paste-ready agent and environment
configs (coding assistant, data analyst, research agent, plus full harness
demos with pre-built Docker images).

---

## Tools

### Built-in Toolset

The `agent_toolset_20260401` provides 8 tools designed for general-purpose agent work:

| Tool | Description | Key Behaviors |
|---|---|---|
| **bash** | Execute shell commands | 2min default timeout, 10min max. Auto-backgrounds long-running processes. SIGTERM on timeout. |
| **read** | Read files | Returns file content with line numbers. Handles binary detection. |
| **write** | Write files | Creates parent directories automatically. |
| **edit** | String replacement | Surgical find-and-replace. Fails if `old_str` not found or ambiguous. |
| **glob** | File search | Pattern matching (e.g. `**/*.ts`). Returns sorted file list. |
| **grep** | Content search | Regex search across files. Returns matching lines with context. |
| **web_fetch** | URL → markdown | Fetches a URL, converts HTML/PDF/DOCX/etc. to markdown via Workers AI `env.AI.toMarkdown()`. When `agent.aux_model` is set, large pages (>5KB) are summarized by the aux model and the full markdown is offloaded to `/workspace/.web/<sha>.md` (readable via the `read` tool with offset/limit). Falls back to raw curl with an explicit warning if extraction fails. |
| **web_search** | Web search | Defaults to DuckDuckGo (free, no key). Optional backends via tool `type`: `web_search_20250305` (Anthropic server-side, Claude models only), `web_search_tavily` (requires `TAVILY_API_KEY`). |

### Opt-in Tools

These tools are **not** enabled by default even when the toolset is on — the
agent must add an explicit `{ "name": "<tool>", "enabled": true }` to
`configs`. They're gated because they bias the model toward a heavier or
runtime-specific path:

| Tool | Description | Availability |
|---|---|---|
| **browser** | Full browser session (navigate / click / screenshot / fill). `web_fetch` + `web_search` cover most read-only research more cheaply. | CF (Browser Rendering) or Node self-host (playwright-core / CDP). |
| **run_dynamic_worker** | "Code Mode" — execute an ephemeral JS (or best-effort Python) snippet in a fresh Cloudflare **Dynamic Worker** (V8 isolate) and get the result back. A pure compute/eval primitive, distinct from the session sandbox: **no filesystem, no shell, no package installs, nothing persists between calls**. Lets the agent crunch/transform data programmatically instead of round-tripping through the LLM (Cloudflare's cited "up to 80% inference-token savings"). Network is blocked by default (`allow_network: false` ⇒ egress fully sandboxed); `allow_network: true` inherits the worker's default egress (vault credential-injection gateway for the eval sandbox is a follow-up). | **Cloudflare only** — needs the `LOADER` Worker Loader binding (`worker_loaders` in `wrangler.jsonc`). Absent binding (Node self-host, or CF without the entitlement) ⇒ tool omitted from `buildTools()`, so the model never sees it. |

```json
{
  "type": "agent_toolset_20260401",
  "configs": [{ "name": "run_dynamic_worker", "enabled": true }]
}
```

> **Note:** This is Phase 1 of [issue #139](https://github.com/duyet/oma/issues/139).
> The companion `dynamic-workers` **sandbox provider** (a specialized JS-eval
> executor selectable per-environment via `config.sandbox_provider:
> "dynamic-workers"`) shipped in Phase 2 — see the Cloudflare sandbox-provider
> table under [Sandbox Provider on the Cloudflare Deployment](#sandbox-provider-on-the-cloudflare-deployment).

### Tool Configuration

Enable or disable individual tools:

```json
{
  "type": "agent_toolset_20260401",
  "default_config": { "enabled": false },
  "configs": [
    { "name": "bash", "enabled": true },
    { "name": "read", "enabled": true },
    { "name": "write", "enabled": true },
    { "name": "edit", "enabled": true }
  ]
}
```

Set permission policies:

```json
{
  "type": "agent_toolset_20260401",
  "configs": [
    {
      "name": "bash",
      "enabled": true,
      "permission_policy": { "type": "always_ask" }
    }
  ]
}
```

### Custom Tools

Define tools with JSON Schema input validation. Custom tools pause the session with `stop_reason: { type: "requires_action", action_type: "custom_tool_result" }` and wait for the client to provide the result:

```json
{
  "type": "custom",
  "name": "send_email",
  "description": "Send an email to a user",
  "input_schema": {
    "type": "object",
    "properties": {
      "to": { "type": "string" },
      "subject": { "type": "string" },
      "body": { "type": "string" }
    },
    "required": ["to", "subject", "body"]
  }
}
```

### Derived Tools

These tools are automatically generated based on session configuration:

| Tool | Generated When | Purpose |
|---|---|---|
| `call_agent_*` | `callable_agents` configured | Delegate work to another agent (one at a time, blocks until idle) |
| `call_agents_parallel` | `callable_agents` configured | Fan out to multiple sub-agents concurrently and aggregate their results |
| `mcp_*` | `mcp_servers` configured | Call MCP server tools |

(Memory stores do **not** generate bespoke tools. Each attached store is
mounted at `/mnt/memory/<store_name>/` in the sandbox and the agent uses the
standard file tools — `bash`/`read`/`write`/`edit`/`glob`/`grep` — to access
it. See [Memory Stores](#memory-stores) below.)

---

## Sessions

### Session Lifecycle

```
  POST /v1/sessions          POST /events            Harness completes
         │                        │                        │
    ┌────▼────┐             ┌─────▼─────┐           ┌─────▼─────┐
    │  idle    │────────────►│  running   │──────────►│   idle     │
    └─────────┘             └─────┬─────┘           └───────────┘
                                  │
                            (on crash)
                                  │
                            ┌─────▼─────┐
                            │   idle     │  + session.error event
                            └───────────┘
```

- **idle** — Waiting for user input
- **running** — Harness is actively processing (model calls, tool execution)
- **rescheduled** — Container is being provisioned; will resume automatically
- **terminated** — Session ended (explicit termination or error)

### Sandbox Pause & Resume

Orthogonal to the lifecycle above: `sandbox_status` (`"running"` | `"paused"` |
`"none"`) tracks whether the session's sandbox container is currently
provisioned, independent of `idle`/`running`/`terminated`. Pausing is
reversible — unlike termination — and exists purely to stop paying for an
idle container.

```bash
# Snapshot /workspace and destroy the container. Refuses (409) while a
# turn is in-flight. No-op (200) if already paused.
curl -s -X POST $BASE/v1/sessions/$ID/pause -H "x-api-key: $KEY"
# → {"id": "sess_xxx", "sandbox_status": "paused"}

# Reprovision the container and restore the latest workspace snapshot.
# No-op (200) if not paused.
curl -s -X POST $BASE/v1/sessions/$ID/resume -H "x-api-key: $KEY"
# → {"id": "sess_xxx", "sandbox_status": "running"}
```

Sending a `user.message` to a paused session implicitly resumes it (the
sandbox warms lazily on first use, same as a fresh session) — an explicit
`/resume` call is only needed to pay the cold-start cost up front instead
of on the next message.

### Event Types

Sessions communicate through a typed event log. Events fall into four categories:

**User events** (sent by the client):

| Event | Description |
|---|---|
| `user.message` | User sends a message (text, images, documents) |
| `user.interrupt` | User interrupts a running agent |
| `user.tool_confirmation` | User allows or denies a tool call |
| `user.custom_tool_result` | User provides result for a custom tool |
| `user.define_outcome` | User defines success criteria for evaluation |

**Agent events** (emitted by the harness):

| Event | Description |
|---|---|
| `agent.message` | Agent text response |
| `agent.thinking` | Agent thinking/reasoning |
| `agent.tool_use` | Agent calls a built-in tool |
| `agent.tool_result` | Result from a tool execution |
| `agent.custom_tool_use` | Agent calls a custom tool (pauses session) |
| `agent.mcp_tool_use` | Agent calls an MCP server tool |
| `agent.mcp_tool_result` | Result from an MCP tool |
| `agent.status` | Structured progress heartbeat (`state`, `summary`, `step`, `total_steps`, `blocked_on`) for long-running work. OMA extension — purely observational, excluded from model context. Emitted per model turn by `default`, and on a fixed cadence by the `long-running` harness. |

**Session events** (lifecycle signals):

| Event | Description |
|---|---|
| `session.status_running` | Harness started processing |
| `session.status_idle` | Harness finished; includes `stop_reason` |
| `session.status_rescheduled` | Waiting for container provisioning |
| `session.status_terminated` | Session ended |
| `session.sandbox_paused` | Sandbox snapshotted + destroyed via `POST /pause`. OMA extension. |
| `session.sandbox_resumed` | Sandbox reprovisioned via `POST /resume`. OMA extension. |
| `session.error` | Error occurred (may be retryable) |

**Observability events** (spans):

| Event | Description |
|---|---|
| `span.model_request_start` | Model API call started |
| `span.model_request_end` | Model API call completed (per-call `model_usage` breakdown — input, output, cache_read, cache_creation, reasoning) |
| `span.outcome_evaluation_start` | Outcome evaluation began |

**Token usage tracking.** Every model call — the primary loop, sub-agent
threads, and aux-model calls (e.g. `web_fetch` summarization) — credits its
full token breakdown into the per-tenant `usage_events` table as distinct
kinds: `model_input_tokens`, `model_output_tokens`, `model_cache_read_tokens`,
`model_cache_creation_tokens`, `model_reasoning_tokens`. `GET /v1/usage`
(tenant, `?group_by=agent`) and `GET /v1/agents/:id/stats` (per-agent, incl.
`cache_hit_ratio`) aggregate these without replaying the DO event log; the
Console **Usage** and per-agent **Observability** pages render the 4-way split
plus cache hit ratio.

### Streaming

Sessions support real-time SSE streaming:

```bash
# SSE stream (recommended for real-time UIs)
curl -N https://your-instance/v1/sessions/{id}/events/stream \
  -H "x-api-key: $KEY"

# JSON polling
curl https://your-instance/v1/sessions/{id}/events \
  -H "x-api-key: $KEY" \
  -H "Accept: application/json"

# Content negotiation
curl https://your-instance/v1/sessions/{id}/events \
  -H "x-api-key: $KEY" \
  -H "Accept: text/event-stream"
```

### Crash Recovery

The event log enables automatic crash recovery:

1. Harness crashes mid-execution
2. SessionDO catches the error, emits `session.error`, returns to `idle`
3. Next `user.message` creates a fresh harness instance
4. New harness reads the full event log, rebuilds context, and continues

No data is lost because events are durably written to SQLite **before** being broadcast.

---

## Environments

Environments define the sandbox where tools execute:

```json
{
  "name": "data-science",
  "config": {
    "type": "cloud",
    "packages": {
      "pip": ["numpy", "pandas", "matplotlib", "scikit-learn"],
      "apt": ["ffmpeg"]
    },
    "networking": {
      "type": "unrestricted"
    }
  }
}
```

### Package Managers

| Manager | Field | Example |
|---|---|---|
| Python (pip) | `packages.pip` | `["numpy", "pandas"]` |
| Node.js (npm) | `packages.npm` | `["lodash", "express"]` |
| System (apt) | `packages.apt` | `["ffmpeg", "imagemagick"]` |
| Rust (cargo) | `packages.cargo` | `["ripgrep"]` |
| Ruby (gem) | `packages.gem` | `["rails"]` |
| Go | `packages.go` | `["golang.org/x/tools/..."]` |

### Networking

```json
{
  "networking": {
    "type": "limited",
    "allowed_hosts": ["api.github.com", "registry.npmjs.org"],
    "allow_mcp_servers": true,
    "allow_package_managers": true
  }
}
```

### Auto-Clone

An environment can declare `config.git_repo` to clone a repo into
`/workspace` on every session's sandbox start, reusing the same
`github_repository` resource machinery a session's explicit repo resources
use (`mountResources` → `mountGitRepo`):

```json
{
  "config": {
    "git_repo": { "url": "https://github.com/acme/widgets", "branch": "main" }
  }
}
```

`mount_path` defaults to `/workspace`; skipped if a session resource already
targets the same path. Cloning is unauthenticated unless the outbound
proxy's vault-credential fallback resolves a token for the host — like
explicit repo resources, `credential_id` isn't yet wired into the clone
auth path.

### Sandbox Provider on the Cloudflare Deployment

An environment's `config.sandbox_provider` (or legacy `config.type`) selects
the sandbox adapter. On self-host Node, `apps/main-node` — the self-host Node.js server (the same control-plane API as the `apps/main` Cloudflare Worker, packaged for `docker compose`) — resolves it through
the full `SandboxProviderRegistry` (`packages/sandbox`) — every adapter is
available there. On the **Cloudflare deployment**, only a subset works,
because a Worker is a single-file V8 isolate with no filesystem, no
`child_process`, and no runtime dynamic-import resolution:

| `sandbox_provider` | Cloudflare behavior |
|---|---|
| absent / `"cloud"` / unrecognized id | CloudflareSandbox (unchanged default — Cloudflare Containers) |
| `"boxrun"` | Works — talks to a remote BoxRun (`boxlite serve`) control plane over plain `fetch`, no driver SDK. Requires `BOXRUN_URL` (`wrangler secret put`); missing it fails clearly with a `session.error` rather than silently falling back. |
| `"k8s-remote"` | Works — talks to an in-cluster **k8s-sandbox-gateway** over plain `fetch` (boxrun-shaped HTTP API: create / exec+SSE / files-as-tar / destroy), no Node builtins. Requires `K8S_SANDBOX_GATEWAY_URL` (`wrangler secret put`); missing it fails clearly with a `session.error` (parity with boxrun's missing-`BOXRUN_URL`). The self-host Node path keeps using the direct `KubernetesSandboxExecutor` (in-cluster, unchanged). **Limitation:** memory-store / session-outputs bind-mounts aren't available over the HTTP tar API — like boxrun, those mounts aren't exposed by the gateway. |
| `"openshell"` | Works — the OpenShell gateway is gRPC-only (a Worker can't speak gRPC), so CF talks to a **k8s-bridge running its OpenShell backend** (`BRIDGE_BACKEND=openshell`) over plain `fetch`, reusing the same `K8sBridgeSandbox` client as `k8s-bridge`. Requires `OPENSHELL_BRIDGE_URL` (`wrangler secret put`; optional `OPENSHELL_BRIDGE_TOKEN`); missing it fails clearly with a `session.error` (parity with boxrun's missing-`BOXRUN_URL`). The self-host Node path keeps speaking gRPC to the gateway directly. **Limitation:** memory-store / session-outputs mounts aren't available over the HTTP API — like boxrun and k8s-remote. |
| `"daytona"` / `"e2b"` | Outbound-HTTP-only in principle (no Node builtins), but **not yet wired on Cloudflare** — their driver SDKs (`@daytonaio/sdk`, `e2b`) aren't bundled into the Worker. Selecting either fails clearly with a `session.error`; both already work on the self-host Node runtime. |
| `"subprocess"` (alias `"local"`) | Works **via the bridge relay** when the tenant has a paired machine online. A Worker can't spawn `child_process`, so each sandbox op (exec, read/write files, setEnvVars, destroy) is relayed to the tenant's most-recently-heartbeated `oma bridge daemon` over the RuntimeRoom DO WebSocket, executed on that machine, and streamed back — the sandbox sibling of the ACP agent relay. Enable it by running `npx @getoma/cli bridge setup` on the machine; no `wrangler secret`. When no runtime is online, the first sandbox op fails clearly with a `session.error` ("no bridge runtime connected — run `bridge setup`…"). **Outbound credentials (issue #318):** the daemon runs a loopback credential proxy per session; it asks the platform which vault credential matches a host (`sandbox.outbound.credential` over the same relay socket, answered from `MAIN_MCP.lookupOutboundCredential` — the same resolver the cloud outbound proxy uses) and injects the header itself. The token stays in the daemon's memory: never on disk, never in the child's environment, never logged. **This covers plain `http://` traffic (via `HTTP_PROXY`) and `git` over HTTPS** — git is re-pointed at the proxy by a per-session `url.<loopback>.insteadOf` rewrite, so the proxy re-originates the TLS leg. It does **not** cover tools that open their own TLS session — `gh`, `curl https://…`, language HTTP clients — because intercepting those needs a locally generated CA trusted machine-wide, which OMA deliberately does not install. Those still fall back to **the machine's own** credentials, so only pair a machine whose ambient credentials you're fine with the agent using. **Other limitations:** memory-store / session-outputs mounts aren't wired. See `BridgeRelaySandbox` (`apps/agent/src/runtime/bridge-relay.ts`) and `BridgeSandboxManager` (`packages/cli/src/bridge/lib/bridge-sandbox.ts`). |
| `"dynamic-workers"` | Works — a **JS/Wasm eval isolate** per exec via the **Worker Loader** binding (`env.LOADER`), not a Linux box: `exec` runs the command as a JS module in a fresh ephemeral V8 isolate (millisecond cold start, egress blocked by default via `globalOutbound: null`); `readFile`/`writeFile`/`startProcess`/`gitCheckout` fail clearly with a "not supported by dynamic-workers" error (no shell, no filesystem, no package installs, nothing persists between calls). Availability is a **binding**, not a secret: `worker_loaders` must be declared in the agent worker's `wrangler.jsonc` (`"worker_loaders": [{ "binding": "LOADER" }]`); absent binding fails clearly with a `session.error`. **Cloudflare-only** — the self-host Node runtime rejects it up front (`nodeCompatible: false`). Best for pure code-eval / Code-Mode agents, untrusted-snippet execution, and per-call compute-only sub-agents. See `DynamicWorkerSandbox` (`packages/sandbox/src/adapters/dynamic-workers.ts`). |
| `"browser-vm"` | Works **via the RuntimeRoom relay** to a browser tab hosting a WASM VM — the tab twin of the `subprocess` bridge daemon. The user opens `GET /sandbox-tab` (Console → Runtimes → "Open sandbox tab"), which pairs as a runtime with `kind: "browser-vm"` and services sandbox ops against an in-tab engine (v86 by default; WebContainers/CheerpX are BYO-license). No online tab ⇒ the first op fails clearly with a `session.error`. **Limitations:** no vault outbound MITM from the tab, no memory-store / session-outputs mounts, networking is engine-proxied (no raw TCP). See `docs/browser-vm-sandbox.md` and `BrowserVmRelaySandbox` (`apps/agent/src/runtime/browser-vm-relay.ts`). |
| `"litebox"` / `"k8s"` / `"docker-compose"` | Node-only (a native micro-VM binding, local kubeconfig/filesystem access, or a Docker socket) — cannot run in a Worker at all, and no relay path. Selecting one fails clearly with a `session.error` explaining to use the self-host runtime instead. |

See `classifyCfSandboxProvider` (`packages/sandbox/src/provider-config.ts`)
for the classification and `resolveCfSandbox`
(`apps/agent/src/runtime/sandbox.ts`) for the resolution + error path.

#### `k8s-remote` vs `openshell` — which Kubernetes path

Both let a Worker drive in-cluster sandboxes, but on different substrates:

| | `k8s-remote` | `openshell` |
|---|---|---|
| Sandboxes are | raw **k8s pods** you own (`Sandbox` CRD, one per session) | **OpenShell** managed sandboxes (isolated container/microVM) |
| In-cluster component | **k8s-sandbox-gateway** wrapping `KubernetesSandboxExecutor` | **k8s-bridge** with `BRIDGE_BACKEND=openshell` wrapping `OpenShellManager` |
| Gateway ⇄ sandbox | k8s `pods/exec` WebSocket | **gRPC** `openshell.v1.OpenShell` |
| Egress control | k8s `NetworkPolicy` + OMA outbound proxy | OpenShell **SandboxPolicy** (mapped from the OMA env config) |
| Cluster RBAC | **yes** (pod create/exec/delete) | **no** — the bridge owns no cluster, only calls the gateway |

Pick `k8s-remote` for ordinary pods on a cluster you fully control; pick
`openshell` for OpenShell's policy-enforced isolation without OMA holding
cluster RBAC. Both drop memory-store / session-outputs mounts. Full
comparison + deploy steps (Helm chart + `deploy/cli-bridge-daemon/`
manifests): [`docs/deploy/k8s-sandbox-backends.md`](docs/deploy/k8s-sandbox-backends.md).

The **CLI bridge daemon** (`oma bridge daemon`, the `subprocess` provider's
relay) also supports the OpenShell backend: answer the `oma bridge setup`
prompt, or set `BRIDGE_SANDBOX_BACKEND=openshell` plus
`OPENSHELL_GATEWAY_ENDPOINT=<host:port>`, and each sandbox op is relayed to an
OpenShell gateway over gRPC instead of the local subprocess. Selection is
explicit opt-in only — an endpoint on its own never flips the backend, since
silently swapping a laptop's host relay for an empty sandbox would hide the
user's real repos and toolchains. Logic: `resolveSandboxBackend`
(`packages/cli/src/bridge/lib/sandbox-backend.ts`). The daemon can run
in-cluster as a Deployment with no RBAC (outbound-only) — see
`deploy/cli-bridge-daemon/`.

### Environment Status

Environments go through a build process:

- **building** — Container image is being prepared with requested packages
- **ready** — Environment is available for use
- **error** — Build failed (check logs)

---

## Vaults & Credentials

Vaults provide secure credential management with a key design principle: **credentials never enter the sandbox**.

```bash
# Create a vault
curl -s $BASE/v1/vaults \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"name": "production-secrets"}'

# Add a GitHub token
curl -s $BASE/v1/vaults/$VAULT_ID/credentials \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "display_name": "GitHub Token",
    "auth": {
      "type": "static_bearer",
      "mcp_server_url": "https://api.github.com",
      "token": "ghp_xxx"
    }
  }'
```

### Credential Types

| Type | Use Case | Injection Method |
|---|---|---|
| `static_bearer` | API tokens (GitHub, etc.) | `Authorization: Bearer` header on matching URLs |
| `mcp_oauth` | OAuth-authenticated MCP servers | Token refresh + injection via outbound proxy |
| `cap_cli` | CLI tools (gh, aws, kubectl, wrangler, ...) | `Authorization` header injected at the outbound-proxy/network layer for a registered CLI's endpoints (`cap.builtinSpecs`), matched by `cli_id` — replaces the older `command_secret` type, which injected tokens straight into the subprocess env (leaky) |

### How It Works

1. Session is created with `vault_ids`
2. Sandbox makes an HTTP request (e.g., to `api.github.com`)
3. Outbound proxy intercepts the request
4. Proxy matches the URL against vault credentials
5. Proxy injects the appropriate auth header
6. Request reaches the external service with credentials
7. Sandbox never sees the raw token

---

## MCP Servers

Agents connect to remote MCP servers via `agent.mcp_servers`. The platform
proxies every MCP call through the main worker (`/v1/mcp-proxy`), which is
the only layer that ever holds the upstream credential — the sandbox and
harness never see it. Because resolution happens in the proxy (not the
sandbox), MCP servers work identically across **every** sandbox provider
(Cloudflare, k8s-bridge, boxrun, subprocess, …). Local-runtime ACP agents
receive proxy-rewritten server URLs in their spawn-cwd bundle and inject the
per-tenant PAT as the bearer.

### Tenant-level registry

Instead of repeating a server URL on every agent, register it once at the
tenant level and reference it by id:

```bash
# Register a server (optionally pinning a vault credential)
curl -s $BASE/v1/mcp_servers \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"name": "linear", "url": "https://linear.app/mcp", "credential_id": "cred_xxx"}'
# → { "id": "mcps_xxx", "name": "linear", "url": "...", ... }
```

Reference it from an agent's `mcp_servers` via `registry_id` (in place of an
inline `url`):

```json
{ "mcp_servers": [{ "name": "linear", "type": "http", "registry_id": "mcps_xxx" }] }
```

At request time the proxy expands `registry_id` → the registered URL and, if
the row pins a `credential_id`, injects that specific vault credential;
otherwise it falls back to matching a vault credential by the server URL
(the same rule inline entries use). An inline `url` always wins over
`registry_id`. Routes: `POST/GET/PATCH/DELETE /v1/mcp_servers`.

### Health check

`GET /v1/mcp-proxy/_health/:sid` (Bearer `omak_*`) reports, per declared MCP
server on the session's agent, whether its credential currently resolves —
`{ session_id, servers: [{ name, status }] }` where `status` is `"ok"` or
`"unresolved"`. Powers the sandbox status page's MCP health indicator. Pass
`?probe=1` to additionally perform a real upstream JSON-RPC round-trip per
server (parallel, ~5s timeout each, so one hung upstream can't stall the
rest) — `status` can then also be `"unreachable"`, with an added
`latency_ms` on a completed probe. Opt-in because it costs a real upstream
call per server; each probe shares the same per-tenant rate-limit budget
as the MCP proxy's forward path (see `docs/mcp-credential-architecture.md`),
so a spent budget silently degrades that server back to the presence-only
`"ok"` rather than failing the request.

---

## OMA as an MCP Server

The platform ships its **own** MCP server so OMA can be driven from Claude
Desktop, Claude Code, Cursor, or VS Code — no bespoke SDK. It's a single
streamable-HTTP endpoint at `POST /v1/mcp` (JSON mode of MCP Streamable
HTTP), mounted on both runtimes (`apps/main` Cloudflare Worker and
`apps/main-node` self-host).

**Auth:** the tenant API key, accepted as either `Authorization: Bearer
<key>` (what MCP clients send) or `x-api-key: <key>`. Every tool call
re-enters the platform's own HTTP API with that key, so tools run through the
exact same auth + business logic as a direct REST call — no logic is
duplicated in the MCP layer (`packages/http-routes/src/mcp/`).

**Tools exposed:**

| Tool | Maps to | Purpose |
|---|---|---|
| `list_agents` | `GET /v1/agents` | List the tenant's agents |
| `create_agent` | `POST /v1/agents` | Create an agent (name, model, system prompt; default toolset) |
| `create_session` | `POST /v1/sessions` | Start a session for an agent (optional `environment_id`) |
| `send_message` | `POST /v1/sessions/:id/events` | Send a `user.message` (async — poll for the reply) |
| `get_events` | `GET /v1/sessions/:id/events` | Read the session event log (supports `after_seq` paging) |

`send_message` is non-blocking: it appends the user message and returns
immediately; call `get_events` (paging with `after_seq`) to read the agent's
response and tool activity.

### Client config

Claude Desktop / Cursor / VS Code (streamable HTTP, Bearer auth):

```json
{
  "mcpServers": {
    "oma": {
      "type": "http",
      "url": "https://<your-instance>/v1/mcp",
      "headers": { "Authorization": "Bearer <YOUR_TENANT_API_KEY>" }
    }
  }
}
```

Claude Code:

```bash
claude mcp add oma --transport http https://<your-instance>/v1/mcp \
  --header "Authorization: Bearer <YOUR_TENANT_API_KEY>"
```

---

## Memory Stores

Memory stores provide persistent storage for agents across sessions, aligned
with the [Anthropic Managed Agents Memory contract](https://platform.claude.com/docs/en/managed-agents/memory).
Each attached store is mounted into the sandbox at `/mnt/memory/<store_name>/`.
The agent reads and writes it with the **standard file tools**
(`bash` / `read` / `write` / `edit` / `glob` / `grep`) — there are no
bespoke `memory_*` tools.

```bash
# Create a memory store
curl -s $BASE/v1/memory_stores \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"name": "project-knowledge", "description": "Learnings about the codebase"}'

# Attach to a session (Anthropic-aligned `instructions` field, 4096 char cap)
curl -s $BASE/v1/sessions/$SESSION_ID/resources \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"type": "memory_store", "memory_store_id": "ms_xxx",
       "access": "read_write",
       "instructions": "Your project notes. Check before starting any task."}'
```

Then inside the session the agent does:
```bash
ls /mnt/memory/project-knowledge/
cat /mnt/memory/project-knowledge/architecture.md
echo "..." > /mnt/memory/project-knowledge/notes/2026-04-29.md
```

**Storage:** R2 holds the bytes-of-truth (key `<store_id>/<memory_path>`);
D1 holds the index + audit, kept eventually consistent via R2 Event
Notifications → Cloudflare Queue → Consumer in `apps/main`. REST API writes
update the audit row inline (strong-consistent); agent FUSE writes audit
asynchronously (typically <30s). Local dev (`wrangler dev`) does not fire
R2 events — REST writes still audit, agent FUSE writes don't.

**Versioning + rollback:** Every mutation creates an immutable
`memory_versions` row with the content snapshot inline (capped at 100KB).
30-day retention with the most-recent version per memory always preserved.
Rollback = retrieve the desired version's content and write it back via
`memories.update` — produces a new version naturally.

**Redact:** wipes content/path/sha on a prior version, leaving the audit
row. Refuses to redact the live head — write a new version first.

**CAS:** pass `precondition: { type: "content_sha256", content_sha256 }` on
update to refuse stale-write clobbers. Use `precondition: { type: "not_exists" }`
on create to refuse occupied paths.

**CLI:**
```bash
oma memory stores create "User Preferences" --description "Per-user prefs"
oma memory write <store-id> /preferences/formatting.md --from-file local.md
oma memory ls <store-id> --prefix /preferences/
oma memory versions <store-id> --memory-id <mem-id>
oma memory redact <store-id> <version-id>
```

---

## Multi-Agent Delegation

Agents can delegate work to other agents using `callable_agents`:

```json
{
  "name": "Lead Developer",
  "model": "claude-sonnet-4-6",
  "system": "You are a lead developer. Delegate research to the researcher agent.",
  "tools": [{ "type": "agent_toolset_20260401" }],
  "callable_agents": [
    { "type": "agent", "id": "agent_researcher" }
  ]
}
```

This generates a `call_agent_researcher` tool. When invoked, the platform
(`runSubAgent` in `apps/agent/src/runtime/session-do.ts`):

1. Spawns a child **thread** for the target agent — its own message history
   and `sthr_*` id (surfaced as `thread_id`/`session_thread_id`), nested
   inside the parent *session* rather than a separate top-level session
2. Forwards the message
3. Waits for the child to reach `idle`
4. Returns the child's response to the parent

**Sandbox scope:** by default a sub-agent thread shares the parent's
sandbox (same `/workspace`, same files) — the cheap path, and what every
agent config gets today since `environment_id` is unset. A `callable_agents`
roster entry can opt a specific sub-agent into its own sandbox by setting
`environment_id` to a different environment than the parent session's own:

```json
{
  "callable_agents": [
    { "type": "agent", "id": "agent_researcher", "environment_id": "env_isolated" }
  ]
}
```

When set and different from the parent session's `environment_id`, the
platform resolves that environment record and mints a dedicated
`SandboxExecutor` for just that sub-agent's turn, torn down (best-effort
destroy) once the call returns. API-only for now — no Console UI to set it
yet. Known limitations of a dedicated sub-agent sandbox: it starts from an
empty `/workspace` (no restore-from-backup — nothing persists it across
calls), memory-store and session-outputs mounts aren't wired, and its usage
isn't metered into `sandbox_usage`. Vault credential injection (outbound
proxy) IS wired, so authenticated outbound calls still work. If the target
environment record can't be found, the sub-agent falls back to the parent's
sandbox (logged, not surfaced to the caller). If the environment's
`sandbox_provider` is unavailable on this deployment
(`SandboxProviderUnavailableError` — e.g. a node-only provider requested on
the Cloudflare deployment), the fallback is skipped: that sub-agent call
fails outright, the same way any other per-call delegation failure surfaces
(`success: false` from `call_agents_parallel`, or a tool error for the
single-call path) — running the sub-agent on the wrong sandbox silently
would be worse than failing loudly.

### Parallel Delegation

`call_agent_*` tools run one child at a time — the parent blocks until each
child reaches `idle` before the next call can start. When an agent has 1+
entries in `callable_agents`, the platform also generates a
`call_agents_parallel` tool that fans out to several children **concurrently**
(even to the same sub-agent id, called multiple times) and aggregates their
results:

```json
{
  "calls": [
    { "agent_id": "agent_researcher", "message": "Research topic A" },
    { "agent_id": "agent_researcher", "message": "Research topic B" },
    { "agent_id": "agent_writer", "message": "Draft an outline for topic C" }
  ]
}
```

Returns one result per call, each carrying its own status so a single failing
child doesn't lose the others' results:

```json
{
  "results": [
    { "agent_id": "agent_researcher", "success": true, "response": "...", "thread_id": "sthr_..." },
    { "agent_id": "agent_researcher", "success": true, "response": "...", "thread_id": "sthr_..." },
    { "agent_id": "agent_writer", "success": false, "error": "Sub-agent error: ..." }
  ]
}
```

- `thread_id` is the child's `session_thread_id` (same id emitted on
  `session.thread_created`) — use it to deep-link into that child's event log.
- Concurrency is capped — default 5 in-flight children at once, hard ceiling
  10 regardless of config. Requests beyond the cap queue in waves rather than
  being rejected. Lower (or raise, up to the ceiling) the default via the
  agent's `max_parallel_subagents` field.
- A call targeting an `agent_id` not in the agent's `callable_agents` roster
  fails just that entry (`success: false`) without aborting the batch.

**Remote (federated) fan-out** (issue #132): a call may also target a
`remote_agent` roster entry by passing its federation `instance_id` alongside
the remote `agent_id`. Remote and local calls mix freely in one batch, run
under the **same** `max_parallel_subagents` cap, and each runs
`delegateToRemoteAgent` with the same per-call success/error isolation. Remote
results echo back `instance_id` (and carry no `thread_id`, since the turn runs
on the remote instance's own event log):

```json
{
  "calls": [
    { "agent_id": "agent_local_researcher", "message": "Summarize the local docs" },
    { "agent_id": "agent_remote_specialist", "instance_id": "fed_xxx", "message": "Cross-check against the EU dataset" }
  ]
}
```

```json
{
  "results": [
    { "agent_id": "agent_local_researcher", "success": true, "response": "...", "thread_id": "sthr_..." },
    { "agent_id": "agent_remote_specialist", "instance_id": "fed_xxx", "success": true, "response": "..." }
  ]
}
```

An `(instance_id, agent_id)` pair not in the agent's `callable_agents` roster
fails just that entry (`success: false`), like an unknown local `agent_id`.

---

## Cross-Instance Federation

Federation lets an agent on **one** OMA instance delegate a task to an agent
running on **another** OMA instance (issue #132). It reuses the existing
`callable_agents` delegation seam and the MCP-registry storage pattern, so it
adds no new sandbox surface and mounts identically on Cloudflare and self-host
Node.

### 1. Register a remote instance

Register the remote OMA once at the tenant level (`fed_*` ids). The remote API
key is a real secret we hold to authenticate outbound, so — unlike the MCP
registry, which stores only a vault `credential_id` — it is **encrypted at
rest** (AES-256-GCM under a dedicated `federation.api_key` key derived from
`PLATFORM_ROOT_SECRET`) and **never echoed back**; reads surface `has_api_key`
instead.

```bash
curl -s $BASE/v1/federation/instances \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "eu-cluster",
    "base_url": "https://oma.eu.example.com",
    "api_key": "omak_remote_tenant_key"
  }'
# → 201 { "id": "fed_xxx", "name": "eu-cluster", "base_url": "...",
#         "has_api_key": true, ... }
```

Routes (all tenant-scoped):

```http
POST   /v1/federation/instances                 # Register (201)
GET    /v1/federation/instances                 # List — (created_at, id) DESC
GET    /v1/federation/instances/:id             # Get (api key never returned)
GET    /v1/federation/instances/:id/agents      # Connectivity probe + remote agent discovery
PATCH  /v1/federation/instances/:id             # Update (api_key: null clears it)
DELETE /v1/federation/instances/:id             # Delete
```

`GET /…/:id/agents` performs a server-side `GET /v1/agents` against the remote
using the stored key so an operator can pick a `remote_agent_id` (200 with the
remote roster, or 502 `remote_unreachable`).

### 2. Reference a remote agent from a roster

Add a `type: "remote_agent"` entry to `callable_agents`, pointing at a
registered instance and a remote agent id:

```json
{
  "callable_agents": [
    { "type": "agent", "id": "agent_local_researcher" },
    {
      "type": "remote_agent",
      "instance_id": "fed_xxx",
      "remote_agent_id": "agent_remote_specialist",
      "remote_environment_id": "env_on_remote"
    }
  ]
}
```

This generates a `call_remote_agent_<instance>_<agent>` tool. When invoked, the
platform:

1. Resolves the instance (base URL + decrypted API key). On Cloudflare the
   agent DO has no KV / secret access, so it asks the main worker via the
   `env.MAIN_MCP.resolveFederationTarget` RPC; on self-host Node the harness
   resolves it directly off KV + crypto.
2. Opens a fresh session on the remote instance (`POST /v1/sessions`, optional
   `remote_environment_id`), posts the message, and **polls the remote event
   log until it reaches `session.status_idle`**.
3. Returns the remote agent's concatenated `agent.message` text to the caller
   (a `session.error` on the remote, or a timeout, surfaces as a
   `Remote agent error: …` tool result).

The delegation client is `delegateToRemoteAgent`
(`packages/shared/src/federation.ts`); the tool wiring is in
`apps/agent/src/harness/tools.ts`; the CF executor is
`SessionDO#runRemoteAgent` (`apps/agent/src/runtime/session-do.ts`).

### Security model

- The remote API key never enters a sandbox and is never returned by the API.
- Federation is **instance-to-instance**: the calling instance authenticates
  to the remote with a normal tenant API key stored on the calling side. The
  remote treats the incoming session like any other API-key session — it runs
  in the remote's own sandbox, under the remote tenant's own tools/limits.
- Losing `PLATFORM_ROOT_SECRET` makes stored keys unreadable; resolution then
  fails loud at the remote (401) rather than using stale bytes.

### Deferred (follow-ups on #132)

The delivered slice is a one-shot request/response delegate. Not yet built:
event-log **streaming/mirroring** of the remote turn into the caller's log
(only the final text returns today), remote **identity mapping** beyond the
shared tenant key, a Console UI for the registry + `remote_agent` roster
entries (API-only for now), and inbound-federation trust controls distinct
from the tenant API key.

Federated **parallel fan-out** is now supported: `call_agents_parallel`
accepts remote (`remote_agent`) targets alongside local ones — see
[Parallel Delegation](#parallel-delegation).

---

## Custom Harness

The default harness (`DefaultHarness`) handles most use cases, but you can replace it entirely:

```typescript
import type { HarnessInterface, HarnessContext } from "./harness/interface";
import { generateText } from "ai";
import { resolveModel } from "./harness/provider";

export class DataAnalysisHarness implements HarnessInterface {
  async run(ctx: HarnessContext): Promise<void> {
    const { agent, env, runtime } = ctx;

    // 1. Read conversation history
    const messages = runtime.history.getMessages();

    // 2. Custom context engineering
    //    (e.g., preserve DataFrame outputs, aggressive text compaction)
    const optimized = this.compactForDataWork(messages);

    // 3. Call the model with your strategy
    const result = await generateText({
      model: resolveModel(agent.model, env.ANTHROPIC_API_KEY),
      system: agent.system,
      messages: optimized,
      tools: ctx.tools,      // Pre-built by the platform
      maxSteps: 100,         // Data work needs more steps
    });

    // 4. Broadcast results
    for (const step of result.steps) {
      for (const content of step.content) {
        runtime.broadcast({
          type: "agent.message",
          content: [{ type: "text", text: content.text }],
        });
      }
    }
  }
}
```

Register it:

```typescript
import { registerHarness } from "./harness/registry";
registerHarness("data-analysis", () => new DataAnalysisHarness());
```

Use it:

```json
{ "name": "Data Analyst", "model": "claude-sonnet-4-6", "harness": "data-analysis" }
```

The platform handles everything else — tool construction, skill mounting, sandbox lifecycle, event persistence, crash recovery, and WebSocket broadcasting.

### Poolside models (`harness: "poolside"`)

Drives a turn against a [poolside.ai](https://poolside.ai) model (the
`laguna` / `malibu` agentic-coding family). Poolside exposes plain
**OpenAI-compatible** `/chat/completions` inference, so `PoolsideHarness`
extends `DefaultHarness` and swaps only the resolved model — the tool loop,
compaction, and event emission are entirely the default harness's. It is
pure `fetch` (no Node builtins), so it is registered on **both** runtimes.

```json
{
  "name": "Poolside coder",
  "model": "poolside/laguna-s-2.1",
  "system": "You are a careful coding assistant.",
  "tools": [{ "type": "agent_toolset_20260401" }],
  "harness": "poolside"
}
```

`POOLSIDE_API_KEY` is required (mint one at platform.poolside.ai);
`POOLSIDE_BASE_URL` defaults to `https://inference.poolside.ai/v1` and should
be set to `https://<api-domain>/openai/v1` when pointing at a self-hosted
poolside deployment. `agent.model` is passed through verbatim, including the
`provider/model` prefix. Poolside's separate `pool` ACP coding agent is not
this harness — drive that through `acp-proxy` + a local runtime binding.

### Local ACP Runtime (`harness: "acp-proxy"`)

Instead of running in OMA's cloud sandbox, an agent can delegate its whole
loop to an ACP-compatible child (Claude Code, Codex, …) running on a user's
own machine via `oma bridge daemon`. Set `harness: "acp-proxy"` and
`runtime_binding`:

```json
{
  "harness": "acp-proxy",
  "runtime_binding": {
    "runtime_id": "rt_xxx",
    "acp_agent_id": "claude-acp",
    "model": "claude-sonnet-4-6",
    "reasoning_effort": "high"
  }
}
```

`AcpProxyHarness` forwards `model` / `reasoning_effort` on `session.start` to
the daemon, which applies them **best-effort** against the spawned ACP child
once its session is live — via ACP's still-experimental `session/set_model`
(model) and `session/set_config_option` matched against a `thought_level`
config option (reasoning effort). Neither is a guaranteed capability: most
ACP agents don't advertise support for either as of this writing, in which
case the override is a silent no-op and the child keeps its own default —
outcome is logged to daemon stderr, never surfaced as a `session.error`.
There is no OMA-canonical reasoning-effort value set; `minimal | low |
medium | high` (the OpenAI/Codex convention) is passed through verbatim and
matched case-insensitively against whatever the agent itself advertises.
See `AcpSessionImpl#applyOverrides` (`packages/acp-runtime/src/session.ts`)
and issue [#269](https://github.com/duyet/oma/issues/269).

---

## Skills

Skills are reusable prompt fragments and files that get mounted into the sandbox and injected into the system prompt:

```bash
# Create a skill (files array is required — name/description are extracted
# from the SKILL.md frontmatter below when not passed explicitly)
curl -s $BASE/v1/skills \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "files": [
      {
        "filename": "SKILL.md",
        "content": "---\nname: code-review\ndescription: Review code for security, performance, and test coverage gaps.\n---\n\nWhen reviewing code, check for: security vulnerabilities, performance issues, error handling gaps, and test coverage."
      }
    ]
  }'
```

Attach skills to an agent:

```json
{
  "skills": [
    { "skill_id": "skill_xxx", "type": "prompt" }
  ]
}
```

When a session starts, skills are:
1. Resolved from KV storage
2. Mounted as files in the sandbox (`/home/user/.skills/`)
3. Injected into the system prompt as additional context

---

## Model Configuration

### Direct Model Reference

```json
{ "model": "claude-sonnet-4-6" }
```

### Model with Speed Setting

```json
{ "model": { "id": "claude-sonnet-4-6", "speed": "fast" } }
```

### Model Cards

For custom providers or API configurations, use model cards:

```bash
curl -s $BASE/v1/model_cards \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "GPT-4o via proxy",
    "provider": "openai",
    "model_id": "gpt-4o",
    "base_url": "https://my-proxy.example.com/v1"
  }'
```

Reference in agent config:

```json
{ "model_card_id": "mc_xxx" }
```

Supported providers: `anthropic`, `openai`, `custom`.

### Default Provider Fallback

When an agent's `model` handle matches no Model Card, the Cloudflare
deployment falls back to static env-var secrets, in order:

1. `ANTHROPIC_API_KEY` (+ optional `ANTHROPIC_BASE_URL`) — the long-standing
   default.
2. `ANYROUTER_API_KEY` — routes through [AnyRouter](https://anyrouter.dev),
   an OpenAI-compatible LLM gateway, only when `ANTHROPIC_API_KEY` is unset.
   AnyRouter addresses models as `provider/model` (e.g.
   `anthropic/claude-sonnet-4-6`), so `agent.model` must be set accordingly
   to use this fallback.

An explicit Model Card always wins over both. See
`resolveDefaultProviderCreds` in `apps/agent/src/harness/provider.ts` and
`resolveModelCardCredentials` in `apps/agent/src/runtime/session-do.ts`.

The `claude-agent-sdk` harness (self-host Node only — see
[Custom Harness](#custom-harness)) resolves its CLI subprocess's model +
credentials per-agent (issue #316): when `agent.model` matches a **model
card** handle (or `metadata.model_card_id` pins one), that card's `model`,
API key and `base_url` are exported into the spawned CLI for the turn
(`ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL` / `ANTHROPIC_MODEL`, plus the
SDK's own `model` option). The card's provider must be Anthropic-wire
(`ant` / `ant-compatible` — `anthropic` normalizes to `ant`); an
`oai` / `oai-compatible` card **fails the turn** with an explicit
`session.error` rather than silently falling back, because the Claude Code
CLI speaks only the Anthropic `/v1/messages` format. When no card resolves,
it falls back to the deployment's global env exactly as before:
`ANTHROPIC_API_KEY`, or `CLAUDE_CODE_OAUTH_TOKEN` (minted via
`claude setup-token`) when that's unset — the CI/CD alternative for
non-interactive deploys — plus `ANTHROPIC_BASE_URL`. Resolution lives in
`apps/main-node/src/lib/claude-sdk-model.ts` (card lookup) and
`apps/agent/src/harness/claude-agent-sdk/model.ts` (pure env mapping).

### Connecting AnyRouter (one-click, no pasted key)

Instead of the static `ANYROUTER_API_KEY` env fallback, the Console can
provision a per-tenant AnyRouter key over OAuth — no `sk-ar-…` copy-paste.
On the **Model Cards** page, **Connect to AnyRouter** runs AnyRouter's MCP
OAuth 2.1 flow (Dynamic Client Registration + PKCE-S256; the browser carries
the operator's AnyRouter session through the consent screen), and the minted
`sk-ar-v1-…` key is stored **encrypted twice**: as a `static_bearer` vault
credential (`provider: "anyrouter"`, the connection source of truth) and,
mirrored into the auto-upserted `model_cards` row `model_id: "anyrouter"`
(the only store the agent-run path reads). Any agent with
`{"model": "anyrouter"}` then routes through the gateway with zero further
setup. Reconnect rotates the key in place; disconnect deletes the card and
archives the credential.

Once connected, the panel also offers:

- a **model + preset picker** that retargets the `anyrouter` card against
  AnyRouter's live catalog (`GET /api/v1/models`, `provider/model` ids) and
  saved account presets, plus a live **credit balance**;
- **Create starter agents** — one click provisions two sibling model cards
  sharing the same connected key (`anyrouter-strong` →
  `anthropic/claude-sonnet-4-6`, `anyrouter-fast` →
  `anthropic/claude-haiku-4-5`) and creates two agents wired to them (a
  general assistant on the strong model, a summarizer on the fast one). The
  sibling cards appear in the agent form's model picker like any other card.

Backend routes live under `/v1/providers/anyrouter/*`
(`packages/http-routes/src/providers/anyrouter.ts`): `connect` / `callback`
/ `status` / `disconnect` / `models` / `credits` / `presets`. The pure OAuth
protocol logic is in `packages/anyrouter`. The **AnyRouter connect** flow's
model-card bind + presets remain **Cloudflare only** — those endpoints no-op
on self-host Node (`presets` returns `model_cards_unavailable`) and the
process-global env-var provider is hot-swapped on connect instead. (The
generic `/v1/model_cards` CRUD, however, IS available on self-host Node as of
issue #171 — see [Self-host parity](#self-host-node-parity) below.)

---

## Self-host Node parity

The self-host Node runtime (`apps/main-node`) shares one route implementation
with the Cloudflare Worker (`apps/main`) for the bulk of the control-plane API:
every route group lives in `packages/http-routes` and is mounted by both
runtimes via a `RouteServices` deps bundle. Groups ported to run identically on
both include agents, sessions, environments, vaults, memory stores, dreams,
evals, MCP servers, publications + the public `/p/*` consumer surface, agent +
deployment schedule ticks, and — as of issue #171 — **skills**
(`/v1/skills`, KV metadata + blob-store file bytes), **model cards**
(`/v1/model_cards`, SQLite/Postgres-backed), **stats** (`/v1/stats`), and
**usage** (`/v1/usage`). Node stores skill metadata in its SQL-backed KV
(`@duyet/oma-kv-store/adapters/sql`) and skill/file bytes in its files blob
store (local FS or S3); model cards, usage events, and stats read the same
SQLite/Postgres control-plane DB. `/v1/usage` daily-bucket and per-agent
aggregation is computed dialect-agnostically (JS-side bucketing) so it runs on
both SQLite and Postgres.

Still Cloudflare-only today: the AnyRouter connect model-card bind (above),
deployment CRUD routes, and a handful of CF-native surfaces (files/R2, runtime
rooms, Stripe payments webhook).

---

## Session Resources

Attach external resources to a session at runtime:

### Files

```json
{
  "type": "file",
  "file_id": "file_xxx",
  "mount_path": "/home/user/data/input.csv"
}
```

### GitHub Repositories

```json
{
  "type": "github_repository",
  "repo_url": "https://github.com/owner/repo",
  "checkout": { "type": "branch", "name": "main" },
  "credential_id": "cred_xxx",
  "access": "read_write"
}
```

### Memory Stores

```json
{
  "type": "memory_store",
  "memory_store_id": "ms_xxx"
}
```

---

## Team Members & Invites

A tenant (workspace) is multi-user: `membership` binds a user to a tenant with
a role (`owner` | `admin` | `member`). To add a teammate, an **owner or admin**
creates an **invite** — an email + role + opaque token with a 7-day expiry
(issue #175). The invitee accepts it while signed in with that exact email,
which writes their `membership` row and joins them to the workspace.

Invites live in the shared control-plane store next to `tenant`/`membership`
(`tenant_invites`, `inv_*` ids). Delivery is **invite-link-first**: the create
response always returns the `token` + `accept_url`, and an email is sent
best-effort when an email sender is configured (the same `SEND_EMAIL` /
nodemailer seam the consumer magic-links use) — a missing sender never fails
the request.

```bash
# Invite a teammate (owner/admin only). role: "admin" | "member" (default member)
curl -s $BASE/v1/tenant/invites \
  -H "x-active-tenant: $TENANT" -H "content-type: application/json" \
  -d '{"email": "teammate@example.com", "role": "member"}'
# → 201 { "id": "inv_...", "email": "...", "role": "member", "status": "pending",
#         "token": "...", "accept_url": "https://<host>/invites/<token>", ... }
```

Routes (management routes require an owner/admin cookie session; accept routes
require the invitee's cookie session):

```http
GET    /v1/tenant/members            # List current members (owner/admin)
GET    /v1/tenant/invites            # List pending invites — (created_at,id) DESC
POST   /v1/tenant/invites            # Create an invite (201)
DELETE /v1/tenant/invites/:id        # Revoke a pending invite (204)
GET    /v1/invites/:token            # Preview an invite (email, workspace, role, expiry)
POST   /v1/invites/:token/accept     # Accept → joins the invite's tenant
```

Semantics: a non-manager caller gets `403 forbidden`; a duplicate pending
invite for the same email is `409 invite_exists`; accept refuses a
`revoked`/`expired` invite (`410`) or an email that doesn't match the
signed-in user (`403 email_mismatch`). Console UI lives at **Settings ›
Members** (invite form, member list, pending-invite revoke). Wired on **both**
runtimes (Cloudflare + self-host Node).

---

## Agent Schedules

Schedules let an agent fire sessions on a cron cadence with no human turn —
recurring maintenance, digests, polling jobs. They're stored per-agent in the
shared control-plane D1 (`agent_schedules`, `sch_*` ids) and evaluated by a
per-minute Cloudflare cron tick (`scheduled-agent-runs`, wired in
`apps/main/src/lib/cf-scheduler-jobs.ts`; job in
`packages/scheduler/src/jobs/scheduled-agent-runs.ts`).

```bash
# Create a schedule
curl -s $BASE/v1/agents/$AGENT_ID/schedules \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "cron_expression": "0 9 * * 1",
    "timezone": "America/New_York",
    "environment_id": "env_xxx",
    "input": "Post the weekly metrics digest to #general.",
    "max_sessions": 1,
    "enabled": true
  }'
```

| Field | Required | Notes |
|---|---|---|
| `cron_expression` | Yes | Standard 5-field cron |
| `environment_id` | Yes | Environment the scheduled session runs in |
| `input` | Yes | Injected as the opening `user.message` (1–10000 chars) |
| `timezone` | No | IANA zone, default `UTC` — DST-correct next-run math (via `croner`) |
| `max_sessions` | No | Concurrency cap 1–100, default 1 |
| `enabled` | No | Default true |
| `notify` | No | Per-schedule alert config — `{ on?, targets }`. See [Per-schedule alerts](#per-schedule-alerts) |

Routes (all tenant-scoped):

```http
POST   /v1/agents/:agentId/schedules                    # Create (201)
GET    /v1/agents/:agentId/schedules                    # List
PATCH  /v1/agents/:agentId/schedules/:scheduleId        # Partial update
DELETE /v1/agents/:agentId/schedules/:scheduleId        # Delete
POST   /v1/agents/:agentId/schedules/:scheduleId/run    # Run now → {status:"queued", next_run_at}
GET    /v1/agents/:agentId/schedules/:scheduleId/runs   # Durable run history — cursor-paginated
```

`next_run_at` is seeded at create from the cron + timezone and advanced to the
next occurrence via an atomic compare-and-set during each tick — so overlapping
ticks or replicas never double-fire. Each firing records
`last_run_at` / `last_run_status` / `last_run_error` / `last_session_id`; a
failing run is fail-open (logged, next occurrence still scheduled). An
unparseable cron leaves `next_run_at` null and the schedule never fires.

### Per-schedule alerts

A schedule can raise its own alerts, independent of the agent's `notify`
(which fires for *every* session that agent runs). Set `notify` on the
schedule with the same [`NotificationTarget`](#notify-targets) shapes:

```json
{
  "notify": {
    "on": ["error", "skipped_concurrency"],
    "targets": [
      { "type": "slack_message", "credential_id": "cred_xxx", "channel": "C123" }
    ]
  }
}
```

- **`on`** filters which firing outcomes alert — any of `ok` | `error` |
  `skipped_concurrency`. **When omitted it defaults to
  `["error", "skipped_concurrency"]`**: the two outcomes an operator usually
  wants paged about. Success alerts are opt-in via an explicit `on`.
- The filter is applied **before** dispatch, in the tick
  (`shouldNotifyRun`), so it is independent of a `webhook` target's own
  `events` filter — that enum stays session-only and schedule deliveries
  bypass it.
- Deliveries reuse the agent runtime's notify dispatcher, so a schedule
  firing surfaces as a `schedule_ok` / `schedule_error` /
  `schedule_skipped` status ("Scheduled run succeeded", …) and a `webhook`
  envelope gains a trailing `schedule_id` field (appended last, so existing
  receivers' signature reproduction is unchanged).
- Credentials resolve across the **tenant's vaults** (a schedule has no
  `vault_ids` of its own). Alerting is purely observational and fail-open —
  an unresolvable credential or a dead endpoint is logged and never affects
  the firing. `PATCH` with `"notify": null` clears the config.

### Run history

`agent_schedules`' `last_run_*` columns only ever hold the *latest* firing —
they don't answer "what happened over the last week." Every firing (a normal
success, a launch error, or a `skipped_concurrency` skip) also appends an
immutable row to `agent_schedule_runs` (`srun_*` ids, issue #312 WP3):
`schedule_id`, `tenant_id`, `agent_id`, `session_id`, `status`, `error`,
`summary`, `started_at`, `created_at`. History writes are best-effort — a
failed INSERT is logged and swallowed so it can never break `last_run_*`
recording or the tick's concurrency gate.

`GET /v1/agents/:agentId/schedules/:scheduleId/runs` reads it back, following
the repo's standard cursor contract: `WHERE schedule_id = ? AND tenant_id = ?`,
ordered `(created_at, id) DESC`, opaque `next_cursor`, `{ data, next_cursor }`
response shape (`buildScheduleRoutes` in
`packages/http-routes/src/schedules/index.ts`). `summary` is currently always
`null` — a nullable slot reserved for a follow-up that fills in a short
human-readable description of what the run did.

`PATCH` takes any subset of `cron_expression` / `input` / `environment_id` /
`timezone` / `max_sessions` / `enabled` (at least one required; empty body →
400). When `cron_expression` or `timezone` is in the patch, `next_run_at` is
recomputed atomically in the same request from the new value (or the
existing row's, for the field not patched) — same seeding logic as create,
including the "unparseable cron → null → never fires" fallback.

Fires on **both runtimes** (issue #262). Cloudflare evaluates the tick via
the per-minute cron in `apps/main/src/lib/cf-scheduler-jobs.ts`; the self-host
Node runtime runs the same shared tick + store (`scheduledAgentRunsTick` +
`SqlClientScheduledRunsStore`) on a `setInterval` cadence wired in
`apps/main-node/src/lib/node-scheduler-jobs.ts`, launching over the Node
session-create path. The two are separate deployments with separate
`agent_schedules` tables, so there's no cross-runtime double-fire; the
per-row compare-and-set on `next_run_at` guards replicas of the *same*
runtime. The CRUD routes are one shared implementation
(`packages/http-routes/src/schedules/index.ts`).

**Deployment topology:** Cloudflare fires the tick from wrangler
`triggers.crons` (the platform invokes `scheduled()` per minute). The self-host
Node runtime (`docker compose` or k8s) fires **in-process** on a `setInterval`
cadence started at server boot — no external k8s `CronJob` resource is needed.
Running **multiple Node replicas is safe**: the schedule jobs claim each due
row with an atomic compare-and-set on `next_run_at`, so exactly one replica
wins each occurrence and the losers no-op — the same guard that protects
overlapping Cloudflare cron invocations.

(Distinct from the in-sandbox `schedule` / `cancel_schedule` / `list_schedules`
tools, which let a *running* agent set its own wakeups — those wake the same
session; agent schedules create fresh sessions.)

---

## Deployments

A **deployment** is a first-class, reusable bundle (matches the official
Claude Console) that binds an agent — optionally pinned to a specific version
— to an environment, credential vaults, memory stores, an initial message,
and a **trigger**, so the same configured run can fire repeatedly. Rows live
in the shared control-plane D1 (`deployments`, `dep_*` ids), tenant-scoped.

```bash
curl -s $BASE/v1/deployments \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "Nightly digest",
    "agent_id": "agent_xxx",
    "agent_version": null,
    "initial_message": "Post the digest to #general.",
    "environment_id": "env_xxx",
    "vault_ids": ["vlt_xxx"],
    "memory_store_ids": ["ms_xxx"],
    "trigger": { "type": "schedule", "cron_expression": "0 9 * * 1", "timezone": "America/New_York" }
  }'
```

| Field | Required | Notes |
|---|---|---|
| `name` | Yes | Display name (1–200 chars) |
| `agent_id` | Yes | Agent to run |
| `agent_version` | No | `null`/unset = always latest; an integer pins that version's snapshot |
| `initial_message` | Yes | Sent to the agent as the opening `user.message` on every run (1–10000 chars) |
| `environment_id` | Yes | Environment the run's session executes in |
| `vault_ids` | No | Credential vaults attached to each run's session |
| `memory_store_ids` | No | Memory stores mounted as read/write session resources |
| `trigger` | No | `manual` \| `schedule` \| `webhook` (default `{"type":"manual"}`) |
| `enabled` | No | Default true |

### Triggers

- **`{"type":"manual"}`** — run only via `POST /v1/deployments/:id/run`.
- **`{"type":"schedule","cron_expression":"...","timezone":"UTC"}`** — fires on
  a cron cadence via the per-minute `scheduled-deployment-runs` cron tick
  (`packages/scheduler/src/jobs/scheduled-deployment-runs.ts`, wired in
  `apps/main/src/lib/cf-scheduler-jobs.ts`). Mirrors agent schedules exactly:
  `next_run_at` is seeded at create from cron + timezone (via `croner`) and
  advanced to the next occurrence by an atomic compare-and-set during each
  tick, so overlapping ticks / replicas never double-fire. A failing run is
  fail-open (logged; `last_run_*` recorded; next occurrence still scheduled).
- **`{"type":"webhook"}`** — create mints an opaque `hook_token` and returns a
  `webhook_url` (`/v1/deployment_hooks/<hook_token>`). That endpoint is
  **unauthenticated but token-secured**: the token both identifies the
  deployment and authorizes the run — a tenant `x-api-key` is never accepted
  there. An optional JSON body `{ "message": "..." }` overrides, or
  `{ "append": "..." }` appends to, the stored `initial_message`.

### Running

`POST /v1/deployments/:id/run` (and the webhook endpoint) create a fresh
session from the deployment config — environment, vaults, memory stores,
pinned agent version — inject the initial message, record the run
(`last_run_at` / `last_run_status` / `last_run_error` / `last_session_id`),
and return `{ session_id, deployment_id, status }`. The created session's
`metadata.deployment_run.deployment_id` links it back to the deployment.

Routes (all tenant-scoped except the webhook endpoint):

```http
POST   /v1/deployments                       # Create (201) — webhook_url in the response for webhook triggers
GET    /v1/deployments                        # List — cursor-paginated (created_at, id) DESC
GET    /v1/deployments/:id                    # Get
PATCH  /v1/deployments/:id                    # Update (switching trigger re-mints/drops hook_token + re-seeds next_run_at)
DELETE /v1/deployments/:id                    # Delete
POST   /v1/deployments/:id/run                # Manual run → { session_id, ... }
POST   /v1/deployment_hooks/:hook_token       # Webhook run (no x-api-key; token-secured)
```

**How it differs from agent schedules:** an agent schedule (`sch_*`, per-agent,
`POST /v1/agents/:id/schedules`) only ever fires on a cron cadence and only
carries an environment + prompt. A deployment (`dep_*`, top-level) is a
reusable bundle that also carries vaults, memory stores, and a pinned agent
version, and can be triggered three ways (manual API call, webhook, or cron).
The schedule cron path is its own job (`scheduled-deployment-runs`) so the two
never interfere. The **schedule** cron path is wired on **both runtimes**
(issue #262) — the self-host Node runtime registers the same
`scheduledDeploymentRunsTick` in `node-scheduler-jobs.ts`. Deployment **CRUD
routes** (create/list/run/webhook) remain **Cloudflare only**, so in practice
no deployment rows exist on Node yet to fire; the tick is wired for parity and
forward-compat.

---

## Publishing, Consumers & Payments

An agent can be **published** as a consumer-facing bot: a hosted chat page, an
embeddable widget, guest access, and optional per-message billing. This is the
duyetbot-style surface — an end user talks to the bot without an OMA account.

### Publication surface

A live publication is reachable at `/p/<slug>`:

- **Hosted chat page** — `GET /p/<slug>`.
- **Embeddable widget** — `GET /p/<slug>/widget.js` returns a self-contained,
  dependency-free script that injects a floating launcher bubble toggling an
  iframe of the chat page. Drop it into any site:

  ```html
  <script src="https://<host>/p/<slug>/widget.js" async></script>
  ```

  A paused/hidden publication ships a no-op script so embeds fail closed.
- **QR + share** — the Console **My Bots** page (`/my-bots`) lists a creator's
  published agents with pause/resume, the public URL, an inline-SVG QR code,
  and the copy-paste embed snippet.

### Consumer auth (`/v1/public/auth/*`)

End users authenticate against a publication without a tenant membership:

```http
POST /v1/public/auth/magic-link      # request email magic link
POST /v1/public/auth/verify          # verify → session_token + consumer_id + expires_at
POST /v1/public/auth/guest           # anonymous guest session (optional publication_id)
POST /v1/public/auth/upgrade         # attach email to the SAME guest consumer (history survives)
POST /v1/public/auth/refresh         # rotate the bearer session token
GET  /v1/public/auth/me              # current consumer identity
```

Guest mode mints an anonymous consumer (`cons_*`, `auth_provider="guest"`);
`upgrade` flips it to an email identity in place so conversation history and
publication associations carry over. Creators see who used their bot via
`GET /v1/publications/:id/users` (tenant-authed) — `consumer_id`, `name`,
`is_guest`, first/last-seen, and conversation count.

### Metering & paywall (`@duyet/oma-payments`)

Each publication has a pricing row (`publication_pricing`) with a mode:

| Mode | Cost per turn |
|---|---|
| `free` | 0 |
| `per_message` | `price_amount` credits, debited up front |
| `per_1k_tokens` | `price_amount × ceil(tokens/1000)` credits |
| `subscription` | 0 while the consumer's subscription is active |

Credits are an append-only wallet ledger keyed by `(tenant_id, end_user_id)`
with a cached balance row for the hot-path gate. `enforcePaywall` gates every
public turn: `free` / no pricing / payments disabled → allow; metered modes
require `balance >= cost`; blocked turns return **HTTP 402**
`{code:"insufficient_credits", balance, shortfall, top_up_url}`. `per_message`
debits up front; `per_1k_tokens` gates on a minimal reserve (`max(1,
price_amount)`) and debits the real token cost **post-turn** in the agent DO at
`session.status_idle` (`maybeMeterTurn` → `debitTurnUsage`, idempotent per turn
via the `turn_debits` guard). Configure a publication's pricing via `PUT
/v1/publications/:id/pricing`. Top-ups run through Stripe Checkout; `POST
/webhooks/stripe` (signature-verified, idempotent via `stripe_processed_events`)
credits the ledger. Creator revenue: `GET /v1/publications/:id/revenue`.

Secrets: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `PAYMENTS_DISABLED`
(kill-switch → everything free), `PUBLIC_BASE_URL` (redirect/top-up URLs).

---

## Notify Targets

`agent.notify` is an array of `NotificationTarget`s. Each session created from
the agent inherits them via its `agent_snapshot` and, when the session reaches
a terminal-ish status (`session.status_idle`, `session.error`,
`session.status_terminated`), the platform fans out a session-status
notification to every target. This lives in
`apps/agent/src/runtime/notify-dispatch.ts` (extracted from `session-do.ts` so
it's unit-testable without a Durable Object) and never throws back into the
session loop — a misconfigured target is logged and skipped, it never blocks the
session.

Target variants:

```json
{ "type": "github_comment", "credential_id": "cred_xxx", "owner": "acme", "repo": "widgets", "issue_number": 7 }
```

```json
{ "type": "slack_message", "credential_id": "cred_xxx", "channel": "C123" }
```

```json
{ "type": "matrix_message", "credential_id": "cred_xxx", "homeserver_url": "https://matrix.example.com", "room_id": "!room:example.com" }
```

```json
{ "type": "telegram_message", "chat_id": -1001234567890 }
```

### `email` — transactional email (issue #317)

Delivers the same status summary every other provider renders, as an email:

```json
{ "type": "email", "to": "ops@example.com", "subject_prefix": "[oma]" }
```

- **`to`** is zod-validated as an email address; **`subject_prefix`** is
  optional and prepended to the generated subject
  (`<prefix> Agent "<name>" session <id>: <status>`). The body carries the
  shared summary line, the final agent message when present, and the session
  deep link.
- **No vault credential.** Unlike `github_comment` / `slack_message` /
  `matrix_message`, email auth is the *deployment's* email transport — the same
  `packages/email` seam the auth magic-links and tenant invites use:
  **Cloudflare** = the `SEND_EMAIL` Email Workers binding (declared on both the
  `main` and `agent` workers); **self-host Node** = SMTP via nodemailer
  (`SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM`).
- **Fail-open.** With no transport configured (binding unbound, or `SMTP_HOST`
  unset) the delivery is skipped and a warning is logged through the same
  `onError` sink as any other target failure — it never throws into the session
  loop or a scheduler tick.
- **Runtime coverage.** Fires from the session-status fan-out (Cloudflare
  `SessionDO`) and from per-schedule run alerts on **both** runtimes. Node has
  no session-status notify fan-out at all yet (not email-specific — no target
  type fires there), so on self-host today `email` reaches you via schedule
  alerts.

### `webhook` — generic outbound webhook

Posts a signed JSON envelope to an arbitrary customer URL so a creator can wire
duyetbot into their own backend. The body is HMAC-SHA256-signed over the raw
payload with the `X-OMA-Signature` header (`sha256=<hex>`), computed with Web
Crypto `crypto.subtle` so it runs identically on Cloudflare Workers and Node.

```json
{
  "type": "webhook",
  "url": "https://hooks.example.com/agent",
  "secret_ref": "cred_webhook_secret",
  "events": ["idle", "terminated"]
}
```

- **`secret_ref`** references a vault credential id whose `static_bearer` token
  is the HMAC secret. The secret is **never stored inline** on the agent config
  — it's resolved from the vault at dispatch time. When `secret_ref` is unset,
  the envelope is sent **unsigned** and a warning is logged (fail-open, so a
  customer endpoint that accepts unsigned deliveries still works). When
  `secret_ref` is set but can't be resolved, the delivery is skipped + warned.
- **`events`** is an optional filter over `idle | error | terminated`. Omit it
  to deliver on all three.
- **Envelope** (`WebhookEnvelope`): `{ session_id, publication_id?, end_user_id?,
  agent_name?, status, stop_reason?, message?, session_url? }`. Field order is
  fixed so a receiver can reproduce the exact signed bytes. Receivers verify
  with `HMAC-SHA256(secret, raw_body)` and compare to the `sha256=…` value in
  `X-OMA-Signature`.
- **Rate limiting**: outbound webhook volume is capped **per tenant** via
  `packages/rate-limit` (a `webhook:<tenantId>` bucket). On exhaustion the
  delivery is dropped (fail-open) rather than blocking the session.

### Validation

The `notify` array is zod-validated at agent create/update in
`packages/http-routes/src/agents/index.ts` via `notificationTargetsSchema`
(`packages/api-types/src/notify-schema.ts`). An invalid target (e.g. a
non-URL `webhook.url`, or an unknown `events` value) is rejected with HTTP 422.

---

## Agent Hooks

`agent.hooks` is Claude-Code-style hook system (issue #76 Part B): declarative
callbacks fired around the harness tool loop that let a creator **gate** a tool
call, **redact** its output, or trigger a **side effect** — without running any
custom code inside the Worker/DO. Each hook dispatches to a **signed outbound
webhook** (same transport + HMAC-SHA256 signing as the `webhook` notify
target), and the platform reads a small JSON decision back.

Hooks are attached at the agent level and inherited by every session via its
`agent_snapshot` — same scope model as `mcp_servers` / `notify`.

```json
{
  "hooks": [
    {
      "event": "pre_tool",
      "matcher": "bash",
      "target": { "type": "webhook", "url": "https://hooks.example.com/gate", "secret_ref": "cred_hook_secret" },
      "timeout_ms": 3000,
      "on_error": "closed"
    },
    {
      "event": "post_tool",
      "matcher": "*",
      "target": { "type": "webhook", "url": "https://hooks.example.com/redact", "secret_ref": "cred_hook_secret" }
    }
  ]
}
```

| Field | Required | Notes |
|---|---|---|
| `event` | Yes | `pre_tool` \| `post_tool` \| `session_start` \| `session_idle`. Only `pre_tool`/`post_tool` wrap the tool loop today. |
| `matcher` | No | Tool-name filter for pre/post-tool (`"*"` or unset = every tool). |
| `target` | Yes | `{ "type": "webhook", "url", "secret_ref?" }`. `secret_ref` is a vault credential id — the HMAC secret is resolved at dispatch time, **never inlined**. (An `mcp_tool` target variant is reserved but not yet dispatched.) |
| `timeout_ms` | No | Outbound call timeout (default 5000). |
| `on_error` | No | Fail policy on timeout/error/malformed response: `"open"` (default) proceeds, `"closed"` denies the tool call. |

### Semantics

- **`pre_tool`** fires before a tool runs. The platform POSTs
  `{ event: "pre_tool", tool_name, tool_input, session_id }` and reads back
  `{ decision: "allow" | "deny" | "modify", tool_input?, reason? }`:
  - `deny` — the tool never executes; the model sees `Tool call blocked by
    hook: <reason>`.
  - `modify` — `tool_input` replaces the arguments passed to the tool.
  - `allow` (or any other response) — the call proceeds unchanged.
- **`post_tool`** fires after a tool returns. The platform POSTs
  `{ event: "post_tool", tool_name, tool_input, tool_result, session_id }` and
  reads back `{ decision: "allow" | "modify", tool_result?, reason? }`; a
  `modify` replaces the observed result (e.g. redacting secrets before the
  model sees them).
- **Signing** — the request body is HMAC-SHA256-signed with the vault-resolved
  secret in `X-OMA-Signature: sha256=<hex>` (Web Crypto, identical on
  Cloudflare and Node). `X-OMA-Hook` carries the event name. When no
  `secret_ref` is set the delivery is unsigned.
- **Timeout + fail policy** — every hook is time-bounded (`timeout_ms`). On
  timeout, transport error, or a malformed response the `on_error` policy
  applies: **fail-open** (default) so a dead hook endpoint never bricks a
  session, or **fail-closed** to deny the tool call when the hook can't be
  reached.
- **Rate limiting** — outbound hook volume is capped **per tenant**
  (`hook:<tenantId>` bucket, `packages/rate-limit`). On exhaustion the hook is
  skipped and the fail policy applies (fail-open by default).
- **Prompt-cache safety** — hooks only wrap a tool's `execute`; tool names,
  descriptions, and input schemas are untouched, so Anthropic's cached prefix
  is byte-identical whether or not hooks are configured.

The dispatch wrapper is `wrapToolsWithHooks` / `runPreToolHooks` /
`runPostToolHooks` (`apps/agent/src/harness/hooks.ts`), wired into `buildTools`
(`apps/agent/src/harness/tools.ts`) via `env.hookDeps` from `SessionDO`. The
`hooks` array is zod-validated at agent create/update via `agentHooksSchema`
(`packages/api-types/src/hooks-schema.ts`); an invalid hook (non-URL webhook,
unknown event/policy) is rejected with HTTP 422.

---

## Outcome Evaluation

Define success criteria and let the platform evaluate whether the agent achieved them:

```json
{
  "events": [{
    "type": "user.define_outcome",
    "description": "The test suite should pass with 100% coverage",
    "rubric": "1. All tests pass (npm test exits 0)\n2. Coverage report shows 100%\n3. No skipped tests",
    "max_iterations": 5
  }]
}
```

The platform will:
1. Run the agent
2. Evaluate the outcome against the rubric
3. If `needs_revision`, provide feedback and re-run
4. Repeat until `satisfied` or `max_iterations_reached`

Events emitted: `span.outcome_evaluation_start`, `session.outcome_evaluated`.

---

## Debugging & Observability

When investigating platform or agent issues, follow this loop. **Do not skip steps.**

```
1. Define Observation
   - What exactly needs to be observed to confirm or deny the hypothesis?
   - Add logs (console.log) at specific points BEFORE deploying
   - Decide what metrics to check: response time, event count, error messages, container status

2. Measure
   - Deploy with logs
   - Collect actual data: wrangler tail, curl, observation scripts
   - Record exact timestamps, counts, error messages

3. Diagnose
   - Compare observation with expectation
   - Match → hypothesis confirmed, proceed with fix
   - Mismatch → new hypothesis, back to step 1
```

**Rules:**
- One change per deploy. Verify before stacking changes.
- Never assume the cause — observe first.
- `wrangler tail <worker-name>` shows real-time Durable Object logs. Use it.
- Read dependency source code (`node_modules/agents/`, `@cloudflare/sandbox`) instead of guessing behavior.

---

## Releasing `@getoma/cli` and `@getoma/sdk`

We use [changesets](https://github.com/changesets/changesets) for the two
public npm packages. Internal `@duyet/oma-*` packages never publish.

Both packages were reset to `0.1.0` under the `@getoma` scope. Until further
notice, **always pick `patch`** in the prompt below — versions stay in the
`0.1.x` range regardless of change size.

**Per PR (only if you touched `packages/cli` or `packages/sdk`):**

```bash
pnpm changeset
# pick package(s) → always patch (see above) → write a one-line changelog
git add .changeset/ && git commit && git push
```

The interactive prompt produces a `.changeset/<random>.md` file. Commit it
along with your code change. PRs that only touch console / workers / docs /
internal packages don't need a changeset.

**After your PR merges:**

1. `release.yml` automatically opens a "Version Packages" PR that bumps
   versions and updates `CHANGELOG.md` based on the accumulated changesets
2. Review the bump + changelog, merge that PR
3. `release.yml` runs again — version-pr job is auto; the publish job
   declares `environment: production`, which is a **real** approval gate
   only once "Required reviewers" is configured on that environment in
   repo Settings → Environments → production (a one-time manual step, not
   something the workflow YAML can do by itself). **As of now that
   reviewer step has not been done** — merging the Version Packages PR
   publishes to npm immediately, with no approval prompt. See
   [#267](https://github.com/duyet/oma/issues/267).
4. Packages publish to npm via OIDC trusted publisher (no NPM_TOKEN); tag
   is auto-derived from the version (`-beta.N` → beta tag, plain → latest)

**Prerelease (beta) flow:**

```bash
pnpm changeset pre enter beta   # next bumps become 0.x.y-beta.N → tag=beta
# … work, ship, gather feedback …
pnpm changeset pre exit         # next Version Packages PR rolls to stable
```

Detailed flow + troubleshooting in [`docs/release-process.md`](docs/release-process.md).
The trusted publisher config on npmjs.com must list `release.yml` for both
public packages; without it the publish step 401s.

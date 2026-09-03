# Fleet & Advanced Features

Open Managed Agents is built to run multi-agent workloads, orchestrate a fleet of parallel sessions, monitor long-running tasks, and safely isolate untrusted runtimes.

---

## 1. Pick a Sandbox Backend per Environment

Environments — the reusable configurations defining package managers, system packages, and network permissions — can map to their own specific sandbox provider. This allows you to mix isolation levels dynamically on the same host:
* Run trusted internal scripts on fast, cheap **Host Subprocess** isolation.
* Route customer-facing code execution to highly secure, hardware-isolated **E2B**, **Daytona**, or **BoxLite (Firecracker)** micro-VMs.

```json
// Environment config referencing a custom provider
{
  "name": "data-analyst",
  "config": {
    "sandbox_provider": "my-daytona-prod",
    "packages": {
      "pip": ["numpy", "pandas"]
    }
  }
}
```

### Supported Sandbox Providers

| Provider | Type | Description |
|---|---|---|
| `subprocess` | Host Subprocess | Plain OS subprocess. Extremely fast, default for local development. |
| `k8s` | Kubernetes | Pod isolation managed via Kubernetes agent-sandbox controller. |
| `e2b` | E2B Sandbox | Sandbox hosting on E2B. Requires `E2B_API_KEY`. |
| `daytona` | Daytona VM | VM hosting on Daytona. Requires `DAYTONA_API_KEY`. |
| `litebox` | BoxLite Local | Local Firecracker micro-VM for local hardware isolation. |
| `boxrun` | BoxLite Remote | Remote BoxLite HTTP control plane for micro-VM orchestration. |
| `openshell` | NVIDIA OpenShell | Policy-enforced, isolated agent sandboxes driven by an OpenShell gateway (gRPC). Requires `OPENSHELL_GATEWAY_ENDPOINT`. Self-host Node speaks gRPC directly; the Cloudflare deployment reaches it over `fetch` via the k8s-bridge OpenShell backend (`OPENSHELL_BRIDGE_URL`). |
| `browser-vm` | Browser VM (WASM) | Relays sandbox ops to a WASM VM (v86 by default) running in a user's own browser tab — zero server-side sandbox compute. Open via Console → Runtimes → "Open sandbox tab". **Cloudflare only**; self-host Node lists the provider but reports `not_configured`. See [Browser-VM Sandbox](browser-vm-sandbox.md). |
| `dynamic-workers` | Cloudflare Worker Loader | A JS/Wasm eval isolate per `exec`, not a Linux box: the command runs as a JS module in a fresh ephemeral V8 isolate (millisecond cold start, egress blocked by default). `readFile`/`writeFile`/`startProcess`/`gitCheckout` fail clearly — no shell, no filesystem, nothing persists between calls. Needs the `worker_loaders` binding (`env.LOADER`), not an env var. **Cloudflare only**; self-host Node rejects it (`nodeCompatible: false`). Best for pure code-eval / "Code Mode" agents. See [Runtimes](runtimes.md). |

### API Endpoints
* **List hosting types**: `GET /v1/hosting_types` returns all registered local and BYOK providers. Each provider's `health` now carries an optional `capacity` (`cpu` / `memory` / `pods` used-vs-total) surfaced best-effort from the adapter — the console Runtimes page renders these as live gauges with 30s auto-refresh.
* **Register custom provider**: `POST /v1/sandbox_providers` to register external sandbox endpoints.

---

## 2. Session Fleet Kanban Board

Monitor the state of all active sessions across your agent fleet. The status board maps sessions into four status columns derived entirely from existing metadata:

1. **Queued**: An idle session with no events processed yet.
2. **Running**: A session currently driving the loop or executing tools.
3. **Blocked**: An idle session waiting on tool execution confirmation (`requires_action` event).
4. **Done**: A completed session or one that returned to idle without errors.

Because the board is derived directly from the SQLite event log, there is no extra backend database state to sync.

The Console also has a compact operator layout for a phone or tablet. Session list rows become cards below 768 px. Overview hides the architecture map and uses the same cards for recent sessions. A session that paused on `always_ask` pins an approval card above the composer (POST `user.tool_confirmation`). The header bell keeps a 24h in-tab notice list; desktop alerts use the browser `Notification` API after an explicit opt-in. "Don't ask again this session" is tab-local `sessionStorage`, not a stored agent policy.

---

## 3. Console Analytics

The Console **Analytics** page (`/analytics`) summarizes estimated spend, tokens, and declared delegation across agents in a workspace.

It reads existing `GET /v1/usage?group_by=agent` and `GET /v1/agents`. There is no new analytics endpoint.

The page shows:

* Estimated spend at Sonnet-class rates (input $3 / output $15 per million tokens). Cache and reasoning tokens count in totals but are not priced.
* Token mix by kind (input, output, cache read, cache write, reasoning). `usage_events` has no model id, so this is not a by-model chart.
* Cost by agent (top 10 plus Others).
* Daily sandbox-active seconds for the selected range (1d, 7d, or 30d; default 7d).
* Declared delegation: `multiagent` / `callable_agents` roster edges such as Lead → Researcher. This is configuration, not observed call counts. Call-count graphs need event-log aggregation (a follow-up).

The Usage page and per-agent Observability tab are unchanged.

---

## 4. Parallel Sub-Agent Delegation

The default delegation tool `call_agent_*` blocks the parent session until the child reaches `idle`.
The `call_agents_parallel` tool allows parent agents to fan out concurrent child requests and aggregate results in parallel.

### Usage Example
Input tool call:
```json
{
  "calls": [
    { "agent_id": "agent_researcher", "message": "Research topic A" },
    { "agent_id": "agent_researcher", "message": "Research topic B" },
    { "agent_id": "agent_writer", "message": "Draft outline C" }
  ]
}
```

Aggregated response output:
```json
{
  "results": [
    { "agent_id": "agent_researcher", "success": true, "response": "...", "thread_id": "sthr_123" },
    { "agent_id": "agent_researcher", "success": true, "response": "...", "thread_id": "sthr_456" },
    { "agent_id": "agent_writer", "success": false, "error": "Sub-agent error: compile failed" }
  ]
}
```

> [!NOTE]
> Concurrency is configured via the agent's `max_parallel_subagents` field (default is 5, hard ceiling is 10). Excess requests are queued in waves automatically.

---

## 5. Structured Progress for Long-Running Tasks

For tasks that run for minutes or hours, standard text messages are hard to parse. The `agent.status` event sends structured heartbeats directly from the loop controller:

```json
{
  "type": "agent.status",
  "state": "running",
  "summary": "Executing scikit-learn training...",
  "step": 14,
  "total_steps": 20,
  "blocked_on": null
}
```

* **Heartbeat interval**: Fires on every model turn. The `long-running` harness fires wall-clock heartbeats (default every 60s) to indicate liveness during slow tool runs.
* **Console Monitor tab**: Agent detail (`/agents/:id/monitor`) renders the current or last session, a `step / total_steps` progress bar, an amber **Waiting for:** line when `blocked_on` is set, and a heartbeat log. Heartbeat lag warns when the gap exceeds 2× the expected interval (default 5 minutes). The agent header health strip shows last/next run, uptime, success rate, avg duration, and cost/run.
* **Cache optimization**: These heartbeats are stored in the Durable Object log but excluded from prompt context history. This avoids polluting prompt-cache keys or triggering premature token compaction.
* **Crash recovery**: Re-instantiating the session DO automatically parses the log and catches up step counters without duplicates.

---

## 6. Outbound Notification Dispatcher

Agents can post status transitions (e.g. session done, error, blocked) to external communication channels. Add the `notify` field to your agent configuration:

```json
{
  "name": "CI Reviewer",
  "notify": [
    {
      "type": "github_comment",
      "credential_id": "cred_gh",
      "owner": "duyet",
      "repo": "oma",
      "issue_number": 52
    },
    {
      "type": "slack_message",
      "credential_id": "cred_slack",
      "channel": "C0123456"
    },
    {
      "type": "matrix_message",
      "credential_id": "cred_matrix",
      "homeserver_url": "https://matrix.org",
      "room_id": "!abc:matrix.org"
    },
    {
      "type": "email",
      "to": "ops@example.com",
      "subject_prefix": "[oma]"
    }
  ]
}
```

### Formatting Styles
* **GitHub**: Posted as markdown comments with a status indicator dot (🔴 Error, ⚪ Blocked, 🟢 Success).
* **Slack**: Formatted using Slack mrkdwn and emoji blocks.
* **Matrix**: Sent via Matrix Client-Server API room messages.
* **Email**: Subject = optional `subject_prefix` + agent/session/status; body = the same status summary line, the final agent message, and the session link. Delivered through the deployment's email sender (Cloudflare `SEND_EMAIL` binding, or `SMTP_HOST` + friends on self-host Node) — with no sender configured the target is skipped with a logged warning.

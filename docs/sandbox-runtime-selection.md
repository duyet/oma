# Sandbox runtime selection

**Status:** accepted  
**Decision:** pick the sandbox at **session launch** (via environment), with an optional **agent default**. The model never re-picks the provider mid-turn.

This freezes the product rule behind “agent vs launch-time sandbox choice,” matches what the platform already implements, and lists the small gaps still worth closing.

---

## Problem

Three different things people call “runtime”:

| Layer | Config | Question it answers |
|---|---|---|
| **Harness** | `agent.harness` / env `kind: local` → `acp-proxy` | *How* does the model loop run? |
| **Model** | `agent.model` + model cards | *Which* LLM is called? |
| **Sandbox** | `environment.config.sandbox_provider` (+ type, packages, networking) | *Where* do bash/file tools run? |

Without a clear rule, UIs and agents try to:

1. bake the sandbox into the agent forever, or  
2. let the model “switch boxes” mid-session  

Both break reuse (one agent, many sandboxes), trust (vault / network boundary), and the prompt-cache story (sandbox facts are part of the system prefix).

---

## Decision

### 1. Launch-time selection is authoritative

On `POST /v1/sessions`, the caller supplies `environment_id` (required for cloud-kind runs). That environment’s `config.sandbox_provider` (else legacy `config.type`) is resolved once when the sandbox is provisioned. The session’s environment snapshot is fixed for the life of the session.

**Nothing in the harness turn is allowed to change the sandbox provider.**

### 2. Agent carries a preference, not a hard bind

The agent may declare a default environment:

```json
{
  "metadata": {
    "default_environment_id": "env_xxx",
    "runtime_kind": "browser"
  }
}
```

| Key | Role |
|---|---|
| `default_environment_id` | Preferred `environment_id` for new sessions (Console: New Session, Agent Chat, assign-issue, etc.) |
| `runtime_kind` | UX badge only: `cloud` \| `local` \| `browser` — not a second resolution path for the provider |

Resolution order at session create (Console / API clients):

1. Explicit `environment_id` on the create body (wins).  
2. Else `agent.metadata.default_environment_id` if it still exists and is usable.  
3. Else tenant single-environment shortcut (if exactly one env).  
4. Else the user must pick (or the API returns 4xx when env is required).

Server-side, schedules and deployments **must** pin `environment_id` on the schedule/deployment row (already required). They do not re-read agent metadata at fire time for the provider — the pin is the contract.

### 3. The model does not pick the sandbox

| Allowed | Not allowed |
|---|---|
| Run tools on the session’s bound sandbox | Tool or prompt that swaps `sandbox_provider` mid-session |
| Sub-agent with its own `callable_agents[].environment_id` (dedicated sandbox for that call) | Hot-swapping the *parent* session’s sandbox |
| Federated / remote agent (remote owns its sandbox) | “Try another provider if this one fails” inside one session |

If work needs a different host: **new session**, **sub-agent with different env**, or **remote agent** — not an in-place switch.

### 4. System prompt tells the truth about the bound host

`composeSystemPrompt` injects a deterministic `## Sandbox environment` block from the session’s environment snapshot (provider, paths, networking, packages, git clone, local ACP, provider notes). That block is **session-stable** and must stay in the cached prefix. See `apps/agent/src/harness/platform-guidance.ts`.

---

## Resolution map (implementation)

```
POST /v1/sessions { agent, environment_id? }
        │
        ▼
  environment_id resolved
  (client: explicit > metadata.default_environment_id > single-env fallback)
        │
        ▼
  Session stores environment_snapshot
        │
        ├─ harness: from env.kind / env.harness / agent.harness
        │     kind: local → acp-proxy
        │     sandbox_provider: oma-remote → oma-remote harness
        │     else agent.harness or "default"
        │
        └─ sandbox: resolveCfSandbox / SandboxProviderRegistry
              from snapshot.config.sandbox_provider || config.type
        │
        ▼
  First turn: composeSystemPrompt(..., environment_snapshot)
  → model sees ## Sandbox environment
```

Sub-agents: `resolveSubAgentSandboxBinding` may mint a **dedicated** executor when the roster entry’s `environment_id` differs from the parent — still launch-time for that sub-turn, not mid-exec switching.

---

## Why not the alternatives

### Agent hard-binds provider (no environment at create)

- One agent cannot run “cloud for demos / k8s for prod.”  
- Deployments and schedules already need an environment for packages/networking.  
- Rejected.

### Model picks provider each turn

- Changes trust boundary, vault injection, mounts, cost.  
- Busts prompt cache and crash-recovery story (event log assumes one sandbox).  
- Rejected for v1 and indefinite default.

### Mid-session “migrate” tool

- Attractive for failover; needs snapshot/restore, dual logs, billing.  
- Deferred: use a new session or sub-agent with another env instead.

---

## UX rules (Console)

| Surface | Behavior |
|---|---|
| Agent form **runtime kind** | Sets `metadata.runtime_kind` + ensures a matching default env exists (e.g. browser → create/select browser-vm env → `default_environment_id`) |
| New session | Prefill env from `preferredEnvironmentId(metadata, singleEnv)` |
| Agent chat “new session” | Same preference |
| Runtimes page | Lists providers/machines; does **not** rebind a live session |
| Session detail | Read-only: show bound environment + injected provider facts |

Copy: “Where tools run is chosen when the session starts (environment). Change the agent’s default for next time, or pick another environment when you create a session.”

---

## API contract (normative)

- `POST /v1/sessions`  
  - **Cloud kind:** `environment_id` required (or resolvable by the client from agent default before call).  
  - **Local kind:** environment still identifies the local binding (`config.local`); provider is effectively the bridge / ACP host.  
- Session row / DO state holds `environment_id` + snapshot; immutable for provider purposes.  
- Agent metadata keys (convention, not DB columns):  
  - `default_environment_id: string`  
  - `runtime_kind: "cloud" | "local" | "browser"`  
- No public “change sandbox provider” session API.

---

## Observability

- Session status / Console: environment name + provider id.  
- System prompt prefix includes `## Sandbox environment` (also visible in LLM logs when enabled).  
- Failures for missing/unavailable provider stay loud (`session.error` / `SandboxProviderUnavailableError`) — no silent fallback to another provider.

---

## Key decisions

1. **Launch-time environment is the source of truth for the sandbox** — agent is persona + tools; environment is host.  
2. **Agent default is a soft preference** — session create may override; schedules/deployments pin hard.  
3. **No mid-turn provider switch** — isolation via new session or sub-agent env.  
4. **Prompt injection of sandbox facts** — model is informed, not empowered to reconfigure.  
5. **`runtime_kind` is UX only** — never a second provider resolver on the server.

---

## Gaps vs this design (follow-ups)

Already largely implemented: env on session create, Console preference helper, browser-vm default env, sandbox prompt block, sub-agent dedicated env.

Optional polish (not required for the rule to hold):

| Gap | Notes |
|---|---|
| Server-side default env | If create omits `environment_id`, API could resolve `metadata.default_environment_id` instead of only clients doing it |
| Validate default still exists | On agent update / session create, 422 if preferred env archived or wrong tenant |
| Session create API docs | Spell out preference order in `docs/api-reference.md` / OpenAPI description |
| Agent detail “Default sandbox” | Explicit field in Console (not only buried in runtime-kind flow) |

---

## Open questions

None for the core rule. Optional product extras (server-side default resolution, failover sessions) can be separate RFCs.

---

## PR Plan

### PR 1 — Docs only (this document)

- **Title:** `docs: sandbox runtime selection policy`  
- **Files:** `docs/sandbox-runtime-selection.md`, short link from `docs/runtimes.md`  
- **Deps:** none  
- **Status:** this change  

### PR 2 — Server-side default environment (optional)

- **Title:** `feat(sessions): resolve environment_id from agent.metadata.default_environment_id`  
- **Files:** session create routes (CF + Node), tests  
- **Deps:** PR 1  
- **Desc:** When body omits `environment_id`, load agent snapshot and apply the same preference order; never invent a provider without an environment row  

### PR 3 — Console clarity (optional)

- **Title:** `feat(console): surface default sandbox on agent overview`  
- **Files:** agent overview / form, copy on New Session  
- **Deps:** PR 1  
- **Desc:** Show bound default env name + provider mark; link to Runtimes / Environments  

### PR 4 — Harden invalid defaults (optional)

- **Title:** `fix(agents): reject stale default_environment_id`  
- **Files:** agent update validation, session create  
- **Deps:** PR 2  
- **Desc:** 422 when default points at archived/missing env  

---

## Related

- [Runtimes](./runtimes.md) — harness vs model vs sandbox  
- [Browser-VM sandbox](./browser-vm-sandbox.md) — `runtime_kind: browser` + default env  
- `apps/console/src/pages/agents/browser-env.ts` — `preferredEnvironmentId`  
- `apps/agent/src/harness/platform-guidance.ts` — `buildSandboxEnvironmentGuidance`  
- `apps/agent/src/runtime/sub-agent-sandbox.ts` — dedicated sub-agent sandbox  

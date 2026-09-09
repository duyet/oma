# Home session and home runtime

Frozen product shape from issue #459: keep SessionDO and persist-before-broadcast.
The Agent is the noun. A long-lived **home / pinned session** is the Bot-like inbox.

## Home session

Each Agent can have one home session. Metadata flag `home: true`. Extra sessions stay
ordinary ephemeral work.

```bash
# Get-or-create (idempotent). Uses agent.metadata.default_environment_id when
# environment_id is omitted.
curl -s -X POST $BASE/v1/sessions/home \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"agent":"agent_xxx"}'
# → { "session": { "id": "sess_…", "metadata": { "home": true }, … },
#     "runtime": { "id", "hostname", "status": "online"|"offline"|"provisioning",
#                  "last_heartbeat" } | null,
#     "created": true|false }

curl -s "$BASE/v1/sessions/home?agent_id=agent_xxx" -H "x-api-key: $KEY"
```

`POST /v1/sessions` with `metadata.home: true` also reuses the existing home row
instead of minting a second inbox.

Status on the session row is the truth: `running` is working, `idle` is idle,
`terminated` / error events are error. The Console must not paint idle as working.

## Home runtime vs ephemeral sandboxes

| Surface | What it is | When to use |
|---|---|---|
| **Home runtime** | Long-lived paired machine: `oma bridge daemon` and/or herdr. OpenShell is optional isolation. Heartbeat on `/v1/runtimes`. | Steady-state computer. Work continues when the laptop is closed if the home host stays up. |
| **Session sandbox** | Ephemeral cloud / subprocess / k8s / … executor chosen by the session's environment. | Isolated or risky turns. |
| **CLI relay** | Bootstrap until a home runtime is paired. Not the steady-state computer. | First-run pairing. |

Turns target home vs ephemeral by which **session** (and therefore which
environment / `sandbox_provider`) they run on. The home inbox uses the Agent's
default environment. **New Session** still creates a throwaway session.

Vault credentials still never enter the sandbox (#318). Home path uses the same
outbound / daemon injection as other bridge sessions.

This is **not** an always-on shared account VM.

## Console

Overview shows home online / offline / provisioning from the home-session
payload's `runtime` (falling back to `/v1/runtimes` heartbeats), plus open
sessions with truthful working / idle / error. GET `/v1/sessions/home` is
**200** with `session: null` when the inbox does not exist yet — that still
returns `runtime` so the strip is not stuck on provisioning and can offer
**Open home**. Agent detail **Open home** get-or-creates the inbox and
navigates to it. `AgentHealthStrip` extends the existing health glance with
home presence and an inbox link when the session exists.

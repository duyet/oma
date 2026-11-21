# RFC: Grok Bot Product Shape

**Status:** Proposed (design deliverable for [#459](https://github.com/duyet/oma/issues/459))  
**Date:** 2026-11-21  
**Related:** [#433](https://github.com/duyet/oma/issues/433) CLI rewrite, [#437](https://github.com/duyet/oma/issues/437) herdr/local coding-agent support, [#318](https://github.com/duyet/oma/issues/318) bridge vault injection, [#347](https://github.com/duyet/oma/issues/347) Console UX roadmap, [#460](https://github.com/duyet/oma/issues/460)-[#463](https://github.com/duyet/oma/issues/463) implementation slices.

## Goal

Make OMA feel like Grok Bot at the product layer while preserving OMA's meta-harness architecture: durable agent conversations, a real computer behind the agent, CLI as a first-class client, and a landing/dashboard that explain and operate that shape.

Grok Bot reference behaviors (from docs.x.ai/grok-bot, as captured in #459): account-scoped persistent VM, shared FS/browser/credentials across bots, per-bot screen, work continues when laptop is closed.

OMA today: meta-harness (SessionDO + harness + sandbox providers), append-only event log, vault proxy, bridge daemon, OpenShell, ACP local runtime, home session/runtime primitives (`docs/home-session.md`).

## Non-goals

- Replacing SessionDO's append-only event log or persist-before-broadcast contract.
- Making vault credentials visible inside sandboxes.
- Shipping a shared always-on account VM as the default multi-tenant compute model.
- Implementing the Rust CLI rewrite or every Console roadmap item in this RFC.

## Alternatives Considered

### Alternative A — Always-on shared account VM (Grok-like)

Each account gets a persistent VM/computer. All agents/sessions in the account share filesystem, browser, and credentials. The VM stays up; turns attach to it.

**Pros**
- Closest to Grok Bot mental model: "my agent has a computer".
- Lowest friction for continuity: files, browser state, installed tools persist naturally.
- Simple UX story for landing/console.

**Cons**
- **Cost:** always-on compute per account is expensive at idle, especially for self-hosted/CF multi-tenant deployment.
- **Multi-tenancy/isolation:** shared account VM means strong tenant isolation boundaries, noisy-neighbor control, quota enforcement, and lifecycle management. On Cloudflare, a long-lived VM is not the native primitive.
- **Security blast radius:** shared FS/browser/credentials across bots increases impact of prompt injection or agent mistakes. Vault proxy boundary becomes harder if "shared creds" means ambient machine creds.
- **Operational complexity:** patching, rebooting, snapshotting, migrating, and garbage collecting always-on VMs.

**Verdict:** Rejected as default. Keep as a possible future managed-compute product tier, not the base OMA shape.

### Alternative B — CLI relay is the only computer

The agent "computer" is always the user's paired local machine via `oma bridge daemon` / ACP runtime. Cloud has no persistent computer; cloud sandboxes are optional implementation detail.

**Pros**
- Uses hardware users already own; low platform compute cost.
- Local toolchains/repos/credentials are naturally available (with the #318 caveat).
- Strong fit for developer workflows and herdr.

**Cons**
- **Laptop-off fails:** Grok Bot's "work continues when laptop closed" is not met.
- **Availability coupling:** agent usefulness depends on user's machine uptime, network, sleep settings, and daemon health.
- **Onboarding friction:** first value requires installing/pairing a daemon before the agent can do real work.
- **Isolation gap:** local subprocess is powerful but less isolated than cloud sandbox/OpenShell; risky workloads need explicit isolation path.

**Verdict:** Rejected as only default. Keep CLI relay/bridge as bootstrap and as home-runtime substrate.

### Alternative C — Ephemeral cloud sandbox per session only (status quo++)

Every turn runs in an ephemeral sandbox selected by environment; no home runtime concept. Continuity lives only in SessionDO event log and explicit workspace snapshots.

**Pros**
- Simple isolation and billing model.
- Matches existing sandbox-provider architecture.
- Easy to reason about cleanup and security boundaries.

**Cons**
- **Product gap:** does not feel like a persistent teammate/computer.
- **Continuity tax:** rebuilding environment/context/files repeatedly is slow and awkward.
- **Poor fit for "message the agent anytime"** unless users understand sessions/environments deeply.

**Verdict:** Rejected as product default. Remains essential for isolated/risky work.

### Alternative D — Home runtime + ephemeral session sandboxes (Selected)

Keep Agent as the product noun. Give each Agent one long-lived **home session** (Bot-like inbox) and an optional/attachable **home runtime** (long-lived bridge/herdr/OpenShell-backed machine) for steady-state work. Use **ephemeral session sandboxes** for isolated/risky/parallel work. CLI relay bootstraps before home runtime is provisioned.

**Pros**
- Preserves SessionDO durability and event model.
- Delivers the "persistent teammate" UX without requiring an always-on shared VM per account.
- Lets compute be placed intentionally: home for continuity, ephemeral sandbox for isolation.
- Aligns with existing bridge/OpenShell/sandbox-provider work instead of replacing it.
- Supports laptop-off when home runtime is on an always-on host; supports local-first when paired to a laptop.

**Cons**
- More concepts: home session, home runtime, ephemeral session, sandbox provider.
- Requires clear UX so users understand where work runs.
- Home runtime lifecycle/health/credential model needs careful productization.

**Verdict:** **Selected.**

## Decision (Frozen)

The synthesis from #459 comment is binding for follow-up implementation:

1. **Harness path** — Keep SessionDO + persist-before-broadcast. Product noun stays Agent; add a long-lived **home / pinned session** as the Bot-like inbox so "message the teammate" feels continuous.
2. **Computer** — **Home runtime + ephemeral session sandboxes**. Bridge/herdr = home; OpenShell optional isolation on the relay path; cloud sandboxes for risky/isolation work. CLI relay bootstraps until home is provisioned.
3. **CLI + surface** — Align #433/#437: install/update, `sessions chat/tail` as primary client, herdr kind for home. Landing sells "your Agent has a computer"; Console shows home online/heartbeat + open sessions.

Rejected defaults: pure Grok-like always-on account VM; CLI-as-only-computer.

## Detailed Design

### 1. Harness message path

- **Ingress:** user/client sends message to a session (`POST /v1/sessions/:id/events` or chat endpoint). Home session is the default inbox for an Agent.
- **Durability:** SessionDO appends event to SQLite/event log before broadcast. Existing persist-before-broadcast contract remains.
- **Execution:** harness resolves agent config, environment, runtime binding/sandbox provider, and runs turn. Events stream over SSE/WS as today.
- **Recovery:** on crash/reconnect, clients replay from event log / last seen seq. Home session keeps identity across turns.
- **Status truth:** `running` means actively working; `idle` means waiting; `terminated`/error events mean error. UI must never paint idle as working.

### 2. Persistence model

| Object | Persistence | Notes |
|---|---|---|
| Agent | Durable config row, versioned | Product noun. |
| Home session | Durable SessionDO event log, `metadata.home=true` | One per agent; default inbox. |
| Ephemeral session | Durable event log while retained | Created for isolated/parallel work; can be archived/terminated. |
| Home runtime | Durable runtime registration + heartbeat presence | Long-lived paired machine/bridge/herdr. |
| Session sandbox | Ephemeral compute; optional workspace snapshot/restore | Destroyed/paused independently of session log. |
| Credentials | Vault records + outbound injection | Never enter sandbox; bridge/local injection follows #318 constraints. |

### 3. Sandbox vs CLI relay vs OpenShell matrix

| Dimension | Home runtime (bridge/herdr) | CLI relay (bootstrap) | Ephemeral cloud sandbox | OpenShell on relay path |
|---|---|---|---|---|
| Primary role | Steady-state computer | First-run/bootstrap access | Isolated/risky/parallel work | Isolated home-runtime execution |
| Persistence | Machine/runtime persists; session log persists | Depends on user machine | Sandbox ephemeral; log persists | Sandbox isolated; runtime persists |
| Laptop-off | Yes if host stays up | No | Yes (cloud) | Yes if host stays up |
| FS/toolchain | Real host FS/toolchain | Real host FS/toolchain | Image/environment-defined | Gateway sandbox FS/toolchain |
| Isolation | Low/medium (host process) unless OpenShell | Low/medium | Medium/high by provider | Higher (gateway policy) |
| Credentials | Vault/daemon injection; #318 limits for own-TLS clients | Same as bridge | Vault outbound proxy | Same policy model, gateway-enforced egress |
| Best for | Daily driver, repos, long-running teammate | Setup, quick local start | Untrusted code, CI-like tasks, bursts | Safer execution on a paired host |
| UX label | "Home computer" | "Local relay (bootstrap)" | "Isolated sandbox" | "Home computer (isolated)" |

### 4. CLI upgrade surface

Align with #433 (Rust rewrite/distribution) and #437 (herdr/local coding-agent support):

- **Install/update:** single binary installer from marketing/docs site; `oma update` self-update; checksums/signatures; Homebrew/apt optional later.
- **Primary commands:** `oma auth login`, `oma agents ...`, `oma sessions chat/tail/send`, `oma bridge setup/status`, `oma runtime ...`, `oma envs ...`, `oma usage`.
- **Home-first UX:** `oma agent open <id>` or equivalent should land in home session by default; `--new-session` for ephemeral work.
- **Herdr:** expose OMA as a first-class herdr kind; make CLI safe inside herdr panes (`HERDR_ENV`, no focus stealing, no destructive auto-upgrade in live pane).
- **Local ACP:** bridge/ACP path must be provable from installed client; failures loud, no silent fallback to wrong sandbox.
- **Compatibility:** preserve command/flag surface where practical during Node->Rust transition; keep `--json` stable.

### 5. Landing + dashboard UX

**Landing page**
- Hero: "Your Agent has a computer." Subcopy: persistent inbox + home runtime + isolated sandboxes when needed.
- Show the matrix visually: Home runtime, Ephemeral sandbox, CLI relay bootstrap.
- Proof points: durable session log, vault-injected credentials, OpenShell/subprocess/cloud providers, laptop-off on always-on home host.
- CTA: install CLI / pair runtime / open Console.

**Console dashboard**
- Agent/home strip: home runtime presence (`online`, `offline`, `provisioning`), last heartbeat, active home session.
- Open sessions: truthful status chips (working/idle/error), runtime/sandbox target, last activity.
- "Open home" primary action; "New isolated session" secondary action.
- Runtime/provider visibility: show whether home is bridge, herdr, OpenShell-isolated, or cloud sandbox.
- Security signal: vault-injected credentials, no secrets in sandbox; show #318-style limitation when local subprocess cannot inject own-TLS client creds.

## Implementation Slices

| Issue | Slice | Status |
|---|---|---|
| #460 | Home / pinned session (Bot-like inbox) | Closed |
| #461 | Home runtime: long-lived bridge/herdr + ephemeral session sandboxes | Closed |
| #462 | Landing: sell Agent + computer shape | Closed |
| #463 | Console: home runtime status + open sessions | Closed |
| #433 | Rust CLI rewrite / distribution | Open |
| #437 | First-class herdr + local coding-agent support | Open |
| #318 | Bridge vault credential injection limits/decision | Open (decision needed) |
| #347 | Console UX roadmap | Open |

## Open Questions

1. **Own-TLS local credential injection (#318):** accept local CA opt-in, keep git/HTTP-only injection, or per-tool hooks. Needs explicit owner decision.
2. **Home runtime provisioning:** should OMA offer a managed always-on home host product tier, or remain bring-your-own machine first?
3. **Session routing UX:** when should a message stay in home session vs. auto-create an isolated session? Default should be home; isolation should be explicit and easy.
4. **Herdr contract:** define the exact OMA herdr kind, idle/working/blocked mapping, and session identity contract in #437.
5. **Rust CLI migration:** compatibility window and shim strategy for `@getoma/cli` npm package.

## Acceptance Criteria for This RFC

- [x] Captures Grok Bot target behaviors and OMA current state.
- [x] Evaluates at least two structurally distinct alternatives (four evaluated).
- [x] Selects and justifies home runtime + ephemeral session sandboxes.
- [x] Synthesizes harness message path, persistence model, computer matrix, CLI upgrade surface, landing/dashboard UX.
- [x] Links implementation issues and open decisions.

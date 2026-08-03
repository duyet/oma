# @getoma/cli

## 0.1.8

### Patch Changes

- db536d2: Inject vault credentials for relayed sandbox ops through a local proxy in the bridge daemon.
- 5d49b35: Warn during bridge setup that local sandboxes use the machine's own git/gh credentials.
- 10f14e9: Add `oma bridge start`, `stop`, and `restart` to control the installed daemon
  service without a full re-`setup`. They dispatch to the host's service manager
  (launchd / systemd / Task Scheduler) and report daemon liveness afterward — the
  missing "reconnect this machine" verbs the Console now points users to.
- 86a03bb: bridge daemon: optional OpenShell sandbox backend for relayed sandbox ops (opt-in via `oma bridge setup` or `BRIDGE_SANDBOX_BACKEND=openshell`); `oma bridge status` now reports the active backend.
- 4e872c9: Add command-level tests for the `oma schedules` verbs; export the internal command registry so handlers are unit-testable with a stubbed fetch (no behavior change).

## 0.1.7

### Patch Changes

- ed4b9d9: Bridge daemon now reports each detected ACP agent's self-reported version
  (best-effort `--version` probe of the wrapped upstream binary) in the runtime
  `hello` manifest, so the Console can show "claude-acp (claude) v1.9.0". Probes
  run in parallel with a short timeout and fail soft — an unknown version just
  omits the field, never blocks the heartbeat.
- e527657: Add an ASCII "oma" banner to help + interactive mode, a bare-invocation
  interactive action menu, richer `oma bridge status` (local relay/command
  counters), and anonymous opt-out CLI telemetry (`oma telemetry status|enable|disable`, `OMA_TELEMETRY=0`).

## 0.1.6

### Patch Changes

- The bridge daemon can now execute sandbox ops relayed from the cloud deployment — a `subprocess` environment on OMA-on-Cloudflare runs its sandbox on this paired machine (per-session workdirs under ~/.local/share/oma/sandboxes).

## 0.1.5

### Patch Changes

- `bridge status` now lists the running sessions on this machine's runtime — session id, agent, status, ages — each with a clickable dashboard deep-link and an `oma sessions tail <id>` hint.

## 0.1.4

### Patch Changes

- `oma bridge` help now leads with the brand-mark banner.

## 0.1.3

### Patch Changes

- New bridge banner: a suspension-bridge mark replaces the old brackets logo.

## 0.1.2

### Patch Changes

- Bridge daemon hardening: liveness watchdog terminates and reconnects on a silent server (~70s without frames), reconnects use jittered exponential backoff, and the daemon flushes a state snapshot for observability. `bridge status` now reports daemon liveness (connected, pid, heartbeat age, uptime) and authorized workspaces.

## 0.1.1

### Patch Changes

- README rewritten for npm: npx-first usage (`npx @getoma/cli auth login`), the full command tree, and Bridge (local-runtime relay) docs.

## 0.1.0

### Minor Changes

- Rescoped from `@duyet/oma-cli` to `@getoma/cli` and reset versioning to `0.1.0`. Prior history is available on the old package.

## Historical — @duyet/oma-cli (pre-rescope)

## 0.8.0

### Minor Changes

- beec4d2: Add `oma schedules create|list|run|delete` commands for managing agent schedules (cron-fired sessions).

## 0.7.1

### Patch Changes

- 12661af: Add headless `oma auth login --device` (RFC 8628 device authorization: prints a URL + code, polls until approved) and `oma auth login --paste-token` (prints a URL, paste the token back) flows for non-interactive/CI environments.

## 0.7.0

### Minor Changes

- b26c048: Initial publish to npm: `@duyet/oma-sdk` (harness SDK) and `@duyet/oma-cli` (CLI tool).

## 0.6.0

### Minor Changes

- 87809ed: Finish the `openma` → `oma` rebrand in the public SDK and CLI surfaces.
  - `@duyet/oma-sdk`: renamed the exported `OpenMA` class to `Oma` and
    `OpenMAError` to `OmaError` (breaking — update imports and
    `instanceof` checks). The package is already deprecated in favor of
    `@anthropic-ai/sdk` pointed at the wire-compatible API.
  - `@duyet/oma-cli`: package description/keywords and the HTTP
    `user-agent` string now say `oma`/`OMA-CLI` instead of
    `openma`/`OpenManagedAgents-CLI`. The bridge daemon's launchd/systemd
    service label changed from `dev.openma.bridge` to `dev.oma.bridge`
    (already-installed daemons keep running under the old label until
    the user re-runs `oma bridge setup`, which re-registers under the
    new one — self-healing, no manual cleanup required).

## 0.5.0

### Minor Changes

- [#103](https://github.com/duyet/oma/pull/103) [`85c2e1c`](https://github.com/duyet/oma/commit/85c2e1c359f774a3dbafcc45a6e7875ebba55ff2) Thanks [@hrhrng](https://github.com/hrhrng)! - `oma bridge` daemon now serves multiple tenants from a single process.
  One daemon is authorized for every workspace the user is a member of;
  each spawned ACP child gets the per-tenant `oma_*` key matching the
  session's workspace.
  - `oma bridge setup` requests the multi-tenant `/exchange` shape and
    writes a `CredentialsV2` file (`{v:2, tenants:[…], …}`). Old v1
    creds files (`agentApiKey` at the top level) auto-migrate on next
    daemon start — calls `GET /agents/runtime/me` to pull the tenant
    list, falls back to a placeholder workspace if the server is
    unreachable so the daemon still runs offline.
  - `oma bridge refresh` (new) re-syncs the daemon's credentials with
    the user's current memberships. Adds keys for new workspaces, soft-
    revokes keys for removed ones, then `SIGHUP`s the running daemon
    so the change takes effect without a restart.
  - `SessionManager` looks up the right `oma_*` key per session by the
    inbound `session.start`'s `tenant_id`. Every outbound message the
    daemon sends carries `tenant_id` so the server can validate it
    against the runtime's authorized set.

  Backward-compatible: v1 daemons keep working against the new server
  shape (server returns the legacy `{runtime_id, token, agent_api_key}`
  when the request doesn't set `multi_tenant: true`). The workaround
  for multi-tenant — running multiple `OMA_PROFILE=…` daemons side by
  side — still works for separate server environments.

### Patch Changes

- [`31f7fbf`](https://github.com/duyet/oma/commit/31f7fbf67305f44831a379d9149bcf0c6a8d9c00) Thanks [@hrhrng](https://github.com/hrhrng)! - `oma bridge setup` now exits cleanly after "Done." instead of hanging
  for ~5 minutes on idle keep-alive HTTP sockets from the registry CDN
  fetch and the runtime-token probe. Daemon was already started by
  launchd / systemd / Task Scheduler — only the foreground setup process
  itself was waiting on the undici dispatcher to time out its sockets.
  Force-exits at end of runSetup, matching how npm / pnpm / gh handle
  the same constraint in their CLI commands.

  Adds an opt-in `OMA_DEBUG_HANDLES=1` env var that prints active
  handles + requests every 2s — useful for diagnosing future "process
  won't exit" regressions without redeploying.

## 0.4.1

### Patch Changes

- [#41](https://github.com/duyet/oma/pull/41) [`e370a4a`](https://github.com/duyet/oma/commit/e370a4ab550ca18a37e27761695fb9bbd2e8bdb7) Thanks [@hrhrng](https://github.com/hrhrng)! - `oma bridge setup` now exits cleanly after "Done." instead of hanging
  for ~5 minutes on idle keep-alive HTTP sockets from the registry CDN
  fetch and the runtime-token probe. Daemon was already started by
  launchd / systemd / Task Scheduler — only the foreground setup process
  itself was waiting on the undici dispatcher to time out its sockets.
  Force-exits at end of runSetup, matching how npm / pnpm / gh handle
  the same constraint in their CLI commands.

  Adds an opt-in `OMA_DEBUG_HANDLES=1` env var that prints active
  handles + requests every 2s — useful for diagnosing future "process
  won't exit" regressions without redeploying.

## 0.4.0

### Minor Changes

- [`4df9a0e`](https://github.com/duyet/oma/commit/4df9a0e677eb1712688134fc140edb6d0db3969a) Thanks [@hrhrng](https://github.com/hrhrng)! - Bridge: expand local ACP agent support to the full official registry,
  add cross-platform service install (launchd / systemd / Task Scheduler,
  all no-admin), and wire end-to-end conversation recovery so daemon
  restarts no longer drop context. `oma bridge setup` is now the single
  command on every platform — installs the system service, starts the
  daemon, and audits + offers ACP wrappers for install (npm packages or
  GitHub release tarballs). Includes `OMA_PROFILE` for prod/staging
  side-by-side daemons (default behavior unchanged for current users).

  Fixes a multi-profile bug where the launchd-spawned daemon silently
  dropped `OMA_PROFILE` and read the default profile's credentials,
  causing the "wrong" daemon to compete for the WS attach slot.

## 0.3.2

### Patch Changes

- [`018b647`](https://github.com/duyet/oma/commit/018b647536eb5d1398510fcc37f6c65447a801fd) Thanks [@hrhrng](https://github.com/hrhrng)! - Add Bridge subcommand section to top-level `oma` help so `setup`, `daemon`,
  `status`, `uninstall` are discoverable without grepping or guessing.

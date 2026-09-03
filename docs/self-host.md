# Self-host OMA — single-process Node deployment

A Node-side build of Open Managed Agents that runs on a single VPS / Mac /
Docker host without any Cloudflare account, Workers, Durable Objects, or
Containers. Storage is SQLite or Postgres + local filesystem. Sandboxes
are local subprocesses by default; switch to E2B for Firecracker isolation
when you're past trusted-developer territory.

> **One of three deployment topologies.** See [deployment.md](./deployment.md)
> for the full Self-host / CF Local / CF Prod comparison + decision
> matrix. This doc covers Self-host specifically.

> **Status:** Working PoC. The self-host route is a parallel implementation of
> the same `Services` abstractions used on Cloudflare, including better-auth
> multi-tenant. See "What works / doesn't" below.

## Choose a backend

One image, two compose files — pick the one that matches your durability
& concurrency story. You can switch later (see [Migrating between
backends](#migrating-between-backends) below).

| | SQLite + LocalFs (default) | Postgres + LocalFs |
|---|---|---|
| Compose file | `docker-compose.yml` | `docker-compose.postgres.yml` |
| Best for | Single-user self-host, dev, demo, ≤10 GB sessions | Multi-instance, ≥50M sessions/events rows, share existing PG |
| Concurrency | One writer (single oma-server) | Many writers; HA-able |
| Backups | `cp ./data/*.db` or [litestream](https://litestream.io) → S3 | `pg_dump` / managed PG snapshots |
| Extra services | None | + `postgres:16-alpine` (or external PG) |
| When to switch | "I want PG already" / "want to scale out" | — |

**Same Docker image either way** (`oma/main-node:dev` — the self-host Node.js server image, same control-plane API as the `apps/main` Cloudflare Worker, built from
`apps/main-node/Dockerfile`) — `DATABASE_URL` env at runtime decides.
SQLite needs only `DATABASE_PATH`; Postgres needs `DATABASE_URL=
postgres://…`. In Postgres mode better-auth's tables live in the same
PG database (no separate `auth.db` file); in SQLite mode they live in
`./data/auth.db`.

## Quick start (Docker, SQLite)

```bash
# 1. Get an Anthropic API key. Any Anthropic-compatible endpoint works.
cp .env.example .env

# Two secrets are required before first boot — both generated locally:
#   BETTER_AUTH_SECRET   — signs Console sessions
#   PLATFORM_ROOT_SECRET — encrypts credentials, model-card API keys, integration tokens
#                          (lose it and every encrypted row is unreadable — back it up)
$EDITOR .env
# BETTER_AUTH_SECRET=$(openssl rand -hex 32)
# PLATFORM_ROOT_SECRET=$(openssl rand -base64 32)
# API_KEY is prefilled as dev-test-key-change-me. A provider key is required
# for a successful turn — set ANTHROPIC_API_KEY, or add a Model Card.

# 2. Start (first time builds the image; subsequent runs skip --build)
docker compose -f docker-compose.yml up -d --build

# 3. Sanity check
curl localhost:8787/health
# → {"status":"ok","runtime":"node","pid":…,"uptime_s":…,"backends":{"db":"sqlite …",…}}

# 4. Create + drive an agent (API_KEY from .env; sessions require environment_id)
KEY=$(grep '^API_KEY=' .env | cut -d= -f2-)

AID=$(curl -s -X POST localhost:8787/v1/agents \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"shell","model":"claude-sonnet-4-6","system":"Use bash to answer.","tools":[{"type":"bash"}]}' \
  | jq -r .id)

EID=$(curl -s -X POST localhost:8787/v1/environments \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"name":"local","config":{"type":"cloud"}}' | jq -r .id)

SID=$(curl -s -X POST localhost:8787/v1/sessions \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d "{\"agent\":\"$AID\",\"environment_id\":\"$EID\"}" | jq -r .id)

# Open a streaming SSE in one terminal:
curl -N localhost:8787/v1/sessions/$SID/events/stream &

# Send a message in another:
curl -s -X POST localhost:8787/v1/sessions/$SID/events \
  -H "x-api-key: $KEY" -H 'content-type: application/json' \
  -d '{"events":[{"type":"user.message","content":[{"type":"text","text":"Run: ls -la / | head"}]}]}'

# Watch the SSE — you should see agent.tool_use → agent.tool_result →
# agent.message → session.status_idle
```

Subsequent commands:

```bash
docker compose -f docker-compose.yml logs -f   # follow logs
docker compose -f docker-compose.yml down       # stop, keep ./data
docker compose -f docker-compose.yml down -v    # stop, wipe volumes
```

## Quick start (no Docker)

```bash
pnpm install
cp .env.example .env
# Set PLATFORM_ROOT_SECRET and BETTER_AUTH_SECRET (required).
# API_KEY is prefilled as dev-test-key-change-me. A provider key is required
# for a successful turn — set ANTHROPIC_API_KEY, or add a Model Card.
ANTHROPIC_API_KEY=sk-... pnpm --filter @duyet/oma-main-node start
# `pnpm start` loads `.env` from cwd, apps/main-node/, or the repo root.
# Same curl flow as above against localhost:8787.
```

State lives at `./data/` (sqlite db + per-session sandbox workdirs).
Wipe + restart for a clean slate.

## Quick start (Kubernetes + Helm)

The `charts/oma` chart packages main-node + oma-vault as a single-pod
Deployment with a shared PVC, RWO storage, and `strategy: Recreate` (sqlite
single-writer). It can also auto-install the
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller
+ CRDs via a Helm hook. See [`charts/oma/README.md`](../charts/oma/README.md)
for the full values reference.

```bash
# 1. Create the Secret out-of-band (never pass real secrets on the Helm CLI):
kubectl create namespace oma
kubectl -n oma create secret generic oma \
  --from-literal=PLATFORM_ROOT_SECRET="$(openssl rand -base64 32)" \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=ANTHROPIC_API_KEY="sk-ant-..."

# 2. Install — bring your own Secret, enable ingress + agent-sandbox controller
helm install oma ./charts/oma \
  --namespace oma \
  --set secret.existingSecret=oma \
  --set config.publicBaseUrl=https://app.oma.duyet.net \
  --set ingress.enabled=true \
  --set ingress.host=app.oma.duyet.net \
  --set agentSandbox.enabled=true

# 3. Sanity check
kubectl -n oma port-forward svc/oma 8787:8787 &
curl localhost:8787/health
```

The `SANDBOX_PROVIDER=k8s` default creates one `Sandbox` CR
(`agents.x-k8s.io`) per session and execs tool commands into the adopted
pod — same model the homelab raw manifests at `infra/homelab/oma/` use.
For local testing only, `--set secret.autoGenerate=true` generates stable
`PLATFORM_ROOT_SECRET` / `BETTER_AUTH_SECRET` (never rotate the former —
encrypted vault rows become unreadable; see
[`docs/platform-root-secret-rotation.md`](platform-root-secret-rotation.md)).

## Postgres backend

When to flip to Postgres: multi-instance, large tables (50M+ rows on
sessions/events), or because you'd rather operate the PG cluster you
already have than introduce a new SQLite footprint.

```bash
# 1. Same .env (Postgres compose already sets DATABASE_URL internally)
cp .env.example .env
$EDITOR .env  # set ANTHROPIC_API_KEY

# 2. Start — brings up postgres:16-alpine + oma-server + oma-vault
docker compose -f docker-compose.postgres.yml up -d --build

# 3. Sanity check — note backends.db reports postgres
curl localhost:8787/health
# → {"status":"ok","backends":{"agents":"postgres","events":"postgres","db":"postgres ..."},...}
```

Curl flow + console URL are identical — application code is backend-
agnostic. Same `oma/main-node:dev` image, just different env.

What changes vs the SQLite stack:

- `oma-server` reads `DATABASE_URL=postgres://oma:oma@postgres:5432/oma`
  (set in `docker-compose.postgres.yml`); the same SqlClient port serves
  every store package, so business code is identical.
- `oma-vault` follows the same dispatch — when `DATABASE_URL` is a
  postgres URL the sidecar reads credentials from PG (otherwise it falls
  back to the bundled SQLite path). The two services MUST agree on the
  backend or vault credential injection won't see anything to inject.
- A `postgres:16-alpine` service ships with the compose, persisted on a
  named volume `oma-pgdata`. No host port published; only `oma-server`
  reaches it on the bridge network. Add `ports: ["5432:5432"]` if you
  want `psql` access from the host.
- **better-auth runs on the same Postgres database.** No separate
  `auth.db` file; the `user` / `session` / `account` / `verification`
  tables sit alongside `agents`, `sessions`, `tenant`, etc. and are
  bootstrapped at first start (idempotent `CREATE TABLE IF NOT EXISTS`
  with PG-native `boolean` / `timestamptz` types). Internally we open
  a small `pg.Pool` (max 10) for better-auth's kysely PostgresDialect
  — the main store stays on `postgres.js`. `AUTH_DATABASE_PATH` is
  ignored in PG mode.

### Running multiple oma-server replicas (PG mode only)

PG mode supports >1 `oma-server` process behind a load balancer. SSE
fanout works across replicas: every `append` issues `NOTIFY
oma_session_events '{sid,seq}'` on a shared PG channel, and every
replica `LISTEN`s on the same channel. When replica B receives a NOTIFY
for a session it has a local SSE writer for, it fetches `seq >
lastForwarded` from the SQL log and pushes the new events to its
writer. Local round-trip latency is typically <100 ms; we measure ~2 ms
on a same-host PG and ~80 ms via curl through two `pnpm start`
processes.

**`/auth/*` is also replica-safe** in PG mode: better-auth's tables
live in the shared Postgres, so any replica can serve any auth
request. No sticky sessions required.

Hard requirements before you scale out:

1. **Memory blob storage MUST be shared across replicas.** Two paths
   work:
   - **Local NFS / EFS / shared docker volume + chokidar** — bind the
     same `MEMORY_BLOB_DIR` into every replica. Each replica runs its
     own chokidar watcher; concurrent watchers firing for the same
     write are no-ops past the first because `upsertFromEvent` is
     idempotent on `(store_id, path)` + sha256 etag.
   - **S3 / S3-compatible bucket** — set `MEMORY_S3_*` env vars (see
     "S3-backed memory store" below). main-node switches to the
     `S3BlobStore` adapter and a per-store-leased `S3PollAdapter`
     replaces chokidar. Multi-replica safe by construction (only the
     lease holder polls a given store at a time).
2. **`oma-vault` is stateless and can also replicate.** It's a
   per-request DB lookup + header inject — no caches, no per-process
   state beyond the on-disk CA. To run N copies, mount the same
   `OMA_VAULT_CA_DIR` into every replica (the first one to boot
   generates `ca.{crt,key}` under an O_EXCL `ca.lock`; the others
   wait+read), put a Service / LB in front, and set
   `OMA_VAULT_PROXY_URL=http://oma-vault:14322` (or your LB DNS) on
   sandboxes. **Constraint:** all vault replicas MUST share the same
   CA key — sandboxes that trust one CA but get TLS-terminated by a
   replica with a different CA will see cert errors. The shared
   `./data/oma-vault-ca` volume + lock-on-create handles this.
   `docker-compose.postgres.yml` ships with a commented
   `deploy.replicas: 3` example on the `oma-vault` service.

Sticky cookies are NOT required for `/v1/*`, `/auth/*`, or outbound
sandbox traffic — the SSE fanout is replica-agnostic, better-auth is
on the shared PG, and the vault is stateless.

### S3-backed memory store (multi-replica friendly)

When `MEMORY_S3_ENDPOINT` + `MEMORY_S3_BUCKET` + `MEMORY_S3_ACCESS_KEY`
+ `MEMORY_S3_SECRET_KEY` are all set, main-node swaps the
`LocalFsBlobStore` for an S3-compatible `S3BlobStore` (works against
AWS S3, MinIO, Tigris, Wasabi, Cloudflare R2's S3 API, etc.) and
starts an `S3PollAdapter` that lists the bucket every
`MEMORY_S3_POLL_INTERVAL_SEC` (default 30) for new/changed objects.
Sandbox sides (Daytona / E2B) already mount the bucket via s3fs using
the same env vars; the loop "agent writes via FUSE → S3 PUT → poller
upserts SQL index" is the multi-replica analog of the chokidar path.

Limitation: `local-subprocess` sandboxes still need
`MEMORY_BLOB_DIR` for their `/mnt/memory` symlinks — the local subprocess
adapter doesn't speak s3fs. Use S3 mode together with a remote sandbox
provider. Inside the `oma/main-node` container the adapter creates a
real `/mnt/memory/<storeName>` symlink (visible to bash that hardcodes
the path); on hosts without a writable `/mnt`, it transparently rewrites
`/mnt/memory/...` to the workdir-relative `.mnt/memory/...` so harness
read/write/edit/glob/grep tools still land on the right files.

### Pointing at an existing Postgres cluster

To use a managed PG (RDS / Neon / Supabase / your own cluster) instead
of the bundled `postgres` service, drop the `postgres` service block
from `docker-compose.postgres.yml` and override `DATABASE_URL` in
`.env`:

```bash
# .env
DATABASE_URL=postgres://user:pw@my-pg.internal:5432/oma_prod
# OMA_VAULT_DATABASE_URL=...   # if you want the vault sidecar to use a different DB
```

The schema bootstraps on first start (`CREATE TABLE IF NOT EXISTS`
across all 13 tables); no separate migration step. Re-running is safe.

### Migrating between backends

Switching directions in either direction means moving rows; no
in-place upgrade. Two paths:

**SQLite → Postgres (one-way).** Spin up the PG stack pointed at a
fresh DB. Then export from SQLite + import via `psql`:

```bash
# SQLite side
sqlite3 ./data/oma.db ".dump agents agent_versions sessions session_events session_streams memories memory_stores memory_versions vaults credentials session_memory_stores tenant membership" > /tmp/oma-dump.sql
# Strip SQLite-specific pragmas (BEGIN/COMMIT survive; PRAGMA / sqlite_sequence don't)
sed -i '/^PRAGMA\|sqlite_sequence/d' /tmp/oma-dump.sql
# PG side
docker exec -i oma-postgres psql -U oma -d oma < /tmp/oma-dump.sql
```

`agent.id`, `session.id` etc. are TEXT, BIGINT timestamps work in both,
JSON columns are TEXT not jsonb — no schema translation needed beyond
the pragma strip.

**Postgres → SQLite (one-way).** Less common, but possible: `pg_dump
--inserts --data-only` + a sed pass to `INSERT OR REPLACE`, then
`sqlite3 oma.db < dump.sql`. Auth.db is unaffected (already SQLite on
both sides).

### Backups & operations

| | SQLite + LocalFs | Postgres + LocalFs |
|---|---|---|
| Hot backup | [litestream](https://litestream.io) replicates `./data/*.db` to S3 continuously | `pg_dump` cron / managed PG snapshots / WAL streaming |
| Restore | Stop server, copy db back, restart | `pg_restore` into fresh PG, point `DATABASE_URL` at it |
| Sandbox workdirs | Always on local FS — back up `./data/sandboxes/` separately | Same |
| Memory blobs | `./data/memory-blobs/` — back up separately or set `MEMORY_S3_*` (s3fs mount) | Same |
| auth.db | Always SQLite — back up `./data/auth.db` | Same |

Both backends pass the same crash-recovery test surface (55 tests across
adapter / recovery-logic / SIGKILL bootstrap / CF DO eviction).

## Operator gotchas

Things I'd document if I were the on-call who got paged:

- **`AUTH_DISABLED=1` must be in `.env`, not the shell.** `docker
  compose` substitutes `${AUTH_DISABLED}` from the compose-time env
  (your `.env` at the compose dir). Putting it in the shell only is
  silently ignored. With the flag on, the Console skips login
  (`/auth-info` returns `providers: []`).
- **`docker compose restart` does NOT re-read env.** After editing
  `.env`, use `docker compose up -d --force-recreate oma-server` to
  pick up changes (or `down` then `up`).
- **`agent.system` defaults to empty.** The Anthropic API rejects
  `system: [{type:"text", text:""}]` — main-node passes `undefined`
  when system is empty. If you ever see "system: text content blocks
  must be non-empty", your model proxy is stricter than the SDK
  expects. Set a non-empty `system` on the agent.
- **`tools=9` even when you set `tools:[]` on the agent.** main-node's
  `buildTools` always wires the harness's standard set (bash, read,
  write, output_file, edit, glob, grep, web_fetch, web_search). Per-agent tool
  filtering happens at routing time, not at build time. To disable a
  tool entirely, omit it from `agent.tools`; the harness will see it
  but never invoke it.
- **`oma-vault` won't see PG credentials if you set `DATABASE_URL`
  on `oma-server` only.** Both services share the same store; if you
  want vault credential injection on PG, both must point at PG. The
  PG compose handles this for you; if you customise, mirror the env.
- **First boot from an old `oma.db`.** The unified-runtime refactor
  added two columns to `sessions` (`turn_id`, `turn_started_at`).
  main-node runs `ALTER TABLE … ADD COLUMN` idempotently on every
  start; existing dbs upgrade in place. If you see `no such column:
  turn_id`, you're on a pre-migration build — pull a newer image.
- **A hung tool/harness call no longer leaves a session `running`
  forever (issue #135).** `OMA_TURN_TIMEOUT_MS` bounds a single turn —
  default 15 minutes — after which the session is force-failed with a
  `session.error` and returns to `idle`; the client can retry with a
  new `user.message`. Set it to a larger number for legitimately
  long-running agentic turns, or `"off"` to disable the watchdog
  entirely. This is a backstop, not the primary error path — it never
  auto-retries (retrying a hang just burns another full ceiling).

## Trusted reverse-proxy / SSO-gateway auth (opt-in)

If you already terminate auth at a reverse proxy or SSO gateway (nginx,
oauth2-proxy, Envoy/Istio ingress, Cloudflare Access, etc.), you can let
main-node trust the identity that gateway forwards instead of making users
log in a second time. **Default off — a no-op unless you set the env
vars below.**

```bash
# .env
TRUSTED_PROXY_AUTH_ENABLED=1
TRUSTED_PROXY_HEADER=X-Forwarded-User          # default shown
TRUSTED_PROXY_EMAIL_HEADER=X-Forwarded-Email   # optional — see below
TRUSTED_PROXY_SHARED_SECRET=<32+ random bytes>  # REQUIRED — see threat model
TRUSTED_PROXY_SHARED_SECRET_HEADER=X-Trusted-Proxy-Secret  # default shown
```

| Env var | Required | Default | Meaning |
|---|---|---|---|
| `TRUSTED_PROXY_AUTH_ENABLED` | no | off | Master switch. Anything else below is inert unless this is `1`. |
| `TRUSTED_PROXY_HEADER` | when enabled | `X-Forwarded-User` | Header carrying the authenticated identity (used as the account email unless `TRUSTED_PROXY_EMAIL_HEADER` is also set). |
| `TRUSTED_PROXY_EMAIL_HEADER` | no | — | Separate header for the email, when `TRUSTED_PROXY_HEADER` carries a non-email login/subject instead. |
| `TRUSTED_PROXY_SHARED_SECRET` | **yes, when enabled** | — | Secret known only to you and your gateway. main-node refuses to boot with the feature enabled and this unset. |
| `TRUSTED_PROXY_SHARED_SECRET_HEADER` | no | `X-Trusted-Proxy-Secret` | Header carrying the shared secret above. |

**Threat model.** A header is never proof of anything by itself — if this
app is reachable directly (a common k8s misconfiguration: a `Service`
that's cluster-internally reachable, or a gateway that forgets to strip
client-supplied copies of these headers), anyone could set
`X-Forwarded-User: admin@yourco.com` and impersonate that user. The
`TRUSTED_PROXY_SHARED_SECRET` is the mitigation: configure your gateway to
inject it on every forwarded request (and to strip/overwrite any
client-supplied copy of both this header and the identity header before
proxying). main-node verifies the secret with a constant-time comparison
before trusting the identity header at all, and **fails closed**: if the
guard doesn't pass on a request that's attempting trusted-proxy auth (the
identity header is present but the secret is missing/wrong), that request
is rejected outright with `401` — it never silently falls back to
password/cookie login, which could mask an active spoofing attempt or a
misconfigured gateway behind an ordinary "not logged in" response.

Trusted-proxy identities are resolved per-request against better-auth's
`user` table (find-or-create by email) — no better-auth cookie/session is
minted, matching how header-based reverse-proxy auth works elsewhere
(Grafana's `auth.proxy`, Gitea, etc.): the gateway is the actual session
authority, and every request is re-validated against the guard.

This is currently wired for the self-host/Node runtime only (`apps/main-node`);
the Cloudflare Workers deployment (`apps/main`) doesn't have this yet.

## Crash recovery demo

OMA's self-host mode persists session state to SQLite + the event log on
every write, so a `kill -9` on the Node process doesn't lose the
conversation.

```bash
# 1. Create a session, drop in a few messages.
SID=$(curl -s -X POST localhost:8787/v1/sessions -d '{}' | jq -r .id)
for i in 1 2 3; do
  curl -s -X POST localhost:8787/v1/sessions/$SID/_test_emit \
    -H 'content-type: application/json' \
    -d "{\"text\":\"event-$i\"}"
done

# 2. SSE shows id:1 / id:2 / id:3 events.
curl -N localhost:8787/v1/sessions/$SID/events/stream
# (Ctrl-C to stop)

# 3. Hard-kill the server. (Or `docker compose down --no-stop` then `up`.)
docker kill -s SIGKILL oma-server

# 4. Restart.
docker compose -f docker-compose.yml up -d

# 5. Reconnect SSE with the last seen seq — only events after seq 3 stream.
curl -N -H 'Last-Event-ID: 3' localhost:8787/v1/sessions/$SID/events/stream
# Or `Last-Event-ID: 0` to replay everything.
```

The same demo works on the Postgres compose unchanged.

## What works on the self-host build today

| Feature | Status |
|---|---|
| `/v1/agents` full CRUD with AMA `_oma:` envelope, versions, archive, delete | ✓ via `@duyet/oma-http-routes` |
| `/v1/sessions` create + list + get + archive + delete + threads | ✓ via `@duyet/oma-http-routes` (NodeSessionRouter wraps SessionRegistry + SqlEventLog) |
| `POST /v1/sessions/:id/events` (5-type whitelist + harness dispatch) | ✓ via SessionRouter.appendEvent |
| `POST /v1/sessions/:id/messages` one-shot user.message | ✓ |
| `GET /v1/sessions/:id/events/stream` SSE w/ Last-Event-ID resume | ✓ via SessionRouter.streamEvents |
| `GET /v1/sessions/:id/trajectory` | ✓ via SessionRouter.getTrajectory |
| `POST /v1/sessions/:id/__debug_recovery__` (token-gated) | ✓ via SessionRouter.triggerDebugRecovery |
| `user.interrupt` aborts in-flight harness | ✓ via SessionRouter.interrupt → SessionRegistry abort |
| Real LLM token streaming (any Anthropic-compatible endpoint) | ✓ |
| Crash recovery on process restart | ✓ |
| `bash` tool via host subprocess | ✓ |
| `read` / `write` / `edit` / `glob` / `grep` tools | ✓ (workdir-relative) |
| `web_fetch` tool (HTML → markdown via turndown) | ✓ |
| `web_search` tool | ⏸  needs TAVILY_API_KEY env var |
| `browser` tool | ✗  CF-only (uses @cloudflare/playwright) |
| Memory stores (mount + agent fs writes → SQL index) | ✓ symlink + chokidar watcher |
| `/v1/vaults` + `/v1/vaults/:id/credentials` full CRUD + `mcp_oauth_validate` | ✓ via package |
| Vault credential injection for outbound MCP / API calls | ✓ via `oma-vault` sidecar (uses `@duyet/oma-vault-forward`) |
| `/v1/api_keys` mint / list / revoke (SHA-256 hashed in `api_keys` table) | ✓ |
| `/v1/me` + `/v1/me/tenants` + `/v1/me/cli-tokens` | ✓ |
| `/v1/tenants` create workspace + membership | ✓ (no shard assign — CF-only) |
| `/v1/oma/*` mirror namespace | ✓ |
| Postgres backend (DATABASE_URL=postgres://...) | ✓ same code path as SQLite |
| Multi-instance oma-server (PG mode) | ✓ PG `LISTEN/NOTIFY`-backed SSE fanout; better-auth on shared PG; `oma-vault` is stateless and replicable; needs shared `MEMORY_BLOB_DIR` or `MEMORY_S3_*` |
| Multi-tenant authentication (better-auth) | ✓ email+password + OTP, AUTH_DISABLED=1 escape |
| Console UI (vite dev or built `dist`) | ✓ talks to main-node via `/auth/*` + `/v1/*` |
| Integrations (linear / github / slack) — read-side CRUD on publications, installations, dispatch rules | ✓ wired via `@duyet/oma-integrations-adapters-node` (set `PLATFORM_ROOT_SECRET`). |
| Integrations write-side OAuth callbacks + setup pages + webhook ingest + publication-create | ✓ wired via `@duyet/oma-http-routes` `buildIntegrationsGatewayRoutes` + `NodeInstallBridge`. Linear / GitHub / Slack OAuth callbacks land on main-node directly. Webhook receivers (with synthesized `user.message` resume into the bound session), GitHub `refresh-by-vault`, the Linear MCP `/linear/mcp/:sessionId` route, and publication-create endpoints (`start-a1` / `credentials` / `handoff-link` / `personal-token`) all run in-process. |
| `/billing-api/*`, `/v1/internal/usage_events` | ✗  CF-only by design. Talks to a `USAGE_METER` worker not in this repo. Self-host operators bring their own metering or skip. |
| `/v1/runtimes` (RuntimeRoom DO) | ✗  CF-only (DO + WebSocket-backed) |
| Cron / queue handlers | ✗  CF-only (P3 will land scheduler abstraction) |

## Sandbox modes

OMA now supports **multiple sandbox providers simultaneously** through a
`SandboxProviderRegistry` — not one global `SANDBOX_PROVIDER`. Providers
can be seeded from env vars at startup (system providers) or added via the
API at runtime (BYOK — bring your own key).

### Built-in providers

Seeded from env vars at startup. The first matching env key makes the
provider available:

| Mode | Use when | Configuration |
|---|---|---|
| `LocalSubprocessSandbox` (default) | Local dev, trusted agent code | Nothing — host subprocess in `./data/sandboxes/<sessionId>/`. |
| `DaytonaSandbox` | Production / untrusted code with managed VMs | `DAYTONA_API_KEY=...`, optional `DAYTONA_API_URL` (self-hosted) and `SANDBOX_IMAGE=node:22-slim`. Vault CA uploaded into the box on first exec; memory mount via `MEMORY_S3_*` env vars (s3fs installed by the adapter). |
| `LiteBoxSandbox` | Local hardware isolation without docker | Host needs `/dev/kvm` (Linux) or Apple Silicon (macOS). Optional `LITEBOX_MEMORY_MIB`, `LITEBOX_CPUS`, `SANDBOX_IMAGE`. BoxLite ships its own Firecracker runtime (no daemon). |
| `E2BSandbox` | Firecracker microVM SaaS | `E2B_API_KEY=...`, optional `SANDBOX_IMAGE` (template id). Memory via `MEMORY_S3_*` env vars (same s3fs setup as Daytona). Outbound vault CA upload requires a template that allows `sudo` writes to `/etc/ssl/`. |
| `BoxRunSandbox` | Remote BoxLite REST endpoint (no KVM on the OMA host) | `BOXRUN_URL=http://host:8100/v1/default`, optional `BOXRUN_TOKEN`. No mount primitive — bake a custom image with s3fs preinstalled if you need `/mnt/memory`. |
| `OpenShellSandbox` | NVIDIA OpenShell gateway (gRPC) | `OPENSHELL_GATEWAY_ENDPOINT=host:port`, optional `OPENSHELL_TOKEN` (bearer). Policy-enforced, isolated agent sandboxes. `OPENSHELL_GATEWAY_TLS=1` + `OPENSHELL_GATEWAY_CA_PATH` (and `..._CERT_PATH`/`..._KEY_PATH` for mTLS) enable TLS. Self-host Node speaks gRPC directly; the Cloudflare deployment reaches it over `fetch` via the k8s-bridge OpenShell backend (`OPENSHELL_BRIDGE_URL`). |
| `CloudflareSandbox` | If you happen to deploy on CF Workers + Containers | Use the regular `apps/agent` worker, not main-node. |
| `browser-vm` (listed, not usable here) | N/A on self-host | Seeded from the same shared provider list as Cloudflare, but `GET /v1/hosting_types` always reports it `not_configured` on main-node — the RuntimeRoom WebSocket relay it needs is a Cloudflare-only surface. Use one of the providers above instead. |
| `dynamic-workers` (listed, not usable here) | N/A on self-host | A Cloudflare Worker Loader (`env.LOADER`) binding, not a sandbox adapter — no Node equivalent (`nodeCompatible: false`). Pure code-eval / "Code Mode" agents on Cloudflare only; see [Runtimes](runtimes.md). |

**The old `SANDBOX_PROVIDER` env var still works** as the fallback default
when an environment has no explicit provider selection. New deployments should
use per-environment `config.sandbox_provider` (see below) for finer control.

**Auto-detected default:** when neither an environment's `sandbox_provider`
nor `SANDBOX_PROVIDER` is set, main-node no longer falls back straight to
`subprocess` — it first checks whether `OPENSHELL_GATEWAY_ENDPOINT` is
configured and the gateway is currently reachable (a cheap gRPC
connectivity probe, ~1.5s timeout, computed once and cached for the
process lifetime), preferring OpenShell when it is. Override with
`OPENSHELL_MODE`: `auto` (default) probes and picks the best fit,
`openshell` forces OpenShell without probing (fails loudly at first use if
actually unreachable, same as any other explicit selection), `subprocess`
disables the auto-detect entirely. See `resolveDefaultLocalSandboxProvider`
in `packages/sandbox-sdk/src/provider-config.ts`.

### Running an OpenShell gateway

The `openshell` adapter talks gRPC to any reachable gateway — the same
adapter covers both deployment shapes below; only
`OPENSHELL_GATEWAY_ENDPOINT` changes.

**Local (CLI).** Install the OpenShell CLI + gateway on the same machine as
main-node:

```bash
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
openshell status        # confirm the gateway is up
```

The gateway runs as a background service (systemd / Homebrew) and
auto-detects a local compute driver (Docker, Podman, or MicroVM). Then in
`.env.local`:

```bash
OPENSHELL_GATEWAY_ENDPOINT=localhost:50051   # host:port the gateway listens on
```

With `OPENSHELL_MODE=auto` (the default) nothing else is needed — the
startup probe finds the gateway and prefers it over `subprocess`.

**Kubernetes cluster.** Deploy the gateway in-cluster from NVIDIA's OCI
Helm chart. The [Agent Sandbox controller + CRDs](https://github.com/kubernetes-sigs/agent-sandbox)
must be installed first — the same controller OMA's own `k8s` provider
uses, so a cluster already running that provider has the prerequisite:

```bash
helm install openshell oci://ghcr.io/nvidia/openshell/helm-chart -n openshell --create-namespace
```

Point main-node (in-cluster, or through an ingress/LB that passes gRPC)
at the gateway Service:

```bash
OPENSHELL_GATEWAY_ENDPOINT=openshell.openshell.svc.cluster.local:50051
OPENSHELL_GATEWAY_TLS=1                       # chart bootstraps PKI; use its CA
OPENSHELL_GATEWAY_CA_PATH=/etc/openshell/ca.crt
# + OPENSHELL_GATEWAY_CERT_PATH / OPENSHELL_GATEWAY_KEY_PATH for mTLS
```

Upstream marks the Kubernetes path "under active development — expect
rough edges"; the local Docker/Podman path is the stable one. Either way,
selection is per-environment (`config.sandbox_provider: "openshell"`) or
via the auto-detected default described above.

**On the Cloudflare deployment**, a Worker cannot speak gRPC, so it reaches
OpenShell through the **k8s-bridge** running its OpenShell backend — same
image, same binary as the Kubernetes-backed bridge, just a different
`BRIDGE_BACKEND`. The recommended way to run it in-cluster is the
[`charts/oma-k8s-bridge`](../charts/oma-k8s-bridge/README.md#openshell-backend)
Helm chart with `config.backend: openshell`:

```bash
helm install oma-k8s-bridge-openshell ./charts/oma-k8s-bridge \
  --namespace oma \
  --set secret.existingSecret=oma-k8s-bridge-token \
  --set config.backend=openshell \
  --set openshell.endpoint=openshell.openshell.svc.cluster.local:50051
```

See that chart's README for TLS/mTLS and token-secret wiring. For local
testing (no cluster), you can instead run the bridge as a bare Node process
next to the gateway with `BRIDGE_BACKEND=openshell` plus the same
`OPENSHELL_*` env vars above (it holds the gRPC client).

Either way, point the Worker at the resulting bridge with `wrangler secret
put OPENSHELL_BRIDGE_URL` (and `OPENSHELL_BRIDGE_TOKEN` matching the
bridge's `K8S_BRIDGE_TOKEN`). A session with `config.sandbox_provider:
"openshell"` then resolves to a pure-`fetch` client against the bridge —
the Worker never touches gRPC. A missing `OPENSHELL_BRIDGE_URL` fails
loudly with a `session.error` (parity with boxrun's missing `BOXRUN_URL`).
Limitation: memory-store / session-outputs mounts aren't available over
the bridge's HTTP API, same as boxrun and k8s-remote.

#### How OMA environment settings map to OpenShell policy

An OMA environment's `config.networking` / `config.packages` are translated
into a downstream OpenShell `SandboxPolicy` (proto `SandboxSpec.policy`) and
attached at `CreateSandbox`, so OMA's egress restrictions are enforced by the
gateway's default-deny proxy. The mapping is a pure module
(`packages/sandbox-sdk/src/adapters/openshell-policy.ts`) used by **both** paths:
the direct gRPC adapter (self-host) and the bridge's OpenShell backend (CF, the
policy is mapped on the Worker and forwarded through the bridge).

| OMA environment setting | OpenShell policy result |
|---|---|
| `networking.type: "limited"` + `allowed_hosts` | One `NetworkPolicyRule` ("oma") whose `endpoints` are the listed hosts. Egress to anything else is denied. |
| `networking.type: "unrestricted"` | **No policy attached** — the gateway applies its built-in default policy. OpenShell has **no allow-all wildcard** (bare `*`/`**` is rejected by its validator), so this is *not* true unrestricted access. Logged as a warning. |
| `networking.allow_package_managers: true` | Registry hosts for each **declared** package manager in `config.packages` are added to the allowlist (pip→pypi.org + files.pythonhosted.org, npm→registry.npmjs.org, apt→deb/security mirrors, cargo→crates.io, gem→rubygems.org, go→proxy/sum.golang.org). If no packages are declared, a warning is logged. |
| `networking.allow_mcp_servers: true` | The deployment's MCP-proxy host(s) are added when provided (`OPENSHELL_MCP_PROXY_HOST`). OpenShell bypasses OMA's outbound proxy (it runs its own egress proxy), so with no host configured this is logged as a warning rather than silently enforced. |
| `config.packages` (installation) | **Not installed** on the OpenShell path — the adapter only sets image + env. Packages inform the registry allowlist above; bake the actual tools into a custom `OPENSHELL_IMAGE`. Logged as a warning. |

All unmappable/partial settings are surfaced as loud warnings
(`op: openshell.policy.map`) rather than silently dropped. Filesystem policy is
set to `include_workdir: true` (workspace read-write); OpenShell enriches the
rest of the baseline runtime paths itself.

### BYOK (bring your own key)

Register additional sandbox providers at runtime via the REST API:

```bash
# Register a BYOK provider
curl -X POST /v1/sandbox_providers \
  -H 'content-type: application/json' \
  -d '{
    "type": "daytona",
    "label": "My Daytona prod",
    "apiKey": "dna_...",
    "baseURL": "https://my-daytona.example.com"
  }'

# List registered providers (system + BYOK)
GET /v1/sandbox_providers

# Rotate a provider's key
PUT /v1/sandbox_providers/:id

# Delete a BYOK provider
DELETE /v1/sandbox_providers/:id
```

System providers (seeded from env vars) are read-only and cannot be deleted
via the API. BYOK providers are ephemeral (in-memory on the Node build) —
re-register after restart, or use the Console's environment picker to
re-select a system provider.

### Per-environment provider selection

Environments carry their own sandbox provider reference. Set
`config.sandbox_provider` to any registered provider ID:

```json
{
  "config": {
    "sandbox_provider": "my-daytona-prod",
    "packages": { "pip": ["numpy", "pandas"] }
  }
}
```

Fallback chain: `config.sandbox_provider` → `config.type` (legacy) →
`SANDBOX_PROVIDER` env → `subprocess`. This means existing env configs
that only set `config.type` continue to work unchanged.

### Multi-provider capability matrix

| Provider | bash | fs | net | `/mnt/memory` | `/mnt/outputs` | vault CA | workspace backup |
|---|---|---|---|---|---|---|---|
| `LocalSubprocess` | ✓ | ✓ | ✓ | ✓ (real symlink at /mnt/memory inside the container; falls back to workdir-relative `.mnt/memory` when /mnt isn't writable) | ✓ (same pattern) | ✓ | ✓ (tar+upload to BlobStore) |
| `LiteBox` | ✓ | ✓ | ✓ | ✓ (host bind-mount via SimpleBox volumes) | ✓ | ✓ (CA copyIn on first exec) | ✓ (tar via exec + readFileBytes) |
| `Daytona` | ✓ | ✓ | ✓ | ✓ (s3fs, requires `MEMORY_S3_*`) | ✓ (single-bucket layout: outputs under `session-outputs/<tenant>/<session>/`) | ✓ (CA upload on box create) | ✓ (tar via exec + readFileBytes) |
| `E2B` | ✓ | ✓ | ✓ | ✓ (s3fs, requires `MEMORY_S3_*` + template with s3fs) | ✓ (same bucket, session-outputs prefix) | ⚠ (template must allow sudo writes to /etc/ssl/) | ✓ (tar via exec + readFileBytes) |
| `BoxRun` | ✓ | ✓ | ✓ | ✗ (HTTP API has no mount primitive — use a custom image with s3fs preinstalled) | ✗ (same — no host-bind primitive) | ✓ (CA upload via tar PUT) | ⚠ (best-effort tar via exec) |
| `CloudflareSandbox` | ✓ | ✓ | ✓ | ✓ (R2 + FUSE) | ✓ | ✓ (interceptHttps + outboundHandlers) | ✓ (squashfs to R2 backup bucket) |
| `dynamic-workers` | ✗ (JS/Wasm eval only, no shell) | ✗ (no filesystem — `readFile`/`writeFile` fail clearly) | ✗ by default (`allowNetwork: false` ⇒ `globalOutbound: null` blocks all egress; set it true to inherit the worker's) | ✗ | ✗ | n/a | ✗ (nothing persists between calls) |

Read-only memory mounts: enforced via `chmod -R a-w` on the mount target where supported (LocalSubprocess, Daytona, E2B). LiteBox honors the `readOnly` flag on its volume mount. CloudflareSandbox does not enforce ro at the FS layer — the harness's write tool checks `assertWritable` and refuses writes regardless of provider.

## Vault credential injection (oma-vault sidecar)

When the sandbox's bash runs `curl https://api.github.com/...`, OMA injects
the matching vault credential as an `Authorization: Bearer ...` header
without ever exposing the token to the agent process. This mirrors the CF
build's `outboundByHost` + `MAIN_MCP.outboundForward` zero-trust pattern.

How it works:

```
sandbox bash
  ├── HTTPS_PROXY=http://oma-vault:14322
  ├── NODE_EXTRA_CA_CERTS=/app/data/oma-vault-ca/ca.crt
  ├── SSL_CERT_FILE=/app/data/oma-vault-ca/ca.crt
  └── curl https://api.github.com/user
              │
              ▼
       oma-vault (mockttp HTTPS MITM proxy)
       ├── Strip incoming Authorization (zero-trust)
       ├── Look up credential matching api.github.com host
       ├── Inject Authorization: Bearer <vault token>
       └── Forward to upstream
                  │
                  ▼
           api.github.com  ← sees real Authorization header
```

Set up:

```bash
# 1. Create a vault.
VID=$(curl -s -X POST localhost:8787/v1/vaults \
  -H 'content-type: application/json' \
  -d '{"name":"github-prod"}' | jq -r .id)

# 2. Add a static_bearer credential bound to api.github.com.
curl -s -X POST localhost:8787/v1/vaults/$VID/credentials \
  -H 'content-type: application/json' \
  -d '{
    "display_name":"github-pat",
    "auth":{
      "type":"static_bearer",
      "token":"ghp_xxx",
      "mcp_server_url":"https://api.github.com"
    }
  }'

# 3. Run an agent. Its bash `curl https://api.github.com/user` will see
#    the credential injected; the model never sees the raw token.
```

The CA at `./data/oma-vault-ca/ca.crt` is regenerated on first vault
start and persisted across restarts. Sandboxes mounted with the shared
`./data` volume pick it up automatically through `OMA_VAULT_CA_CERT`.

**Tenant scope (`OMA_TENANT`).** Unset, empty, or `*` is wildcard: the
sidecar matches credentials by hostname across tenants. That is safe for
a single-operator install (zero or one `tenant_id` in `credentials`).
If the table has more than one distinct `tenant_id`, oma-vault **refuses
to start** rather than injecting the first matching token. For a
multi-user deploy set `OMA_TENANT=tn_xxx` in `.env` (compose) or
`vault.tenant` (Helm) so lookup cannot cross tenants. Compose and the
chart no longer default to `*`.

## Architecture

```
                 Browser / curl / oma CLI
                          │
                          ▼ HTTP/SSE
              ┌──────────────────────────┐
              │  main-node (single proc) │
              │                          │
              │  • Hono routes           │
              │  • SessionRegistry       │
              │  • SqlEventLog           │
              │  • InProcessEventStreamHub (sqlite mode)│
              │  • PgEventStreamHub      (pg mode, LISTEN/NOTIFY)│
              │  • DefaultHarness ──┐    │
              │                     │    │
              │  Sandbox: ▼         │    │
              │   subprocess|e2b    │    │
              └──────┬─────┬───────┘
                     │     │
            ┌────────┘     └─────────┐
            ▼                        ▼
        SQLite                     E2B Cloud
        ./data/oma.db              (Firecracker microVMs)
        ./data/sandboxes/         OR
                                   host /bin/sh subprocess
```

Eight runtime-agnostic ports separate "what" from "how":

  - `BlobStore`  — files/memory/workspace bytes (R2 / S3 / local FS)
  - `KvStore`    — config/snapshot key-value (CONFIG_KV / pg table / memory)
  - `SqlClient`  — SQL with batch (D1 / better-sqlite3 / postgres.js)
  - `EventLogRepo`+`StreamRepo` — per-session event durability
  - `SandboxExecutor` — code execution sandbox (CF / E2B / subprocess)
  - `ToMarkdownProvider` — web_fetch HTML→md (Workers AI / turndown)
  - `TenantDbProvider` — per-tenant DB resolution

Each port has a Cloudflare adapter and a Node adapter. The Node entry
wires the Node adapters; the CF entry wires the CF adapters. Business
code (routes, harness, store services) is the same on both.

## Console UI

The same `apps/console` build that ships with CF prod talks to main-node.
Auth path is `/auth/*` (matches CF), data routes are `/v1/*`. Cookie auth
via better-auth.

**Two ways to serve it:**

### Single port (production / `docker compose up`)

The main-node Docker image embeds `apps/console/dist` and main-node's
`serveStatic` middleware mounts it at `"*"` with index.html SPA fallback.
Open `http://localhost:8787` and you get the Console — same port as the
API. CF prod has the equivalent via the `ASSETS` binding; same UX,
different mechanism.

Local `pnpm --filter @duyet/oma-main-node start` does the same when
`apps/console/dist` exists (`pnpm --filter managed-agents-console build`)
or `CONSOLE_DIR` points at that dist. Unset + no dist → API-only JSON
404 on `/` (use the Vite path below).

```bash
docker compose -f docker-compose.yml up -d
open http://localhost:8787
```

To skip the console build (smaller API-only image, ~250MB → ~245MB):

```bash
docker build -f apps/main-node/Dockerfile --build-arg SKIP_CONSOLE=1 \
  -t oma/main-node:api-only .
```

`SKIP_CONSOLE=1` leaves `apps/console/dist` without `index.html`. main-node
only mounts the SPA when that file exists, so the image stays API-only
even if `CONSOLE_DIR` is still set.

### Vite dev server (development)

Hot-reload on console source changes. main-node still runs separately
on 8787; vite proxies `/v1` + `/auth` to it.

```bash
# Terminal 1: main-node
ANTHROPIC_API_KEY=sk-... BETTER_AUTH_SECRET=$(openssl rand -hex 32) \
  PUBLIC_BASE_URL=http://localhost:5173 \
  pnpm --filter @duyet/oma-main-node start

# Terminal 2: console (Vite dev server, proxies /v1 + /auth → :8787)
VITE_API_TARGET=http://localhost:8787 pnpm dev:console
# → http://localhost:5173

# Terminal 3 (optional): oma-vault — outbound credential injection
DATABASE_PATH=$(pwd)/data/oma.db OMA_VAULT_CA_DIR=$(pwd)/data/oma-vault-ca \
  pnpm --filter @duyet/oma-vault start
```

Open `http://localhost:5173` (dev) or `http://localhost:8787` (docker),
sign up via email + password. The verification OTP is printed to
main-node's stdout — paste into the console verify-signup screen.
Operators wiring real email replace the `sendVerificationOTP` callback
in `apps/main-node/src/auth/config.ts` with a Resend / SES / SMTP call.

**`AUTH_DISABLED=1`:** put it in `.env` (not only the shell — see
[Operator gotchas](#operator-gotchas)), restart, and the Console **skips
login** — you enter the default tenant with no signup. `/auth-info`
returns `providers: []` (the Console treats that as auth-off, not
email-only). Leftover `/auth/*` calls return **410** rather than 404.
Do not use this in production.

### GitHub OAuth login (optional)

The Console's Login page can show a "Continue with GitHub" button. It's
opt-in — set both `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` and the
button appears automatically (`/auth-info` starts advertising `"github"`
in its `providers` list); leave them unset and nothing changes.

1. Create a GitHub OAuth App: **github.com/settings/developers → OAuth
   Apps → New OAuth App** (or, for an org, under the org's settings).
2. **Homepage URL**: your `PUBLIC_BASE_URL` (e.g. `http://localhost:8787`
   or `https://console.example.com`).
3. **Authorization callback URL**: `${PUBLIC_BASE_URL}/auth/callback/github`
   (e.g. `http://localhost:8787/auth/callback/github`) — better-auth
   mounts the social-provider callback at `/auth/callback/:id` under the
   `/auth` basePath.
4. Copy the generated **Client ID** and **Client Secret** into
   `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` (`.env` for Docker, or
   your shell env for `pnpm --filter @duyet/oma-main-node start`).
5. Restart main-node (`docker compose up -d --force-recreate oma-server`,
   or just re-run the process for bare `pnpm start`).

Same env vars work unchanged on the Cloudflare deploy (`apps/main`) —
set them as Worker secrets (`wrangler secret put GITHUB_CLIENT_ID`, etc.)
instead of `.env`.

Endpoints main-node implements for the console:
- `/auth-info` (provider list)
- `/auth/*` (better-auth: sign-up, sign-in, sign-out, get-session, OTP)
- `/v1/me`, `/v1/me/tenants`
- `/v1/agents` CRUD, `/v1/sessions` CRUD + events + SSE stream
- `/v1/memory_stores` + `/memories` + per-session bindings
- `/v1/vaults` + `/credentials`
- `/v1/models/list`
- `/v1/integrations/{linear,github,slack}/{installations,publications,...}` — read + persona/capability PATCH + dispatch-rule CRUD. Active when `PLATFORM_ROOT_SECRET` env var is set. Publication-create endpoints (`start-a1`, `credentials`, `handoff-link`, `personal-token`) now run in-process via `NodeInstallBridge.startInstallation` — wire shape matches the CF gateway verbatim. The OAuth callback / setup-page / webhook / Linear MCP / GitHub refresh-by-vault routes are all in-process via `buildIntegrationsGatewayRoutes`.

Endpoints stubbed (return empty `data: []` so the UI degrades gracefully):
- `/v1/environments`, `/v1/api_keys`, `/v1/me/cli-tokens`,
  `/v1/runtimes`, `/v1/skills`, `/v1/model_cards`

These pages render an "empty" state in the console; their CF counterparts
will land in main-node as follow-up work.

### Integrations on self-host

The Node read + write side comes online automatically when
`PLATFORM_ROOT_SECRET` is set. The schema (linear_*, github_*, slack_*
tables) is created on boot via `applyIntegrationsSchema`. Webhook-events
retention sweep also runs every minute (cron-gated to 04:00 UTC) when
the schema is present.

What this gets you:
- Console can list / patch / unpublish existing publications and dispatch
  rules.
- Linear / GitHub / Slack OAuth callbacks land directly on main-node
  (`/linear/oauth/...`, `/github/install/...`, `/slack/oauth/...`,
  `/<provider>-setup/<token>`). The provider implementations from
  `packages/{linear,github,slack}` run in-process via `NodeInstallBridge`.
- Webhook receivers (`/linear/webhook/...`, `/github/webhook/...`,
  `/slack/webhook/...`) verify HMAC signatures via the same provider
  code path the CF gateway uses. When a verified webhook lands on a
  session bound to the publication (Linear comment-reply, GitHub
  per_issue PR comment, Slack thread reply), `NodeInstallBridge`'s
  in-process `SessionCreator.resume` synthesizes a `user.message`
  event and appends it to the session via the same `NodeSessionRouter`
  the public `POST /v1/sessions/:id/events` route uses — the harness
  wakes up automatically.
- The Linear MCP escape-hatch route (`POST /linear/mcp/:sessionId`)
  proxies `linear_graphql` calls with the per-session bearer.
- GitHub `refresh-by-vault` (`POST /github/internal/refresh-by-vault`)
  mints fresh installation tokens via App-JWT and rotates the static_bearer
  + cap_cli vault credentials in place.
- Linear cron dispatch (auto-pickup of issues) is exposed to the Node
  scheduler via `linearDispatchTick` from
  `@duyet/oma-scheduler/jobs/linear-dispatch`.

Required env on the Node side: `PLATFORM_ROOT_SECRET` (at-rest encryption
for OAuth tokens), `INTEGRATIONS_INTERNAL_TOKEN` (gates
`/github/internal/*`), `GATEWAY_ORIGIN` (public origin handed to providers
as redirect_uri / webhook URL — defaults to `PUBLIC_BASE_URL`). Provider
client_id / client_secret pairs go on the App row at install time, not in
env. CF stays unchanged: same gateway worker, same INTEGRATIONS service
binding, same shared INTEGRATIONS_DB.

`/billing-api/*` and `/v1/internal/usage_events` are CF-only by design
(both call out to a `USAGE_METER` worker that lives in a separate repo).
Self-host operators run their own metering or skip the billing pipeline.

## Production hardening (what's NOT in the PoC)

If you take this past trusted-dev territory, you'll want:

  - **Real auth.** Today every request is `tenant_id="default"`. Wire
    better-auth + the `auth.ts` middleware that apps/main uses.
  - **E2B (or equivalent) sandbox.** `LocalSubprocessSandbox` is a
    `chmod 777` on your host — fine for trusted dev, deadly for an agent
    a stranger can prompt-inject.
  - **Backups.** SQLite + ./data is one host. `litestream` to S3 covers
    point-in-time recovery; for higher durability, swap to Postgres.
  - **Observability.** No Analytics Engine equivalent yet. Pipe
    `pino` stdout into Loki / Grafana / your shipper of choice.

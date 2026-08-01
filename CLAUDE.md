# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Open-source, self-hostable reimplementation of the Claude Managed Agents API. A **meta-harness**: the platform (a `SessionDO` Durable Object) prepares *what* an agent has (tools, skills, history, sandbox, credentials); a **harness** decides *how* to drive the model loop. The same business logic runs two ways — Cloudflare (Workers + Durable Objects + Containers) and self-hosted Node (`docker compose`). pnpm monorepo (`apps/*`, `packages/*`).

The domain model, tool catalog, event types, harness API, and release process live in the imported `@AGENTS.md` below — don't restate them here.

## Commands

- Install: `pnpm install` (pnpm 11, Node ≥20). pnpm 11 **hard-fails** install if a native dependency isn't listed under `allowBuilds:` in `pnpm-workspace.yaml`.
- Dev (Cloudflare simulators): `pnpm dev` — API on `:8787`, Console on `:5173`.
- **Typecheck: `pnpm typecheck`** — root `tsc --noEmit` plus a separate node-only pass (`typecheck:node`); node packages are excluded from the root `tsc`.
- **Test: `pnpm test`** — runs three suites in sequence (all required): root `vitest run` (Cloudflare Workers pool) → `test:packages` → `test:console`.
- Single test (workers pool): `pnpm vitest run path/to/file.test.ts -t "case name"`.
- Single test (node-pool package): `pnpm --filter @duyet/oma-session-runtime test -- run <file> -t "name"`.

## Gotchas that will bite you

- **`typecheck` and `test` both gate PRs.** `.github/workflows/ci.yml` runs both jobs on every PR and both block merge — a red test job is not advisory. Run `pnpm typecheck && pnpm test` locally before every push (or use `/preflight`) so CI doesn't catch it for you.
- **The vitest suite is split by pool.** Root `vitest run` uses `@cloudflare/vitest-pool-workers`. Node-native packages ship their own `vitest.config.ts` with `pool: "threads"` and run **only** via `pnpm --filter <pkg> test`, excluded from the root run via its `test.exclude` list. `test:packages` wires up 6 of them: `session-runtime`, `cap`, `main-node`, `integrations-adapters-node`, `sandbox`, `k8s-bridge`. That is why `pnpm test` chains three commands. **Known gap:** `packages/schema`, `packages/browser-harness`, `packages/observability`, and `packages/vault-forward` also ship `pool: "threads"` configs but are wired into neither `test:packages` nor the root `exclude` list — `browser-harness`/`observability`/`vault-forward` (6 test files total) currently fall through into the root Workers-pool run instead of their own Node pool.
- **Internal `@duyet/oma-*` packages have no build step** — they ship raw `.ts` (`main`/`exports` point at `src/*.ts`), resolved via workspace links plus a hand-maintained alias wall in `vitest.config.ts`. Adding a new package **subpath** may need a new alias entry there, or workers-pool tests won't resolve it. Only `@getoma/cli` and `@getoma/sdk` have a build.
- **Harnesses register by name** in `apps/agent/src/index.ts` (`registerHarness("default", …)`); an agent selects one via `harness: "<name>"`. The seam is `apps/agent/src/harness/interface.ts`. Use `/new-harness` to add one.
- **The prompt cache is byte-sensitive.** `deriveModelContext` output must be byte-deterministic and `<system-reminder>` injections must sit in the cached prefix — any drift silently invalidates Anthropic's cache. See the contract comments in `harness/interface.ts`.
- **Model provider resolution** is in `apps/agent/src/harness/provider.ts` — branches on `ApiCompat` (`ant` / `ant-compatible` / `oai` / `oai-compatible`); the OpenAI-compat path uses `/chat/completions`, never the Responses API.
- **`SessionDO`** (`apps/agent/src/runtime/session-do.ts`) is the per-session Durable Object: append-only event log (DO-SQLite), streaming lifecycle, crash recovery. Streaming chunk/thinking/tool-input events are broadcast-only; the final `agent.*` event is the persisted record.
- **Credentials never enter the sandbox** — injected by an outbound proxy; MCP calls proxy through the main worker. Don't add code paths that hand plaintext credentials to the agent DO.
- **Pagination**: every paginated table exposes `created_at` + `id`, ordered `(created_at, id) DESC`; cursors are opaque and a stale cursor silently restarts from page 1. Helpers in `packages/shared/src/pagination.ts`.

## Style

No linter or formatter is configured — match surrounding code: 2-space indent, double quotes, semicolons, trailing commas, extensionless relative imports, `import type` for types, `interface` for object shapes / `type` for unions. Server JSX in workers uses `hono/jsx`, not React.

## Required secrets (before first boot)

- `BETTER_AUTH_SECRET` — signs Console sessions (`openssl rand -hex 32`).
- `PLATFORM_ROOT_SECRET` — at-rest encryption for stored credentials; **back it up — losing it makes every encrypted row unreadable** (`openssl rand -base64 32`). Also required by the test bindings.

## Docs & landing page must track features

Every PR that adds, changes, or removes a user-facing feature must update the matching docs in the same PR: `AGENTS.md` (domain reference), the relevant `docs/*.md` page, and — when the feature is marketable (new harness, tool, sandbox provider, integration, schedule/deployment capability) — the landing page in `apps/web` (feature lists, provider/harness rosters, `src/pages/features/`). Before finishing any feature work, grep docs and `apps/web` for stale claims about the touched area and fix drift; never let the landing page advertise less (or more) than what's shipped.

## Commits

Conventional Commits with a scope: `feat(agent):`, `fix(harness):`, `ci:`, `test:`, `docs:`. PRs squash-merge with a `(#NNN)` suffix. A changeset is needed **only** when `@getoma/cli` or `@getoma/sdk` changed — use `/changeset`.

---

@AGENTS.md

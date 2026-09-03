# GitHub Actions in this repo

| Workflow | Purpose |
|---|---|
| `ci.yml` | PR + main gate — `pnpm typecheck` and `pnpm test` |
| `automerge.yml` | Squash-merge PRs after CI succeeds. Skips release-please and changeset version PRs (`scripts/should-skip-automerge.mjs`). Those PRs use inline verify in `release.yml` / `release-please.yml`. |
| `release.yml` | changeset npm publish for `@getoma/cli` / `@getoma/sdk`; inline CI + auto-merge on the Version Packages PR |
| `release-please.yml` | Conventional-commit bumps for root / web / docker; inline CI + auto-merge on the release-please PR. `@getoma/cli` / `@getoma/sdk` stay on `release.yml` (changesets). |
| `build-sandbox-image.yml` | builds the agent sandbox container image and pushes to GHCR for OSS users to pull |
| `build-example-images.yml` | builds/pushes the `examples/**` demo images to GHCR |
| `self-improvement-agent.yml` | opt-in cron that calls an already-running OMA instance's REST API |
| `deploy-main.yml` | deploys `apps/main` (core API worker → `oma-managed-agents`) |
| `deploy-agent.yml` | deploys `apps/agent` (SessionDO + sandbox → `oma-sandbox-default`) |
| `deploy-integrations.yml` | deploys `apps/integrations` (webhook gateway → `oma-managed-agents-integrations`) |
| `deploy-website.yml` | builds + deploys `apps/web` (marketing site → `oma.duyet.net`) |
| `deploy-docs.yml` | builds + deploys `apps/docs` (docs site → `docs.oma.duyet.net`) |

## Deploy workflows

Each deploy workflow runs on push to `main` when files in its path change.
All require these repo secrets:

| Secret | Description |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare API token with Workers permissions |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID |

Worker deploys (`deploy-main` / `deploy-agent` / `deploy-integrations`)
trigger on their app path **and** any `packages/**` change — workers
bundle workspace packages at deploy time, so a selective package list
routinely left prod stale. Website also watches `packages/fit-diagram/**`.
Docs stays scoped to `apps/docs/**` (Starlight content lives there; root
`docs/` is repo-side developer notes and is not the public site).

## Self-host deploy

Fork the repo, fill in `apps/*/wrangler.jsonc` with your CF resource IDs,
add the two secrets above, and the workflows will deploy on push to main.
Alternatively, run `wrangler deploy` from each app dir.

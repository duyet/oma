# Project Structure

```
open-managed-agents/
├── apps/
│   ├── main/              # API worker (Cloudflare) — Hono routes, auth, rate limiting
│   ├── main-node/         # apps/main-node — the self-host Node.js server (same control-plane API as apps/main, packaged for docker compose)
│   ├── agent/              # Agent worker — SessionDO + harness + sandbox
│   ├── integrations/      # Integrations gateway — Linear / GitHub / Slack OAuth + webhooks
│   ├── oma-vault/         # Vault sidecar — outbound auth-header injection (per-host secrets)
│   ├── console/            # Web dashboard — React + Vite + Tailwind v4
│   ├── docs/               # Docs site (Astro Starlight) — published to docs.oma.duyet.net
│   └── web/                # Marketing site (Astro) — published to oma.duyet.net
├── packages/
│   ├── cli/                       # `oma` CLI — agent / session / integration commands
│   ├── sdk/                       # TypeScript SDK — typed REST + SSE client (`Oma` class)
│   ├── api-types/                 # Shared TypeScript types (config schemas, events)
│   ├── http-routes/               # Public REST route definitions (shared by main + main-node)
│   ├── session-runtime/           # Harness runtime — event log, broadcast, recovery
│   ├── sandbox/                   # Sandbox adapters (subprocess / litebox / daytona / e2b / boxrun)
│   ├── credentials-store/         # Encrypted credentials (AES-GCM under PLATFORM_ROOT_SECRET)
│   ├── model-cards-store/         # Encrypted model-card API keys
│   ├── vaults-store/              # Vault definitions + outbound auth wiring
│   ├── linear/  github/  slack/   # Provider logic (OAuth, webhook signing, MCP wiring)
│   ├── integrations-core/         # Provider-neutral persistence interfaces
│   └── integrations-adapters-{cf,node}/  # D1 / KV / Workers + Postgres / FS implementations
├── docs/                  # Internal design RFCs (not the user-facing site)
├── examples/              # Copy-paste agent/environment configs + ready-to-use Docker images
├── test/                  # Unit + integration tests
└── scripts/               # Deployment + maintenance scripts
```

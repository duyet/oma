import { defineConfig } from "vitest/config";
import { cloudflarePool, cloudflareTest } from "@cloudflare/vitest-pool-workers";

const cfWorkerOptions = {
  wrangler: { configPath: "./wrangler.test.jsonc" },
  miniflare: {
    bindings: {
      API_KEY: "test-key",
      ANTHROPIC_API_KEY: "sk-ant-test-key",
      DREAM_CURATOR_MODE: "dedup",
      BETTER_AUTH_SECRET: "test-auth-secret-for-vitest",
      // Required by buildServices for at-rest encryption of credentials.auth
      // and model_cards.api_key_cipher. Tests don't care about the value as
      // long as it's stable across encrypt/decrypt within a single process.
      PLATFORM_ROOT_SECRET: "test-platform-root-secret-padded-to-thirtytwo",
      RATE_LIMIT_WRITE: 10000,
      RATE_LIMIT_READ: 10000,
    },
  },
};

export default defineConfig({
  // cloudflareTest registers the `cloudflare:test` virtual module
  // (runInDurableObject, listDurableObjectIds, etc.) — the pool runner
  // alone doesn't expose it, only the plugin does.
  plugins: [cloudflareTest(cfWorkerOptions)],
  resolve: {
    // vitest-pool-workers bridges these into the miniflare/workerd runtime
    // by string match — RegExp entries only work for the vitest module graph
    // (Vite resolver), not for workerd's package resolution. So every
    // workspace package + subpath that workerd-side test code imports
    // needs an explicit string alias here.
    alias: [
      // Stub out @cloudflare/sandbox in tests — the real module depends on
      // @cloudflare/containers which has workerd-native code that miniflare
      // can't load. Production builds use wrangler bundling which handles this.
      { find: "@cloudflare/sandbox", replacement: "./test/sandbox-stub.ts" },

      // ─── Stores: package + test-fakes subpath ─────────────────────────
      { find: "@duyet/oma-anyrouter", replacement: "./packages/anyrouter/src/index.ts" },
      { find: "@duyet/oma-api-types", replacement: "./packages/api-types/src/index.ts" },
      { find: "@duyet/oma-cf-billing", replacement: "./packages/cf-billing/src/index.ts" },
      { find: "@duyet/oma-eval-core", replacement: "./packages/eval-core/src/index.ts" },
      { find: "@duyet/oma-shared", replacement: "./packages/shared/src/index.ts" },
      { find: "@duyet/oma-memory-store/test-fakes", replacement: "./packages/memory-store/src/test-fakes.ts" },
      { find: "@duyet/oma-memory-store/adapters/local-fs-blob", replacement: "./packages/memory-store/src/adapters/local-fs-blob.ts" },
      { find: "@duyet/oma-memory-store/adapters/s3-blob", replacement: "./packages/memory-store/src/adapters/s3-blob.ts" },
      { find: "@duyet/oma-memory-store", replacement: "./packages/memory-store/src/index.ts" },
      { find: "@duyet/oma-dreams-store/test-fakes", replacement: "./packages/dreams-store/src/test-fakes.ts" },
      { find: "@duyet/oma-dreams-store", replacement: "./packages/dreams-store/src/index.ts" },
      { find: "@duyet/oma-dreams-pipeline", replacement: "./packages/dreams-pipeline/src/index.ts" },
      { find: "@duyet/oma-credentials-store/test-fakes", replacement: "./packages/credentials-store/src/test-fakes.ts" },
      { find: "@duyet/oma-credentials-store", replacement: "./packages/credentials-store/src/index.ts" },
      { find: "@duyet/oma-vaults-store/test-fakes", replacement: "./packages/vaults-store/src/test-fakes.ts" },
      { find: "@duyet/oma-vaults-store", replacement: "./packages/vaults-store/src/index.ts" },
      { find: "@duyet/oma-sessions-store/test-fakes", replacement: "./packages/sessions-store/src/test-fakes.ts" },
      { find: "@duyet/oma-sessions-store", replacement: "./packages/sessions-store/src/index.ts" },
      { find: "@duyet/oma-files-store/test-fakes", replacement: "./packages/files-store/src/test-fakes.ts" },
      { find: "@duyet/oma-files-store", replacement: "./packages/files-store/src/index.ts" },
      { find: "@duyet/oma-evals-store/test-fakes", replacement: "./packages/evals-store/src/test-fakes.ts" },
      { find: "@duyet/oma-evals-store", replacement: "./packages/evals-store/src/index.ts" },
      { find: "@duyet/oma-model-cards-store/test-fakes", replacement: "./packages/model-cards-store/src/test-fakes.ts" },
      { find: "@duyet/oma-model-cards-store", replacement: "./packages/model-cards-store/src/index.ts" },
      // apps/agent subpath — apps/main re-uses the agent DO's notify
      // dispatcher for per-schedule alerts (issue #313).
      { find: "@duyet/oma-agent/runtime/notify-dispatch", replacement: "./apps/agent/src/runtime/notify-dispatch.ts" },
      { find: "@duyet/oma-agents-store/test-fakes", replacement: "./packages/agents-store/src/test-fakes.ts" },
      { find: "@duyet/oma-agents-store", replacement: "./packages/agents-store/src/index.ts" },
      { find: "@duyet/oma-publications-store/test-fakes", replacement: "./packages/publications-store/src/test-fakes.ts" },
      { find: "@duyet/oma-publications-store", replacement: "./packages/publications-store/src/index.ts" },
      { find: "@duyet/oma-environments-store/test-fakes", replacement: "./packages/environments-store/src/test-fakes.ts" },
      { find: "@duyet/oma-environments-store", replacement: "./packages/environments-store/src/index.ts" },
      { find: "@duyet/oma-outbound-snapshots-store/test-fakes", replacement: "./packages/outbound-snapshots-store/src/test-fakes.ts" },
      { find: "@duyet/oma-outbound-snapshots-store", replacement: "./packages/outbound-snapshots-store/src/index.ts" },
      { find: "@duyet/oma-session-secrets-store/test-fakes", replacement: "./packages/session-secrets-store/src/test-fakes.ts" },
      { find: "@duyet/oma-session-secrets-store", replacement: "./packages/session-secrets-store/src/index.ts" },
      { find: "@duyet/oma-services", replacement: "./packages/services/src/index.ts" },

      // ─── sql-client ───────────────────────────────────────────────────
      { find: "@duyet/oma-sql-client/adapters/cf-d1", replacement: "./packages/sql-client/src/adapters/cf-d1.ts" },
      { find: "@duyet/oma-sql-client", replacement: "./packages/sql-client/src/index.ts" },

      // ─── scheduler (subpaths matter) ──────────────────────────────────
      { find: "@duyet/oma-scheduler/cf", replacement: "./packages/scheduler/src/adapters/cf.ts" },
      { find: "@duyet/oma-scheduler/node", replacement: "./packages/scheduler/src/adapters/node.ts" },
      { find: "@duyet/oma-scheduler/jobs/memory-retention", replacement: "./packages/scheduler/src/jobs/memory-retention.ts" },
      { find: "@duyet/oma-scheduler/jobs/webhook-events-retention", replacement: "./packages/scheduler/src/jobs/webhook-events-retention.ts" },
      { find: "@duyet/oma-scheduler/jobs/linear-dispatch", replacement: "./packages/scheduler/src/jobs/linear-dispatch.ts" },
      { find: "@duyet/oma-scheduler/jobs/scheduled-agent-runs-store", replacement: "./packages/scheduler/src/jobs/scheduled-agent-runs-store.ts" },
      { find: "@duyet/oma-scheduler/jobs/scheduled-agent-runs", replacement: "./packages/scheduler/src/jobs/scheduled-agent-runs.ts" },
      { find: "@duyet/oma-scheduler/jobs/scheduled-deployment-runs-store", replacement: "./packages/scheduler/src/jobs/scheduled-deployment-runs-store.ts" },
      { find: "@duyet/oma-scheduler/jobs/scheduled-deployment-runs", replacement: "./packages/scheduler/src/jobs/scheduled-deployment-runs.ts" },
      { find: "@duyet/oma-scheduler", replacement: "./packages/scheduler/src/index.ts" },

      // ─── queue ────────────────────────────────────────────────────────
      { find: "@duyet/oma-queue/cf", replacement: "./packages/queue/src/adapters/cf.ts" },
      { find: "@duyet/oma-queue/pg", replacement: "./packages/queue/src/adapters/pg.ts" },
      { find: "@duyet/oma-queue/in-memory", replacement: "./packages/queue/src/adapters/in-memory.ts" },
      { find: "@duyet/oma-queue/handlers/memory-events", replacement: "./packages/queue/src/handlers/memory-events.ts" },
      { find: "@duyet/oma-queue", replacement: "./packages/queue/src/index.ts" },

      // ─── evals-runner / tenant-db / event-log / cap ───────────────────
      { find: "@duyet/oma-evals-runner", replacement: "./packages/evals-runner/src/index.ts" },
      { find: "@duyet/oma-tenant-db/test-fakes", replacement: "./packages/tenant-db/src/test-fakes.ts" },
      { find: "@duyet/oma-tenant-db", replacement: "./packages/tenant-db/src/index.ts" },
      { find: "@duyet/oma-tenant-dbs-store/test-fakes", replacement: "./packages/tenant-dbs-store/src/test-fakes.ts" },
      { find: "@duyet/oma-tenant-dbs-store", replacement: "./packages/tenant-dbs-store/src/index.ts" },
      { find: "@duyet/oma-event-log/memory", replacement: "./packages/event-log/src/memory/index.ts" },
      { find: "@duyet/oma-event-log/cf-do", replacement: "./packages/event-log/src/cf-do/index.ts" },
      { find: "@duyet/oma-event-log/sql", replacement: "./packages/event-log/src/sql/index.ts" },
      { find: "@duyet/oma-event-log", replacement: "./packages/event-log/src/index.ts" },
      { find: "@duyet/oma-cap/test-fakes", replacement: "./packages/cap/src/test-fakes.ts" },
      { find: "@duyet/oma-cap", replacement: "./packages/cap/src/index.ts" },
      { find: "@duyet/oma-cap-adapter", replacement: "./packages/oma-cap-adapter/src/index.ts" },

      // ─── environment-images (irregular subpath layout) ────────────────
      { find: "@duyet/oma-environment-images/memory", replacement: "./packages/environment-images/src/adapters/memory/index.ts" },
      { find: "@duyet/oma-environment-images/cf-base-snapshot", replacement: "./packages/environment-images/src/adapters/cf-base-snapshot/index.ts" },
      { find: "@duyet/oma-environment-images/cf-dockerfile", replacement: "./packages/environment-images/src/adapters/cf-dockerfile/index.ts" },
      { find: "@duyet/oma-environment-images", replacement: "./packages/environment-images/src/index.ts" },

      // ─── observability + browser-harness (P6 / P7) ────────────────────
      { find: "@duyet/oma-observability/logger/node", replacement: "./packages/observability/src/logger/node.ts" },
      { find: "@duyet/oma-observability/logger/cf", replacement: "./packages/observability/src/logger/cf.ts" },
      { find: "@duyet/oma-observability/metrics/node", replacement: "./packages/observability/src/metrics/node.ts" },
      { find: "@duyet/oma-observability/metrics/cf", replacement: "./packages/observability/src/metrics/cf.ts" },
      { find: "@duyet/oma-observability/tracer/node", replacement: "./packages/observability/src/tracer/node.ts" },
      { find: "@duyet/oma-observability/tracer/cf", replacement: "./packages/observability/src/tracer/cf.ts" },
      { find: "@duyet/oma-observability", replacement: "./packages/observability/src/index.ts" },
      { find: "@duyet/oma-browser-harness/cf", replacement: "./packages/browser-harness/src/cf.ts" },
      { find: "@duyet/oma-browser-harness/node", replacement: "./packages/browser-harness/src/node.ts" },
      { find: "@duyet/oma-browser-harness/cdp", replacement: "./packages/browser-harness/src/cdp.ts" },
      { find: "@duyet/oma-browser-harness/disabled", replacement: "./packages/browser-harness/src/disabled.ts" },
      { find: "@duyet/oma-browser-harness/select", replacement: "./packages/browser-harness/src/select.ts" },
      { find: "@duyet/oma-browser-harness", replacement: "./packages/browser-harness/src/index.ts" },

      // ─── sandbox (subpaths) + blob-store ──────────────────────────────
      { find: "@duyet/oma-sandbox/orchestrator", replacement: "./packages/sandbox/src/orchestrator.ts" },
      { find: "@duyet/oma-sandbox/adapters/local-subprocess", replacement: "./packages/sandbox/src/adapters/local-subprocess.ts" },
      { find: "@duyet/oma-sandbox/adapters/litebox", replacement: "./packages/sandbox/src/adapters/litebox.ts" },
      { find: "@duyet/oma-sandbox/adapters/daytona", replacement: "./packages/sandbox/src/adapters/daytona.ts" },
      { find: "@duyet/oma-sandbox/adapters/e2b", replacement: "./packages/sandbox/src/adapters/e2b.ts" },
      { find: "@duyet/oma-sandbox/adapters/boxrun", replacement: "./packages/sandbox/src/adapters/boxrun.ts" },
      { find: "@duyet/oma-sandbox/adapters/kubernetes", replacement: "./packages/sandbox/src/adapters/kubernetes.ts" },
      { find: "@duyet/oma-sandbox/adapters/k8s-bridge", replacement: "./packages/sandbox/src/adapters/k8s-bridge.ts" },
      { find: "@duyet/oma-sandbox/adapters/browser-vm", replacement: "./packages/sandbox/src/adapters/browser-vm.ts" },
      { find: "@duyet/oma-sandbox/adapters/kubernetes-remote", replacement: "./packages/sandbox/src/adapters/kubernetes-remote.ts" },
      { find: "@duyet/oma-sandbox/adapters/docker-compose", replacement: "./packages/sandbox/src/adapters/docker-compose.ts" },
      { find: "@duyet/oma-sandbox/adapters/github-actions", replacement: "./packages/sandbox/src/adapters/github-actions.ts" },
      { find: "@duyet/oma-sandbox/adapters/remote-agent", replacement: "./packages/sandbox/src/adapters/remote-agent.ts" },
      { find: "@duyet/oma-sandbox/adapters/openshell-policy", replacement: "./packages/sandbox/src/adapters/openshell-policy.ts" },
      { find: "@duyet/oma-sandbox", replacement: "./packages/sandbox/src/index.ts" },
      { find: "@duyet/oma-blob-store/adapters/local-fs", replacement: "./packages/blob-store/src/adapters/local-fs.ts" },
      { find: "@duyet/oma-blob-store/adapters/s3", replacement: "./packages/blob-store/src/adapters/s3.ts" },
      { find: "@duyet/oma-blob-store/adapters/in-memory", replacement: "./packages/blob-store/src/adapters/in-memory.ts" },
      { find: "@duyet/oma-blob-store", replacement: "./packages/blob-store/src/index.ts" },

      // ─── auth / auth-config / email / kv-store / quotas / rate-limit / vault-forward / schema / http-routes / install-bridge ─
      { find: "@duyet/oma-auth", replacement: "./packages/auth/src/index.ts" },
      { find: "@duyet/oma-auth-config", replacement: "./packages/auth-config/src/index.ts" },
      { find: "@duyet/oma-email/adapters/nodemailer", replacement: "./packages/email/src/adapters/nodemailer.ts" },
      { find: "@duyet/oma-email/adapters/cf-send-email", replacement: "./packages/email/src/adapters/cf-send-email.ts" },
      { find: "@duyet/oma-email", replacement: "./packages/email/src/index.ts" },
      { find: "@duyet/oma-kv-store/adapters/sql", replacement: "./packages/kv-store/src/adapters/sql.ts" },
      { find: "@duyet/oma-kv-store/adapters/in-memory", replacement: "./packages/kv-store/src/adapters/in-memory.ts" },
      { find: "@duyet/oma-kv-store/adapters/cf", replacement: "./packages/kv-store/src/adapters/cf.ts" },
      { find: "@duyet/oma-kv-store", replacement: "./packages/kv-store/src/index.ts" },
      { find: "@duyet/oma-quotas", replacement: "./packages/quotas/src/index.ts" },
      { find: "@duyet/oma-rate-limit", replacement: "./packages/rate-limit/src/index.ts" },
      { find: "@duyet/oma-payments", replacement: "./packages/payments/src/index.ts" },
      { find: "@duyet/oma-vault-forward", replacement: "./packages/vault-forward/src/index.ts" },
      { find: "@duyet/oma-schema", replacement: "./packages/schema/src/index.ts" },
      { find: "@duyet/oma-http-routes", replacement: "./packages/http-routes/src/index.ts" },
      { find: "@duyet/oma-integrations-core/test-fakes", replacement: "./packages/integrations-core/src/test-fakes.ts" },
      { find: "@duyet/oma-integrations-core", replacement: "./packages/integrations-core/src/index.ts" },
      { find: "@duyet/oma-integrations-adapters-cf", replacement: "./packages/integrations-adapters-cf/src/index.ts" },
      { find: "@duyet/oma-integrations-adapters-node", replacement: "./packages/integrations-adapters-node/src/index.ts" },
      { find: "@duyet/oma-github/test-fakes", replacement: "./packages/github/src/test-fakes.ts" },
      { find: "@duyet/oma-github", replacement: "./packages/github/src/index.ts" },
      { find: "@duyet/oma-slack", replacement: "./packages/slack/src/index.ts" },
      { find: "@duyet/oma-matrix", replacement: "./packages/matrix/src/index.ts" },
      { find: "@duyet/oma-telegram", replacement: "./packages/telegram/src/index.ts" },

      // ─── markdown / session-runtime / acp-runtime / agent (internal) ──
      { find: "@duyet/oma-markdown/adapters/node", replacement: "./packages/markdown/src/adapters/node.ts" },
      { find: "@duyet/oma-markdown/adapters/cf-workers-ai", replacement: "./packages/markdown/src/adapters/cf-workers-ai.ts" },
      { find: "@duyet/oma-markdown", replacement: "./packages/markdown/src/index.ts" },
      { find: "@duyet/oma-session-runtime/recovery", replacement: "./packages/session-runtime/src/recovery.ts" },
      { find: "@duyet/oma-session-runtime", replacement: "./packages/session-runtime/src/index.ts" },
      { find: "@duyet/oma-acp-runtime/cf-sandbox", replacement: "./packages/acp-runtime/src/cf-sandbox.ts" },
      { find: "@duyet/oma-acp-runtime/known-agents", replacement: "./packages/acp-runtime/src/known-agents.ts" },
      { find: "@duyet/oma-acp-runtime/node-spawner", replacement: "./packages/acp-runtime/src/node-spawner.ts" },
      { find: "@duyet/oma-acp-runtime/registry", replacement: "./packages/acp-runtime/src/registry.ts" },
      { find: "@duyet/oma-acp-runtime", replacement: "./packages/acp-runtime/src/index.ts" },

      // Catch-all fallbacks for the vitest module graph (workerd needs the
      // explicit entries above; this helps node-side tests resolve any
      // newly-added subpath without a config edit).
      { find: /^@open-managed-agents\/([a-z][a-z0-9-]*)\/(.+)$/, replacement: "./packages/$1/src/$2" },
      { find: /^@open-managed-agents\/([a-z][a-z0-9-]*)$/, replacement: "./packages/$1/src/index.ts" },
    ],
  },
  test: {
    testTimeout: 30000,
    hookTimeout: 30000,
    exclude: [
      "**/node_modules/**",
      "**/.git/**",
      "**/.claude/worktrees/**",
      "**/.pnpm-store/**",
      "test/e2e/**",
      "apps/console/**",
      "apps/k8s-bridge/test/**",
      "apps/main-node/**",
      // The CLI (bridge daemon) is a plain Node process, not a Worker — it has
      // its own node-pool config (packages/cli/vitest.config.ts, pool:threads)
      // and already runs via `pnpm --filter @getoma/cli test` in
      // `test:packages`. Its bridge tests load child_process-based code that
      // SEGFAULTS workerd at pool teardown — crashing the whole run with 2
      // unhandled `_WebSocket.emitUnexpectedExit` errors even though every test
      // passes. Keep them out of the Workers pool.
      "packages/cli/**",
      "packages/browser-harness/test/**",
      "packages/cap/test/**",
      "packages/integrations-adapters-node/**",
      "packages/observability/test/**",
      "packages/session-runtime/test/**",
      "packages/vault-forward/test/**",
      // @grpc/grpc-js can't load under the Cloudflare workers pool (unlike
      // @kubernetes/client-node, which the pool tolerates) — this test only
      // runs via the sandbox package's own node-pool vitest.config.ts
      // (pnpm --filter @duyet/oma-sandbox test).
      "packages/sandbox/test/openshell-probe.test.ts",
    ],
    pool: cloudflarePool(cfWorkerOptions),
  },
});

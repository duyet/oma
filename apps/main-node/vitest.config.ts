// Vitest config local to apps/main-node.
//
// The root vitest.config.ts pins to @cloudflare/vitest-pool-workers
// (workerd). main-node tests need the Node thread pool because they
// spawn real child processes (test/crash-recovery.test.ts) and use
// better-sqlite3.
//
// Run with:
//   pnpm --filter @duyet/oma-main-node test

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "threads",
    include: ["test/**/*.test.ts"],
    // Most files spawn at most one main-node process. crash-recovery.test.ts
    // overrides to 180s (2–3 sequential tsx boots per case).
    testTimeout: 60_000,
    hookTimeout: 15_000,
    // Run sequentially so two tests don't race for the same port or
    // sqlite file.
    fileParallelism: false,
  },
});

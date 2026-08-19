#!/usr/bin/env node
/**
 * Workspace / package bin for `@duyet/oma-main-node`.
 * Runs the TypeScript entry via tsx (same as `pnpm start`).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "../src/index.ts");
const require = createRequire(import.meta.url);

function resolveTsx() {
  try {
    return require.resolve("tsx/cli");
  } catch {
    const local = join(here, "../node_modules/.bin/tsx");
    if (existsSync(local)) return local;
    return null;
  }
}

const tsx = resolveTsx();
if (!tsx) {
  console.error(
    "oma-server: tsx is not installed. From the repo root run `pnpm install`.",
  );
  process.exit(1);
}

const result = spawnSync(process.execPath, [tsx, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status === null ? 1 : result.status);

#!/usr/bin/env node
/**
 * First-time `pnpm dev` prerequisites.
 *
 * wrangler assets.directory points at `apps/console/dist` (missing until a
 * console build). wrangler also loads `.dev.vars` from the *config* directory
 * (`apps/main`, `apps/agent`), not the repo root the README documents.
 *
 * This script is the `predev` hook: build the console SPA if needed, and copy
 * the documented root `.dev.vars` next to each worker config.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const WORKER_DEV_VARS_DIRS = ["apps/main", "apps/agent"];

export function repoRootFrom(metaUrl = import.meta.url) {
  return resolve(dirname(fileURLToPath(metaUrl)), "..");
}

/**
 * Copy repo-root `.dev.vars` to each wrangler config directory.
 * Returns the source path when copied, or null when the root file is absent.
 */
export function syncDevVars(root) {
  const src = join(root, ".dev.vars");
  if (!existsSync(src)) return null;
  for (const rel of WORKER_DEV_VARS_DIRS) {
    const destDir = join(root, rel);
    mkdirSync(destDir, { recursive: true });
    copyFileSync(src, join(destDir, ".dev.vars"));
  }
  return src;
}

/**
 * Ensure `apps/console/dist/index.html` exists so wrangler assets.directory
 * does not fail on a fresh checkout. Builds via `pnpm build:console` when
 * missing. Returns `"exists"` | `"built"`.
 */
export function ensureConsoleDist(root, spawn = spawnSync) {
  const indexHtml = join(root, "apps/console/dist/index.html");
  if (existsSync(indexHtml)) return "exists";
  const result = spawn("pnpm", ["run", "build:console"], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });
  if (result.status !== 0) {
    throw new Error(
      `pnpm build:console failed (exit ${result.status ?? "null"}). ` +
        "The main worker's ASSETS binding requires apps/console/dist.",
    );
  }
  if (!existsSync(indexHtml)) {
    throw new Error(
      "pnpm build:console succeeded but apps/console/dist/index.html is still missing.",
    );
  }
  return "built";
}

export function main(root = repoRootFrom(), log = console) {
  ensureConsoleDist(root);
  const synced = syncDevVars(root);
  if (!synced) {
    log.warn(
      "No .dev.vars at the repo root. wrangler will not see PLATFORM_ROOT_SECRET.\n" +
        "  cp .dev.vars.example .dev.vars\n" +
        "  # then set PLATFORM_ROOT_SECRET=$(openssl rand -base64 32)",
    );
  }
}

const invokedDirectly =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

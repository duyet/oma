#!/usr/bin/env node
/**
 * Workspace + published bin for `@getoma/cli`.
 *
 * pnpm links bins before `prepare` runs, so pointing `package.json#bin` at
 * `dist/index.js` fails on a fresh checkout (`ENOENT`). This file is always
 * present: prefer the built bundle, fall back to tsx on `src/index.ts`.
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist/index.js");

if (existsSync(dist)) {
  await import(pathToFileURL(dist).href);
} else {
  const require = createRequire(import.meta.url);
  let tsx;
  try {
    tsx = require.resolve("tsx/cli");
  } catch {
    console.error(
      "@getoma/cli: dist/index.js is missing. From the repo run `pnpm --filter @getoma/cli build`.",
    );
    process.exit(1);
  }
  const result = spawnSync(
    process.execPath,
    [tsx, join(root, "src/index.ts"), ...process.argv.slice(2)],
    { stdio: "inherit", env: process.env },
  );
  process.exit(result.status === null ? 1 : result.status);
}

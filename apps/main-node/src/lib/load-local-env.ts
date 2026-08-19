/**
 * Load a dotenv file into process.env without overriding keys already set
 * (same rule as Node's `process.loadEnvFile` / `--env-file`).
 *
 * `pnpm --filter @duyet/oma-main-node start` runs with cwd = apps/main-node,
 * while the README documents `cp .env.example .env` at the repo root. Walk
 * cwd → package → repo so either layout works.
 */
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith("\"") && val.endsWith("\"")) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function localEnvCandidates(opts: {
  cwd?: string;
  fromFile?: string;
} = {}): string[] {
  const cwd = opts.cwd ?? process.cwd();
  const here = dirname(fileURLToPath(opts.fromFile ?? import.meta.url));
  // this file lives at apps/main-node/src/lib/
  const pkgRoot = resolve(here, "../..");
  const repoRoot = resolve(pkgRoot, "../..");
  return [
    resolve(cwd, ".env"),
    resolve(pkgRoot, ".env"),
    resolve(repoRoot, ".env"),
  ];
}

function applyParsed(
  parsed: Record<string, string>,
  env: NodeJS.ProcessEnv,
): void {
  for (const [key, value] of Object.entries(parsed)) {
    if (env[key] === undefined) env[key] = value;
  }
}

export function applyEnvFile(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (
    env === process.env &&
    typeof process.loadEnvFile === "function"
  ) {
    process.loadEnvFile(path);
    return;
  }
  applyParsed(parseDotEnv(readFileSync(path, "utf8")), env);
}

/** Load the first existing candidate files; later files fill missing keys only. */
export function loadLocalEnv(
  env: NodeJS.ProcessEnv = process.env,
  opts: { cwd?: string; fromFile?: string } = {},
): string[] {
  // Spawned unit tests (secret-guard, etc.) pass secrets via `env` and use
  // cwd=repo root. Loading a developer's `.env` would hide missing/leaked
  // values the test is asserting on. Direct calls with a custom `env` bag
  // still load files so load-env.test.ts covers the parse/merge path.
  if (env === process.env && env.NODE_ENV === "test") return [];
  const loaded: string[] = [];
  const seen = new Set<string>();
  for (const path of localEnvCandidates(opts)) {
    let real: string;
    try {
      if (!existsSync(path)) continue;
      real = realpathSync(path);
    } catch {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);
    applyEnvFile(path, env);
    loaded.push(path);
  }
  return loaded;
}

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Where to serve the Console SPA from, if anywhere.
 *
 *   - `CONSOLE_DIR` set to a directory that contains `index.html` → that path
 *   - `CONSOLE_DIR` set but missing `index.html` → not served (API-only;
 *     SKIP_CONSOLE docker builds leave an empty dist)
 *   - unset → auto-detect `apps/console/dist` relative to cwd (repo root
 *     or `apps/main-node`), so local `pnpm start` matches the README's
 *     "Console on :8787" claim after a console build
 */
export function resolveConsoleDir(
  env: { CONSOLE_DIR?: string },
  cwd: string,
): string | null {
  if (env.CONSOLE_DIR !== undefined && env.CONSOLE_DIR !== "") {
    return existsSync(join(env.CONSOLE_DIR, "index.html")) ? env.CONSOLE_DIR : null;
  }
  const candidates = [
    join(cwd, "apps/console/dist"),
    join(cwd, "../console/dist"),
    join(cwd, "console/dist"),
  ];
  for (const dir of candidates) {
    if (existsSync(join(dir, "index.html"))) return dir;
  }
  return null;
}

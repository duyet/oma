import { describe, it, expect } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  syncDevVars,
  ensureConsoleDist,
  WORKER_DEV_VARS_DIRS,
} from "../../../scripts/ensure-local-dev.mjs";

describe("ensure-local-dev", () => {
  it("copies repo-root .dev.vars next to each wrangler config", () => {
    const root = mkdtempSync(join(tmpdir(), `oma-predev-${randomBytes(3).toString("hex")}-`));
    try {
      for (const rel of WORKER_DEV_VARS_DIRS) {
        mkdirSync(join(root, rel), { recursive: true });
      }
      writeFileSync(join(root, ".dev.vars"), "PLATFORM_ROOT_SECRET=local-only\n");
      expect(syncDevVars(root)).toBe(join(root, ".dev.vars"));
      for (const rel of WORKER_DEV_VARS_DIRS) {
        expect(readFileSync(join(root, rel, ".dev.vars"), "utf8")).toContain(
          "PLATFORM_ROOT_SECRET=local-only",
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when the documented root .dev.vars is missing", () => {
    const root = mkdtempSync(join(tmpdir(), `oma-predev-${randomBytes(3).toString("hex")}-`));
    try {
      expect(syncDevVars(root)).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips the console build when dist/index.html already exists", () => {
    const root = mkdtempSync(join(tmpdir(), `oma-predev-${randomBytes(3).toString("hex")}-`));
    try {
      mkdirSync(join(root, "apps/console/dist"), { recursive: true });
      writeFileSync(join(root, "apps/console/dist/index.html"), "<html></html>");
      let spawned = 0;
      const result = ensureConsoleDist(root, () => {
        spawned += 1;
        return { status: 0 };
      });
      expect(result).toBe("exists");
      expect(spawned).toBe(0);
      expect(existsSync(join(root, "apps/console/dist/index.html"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { resolveConsoleDir } from "../src/lib/console-dir";

describe("resolveConsoleDir", () => {
  it("serves CONSOLE_DIR when index.html exists", () => {
    const dir = join(tmpdir(), `oma-console-dir-${randomBytes(4).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "index.html"), "<html></html>");
    try {
      expect(resolveConsoleDir({ CONSOLE_DIR: dir }, "/unused")).toBe(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("skips CONSOLE_DIR when index.html is missing (API-only / SKIP_CONSOLE)", () => {
    const dir = join(tmpdir(), `oma-console-empty-${randomBytes(4).toString("hex")}`);
    mkdirSync(dir, { recursive: true });
    try {
      expect(resolveConsoleDir({ CONSOLE_DIR: dir }, "/unused")).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("auto-detects apps/console/dist under cwd when CONSOLE_DIR is unset", () => {
    const cwd = join(tmpdir(), `oma-console-cwd-${randomBytes(4).toString("hex")}`);
    const dist = join(cwd, "apps/console/dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<html></html>");
    try {
      expect(resolveConsoleDir({}, cwd)).toBe(dist);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("returns null when nothing is built and CONSOLE_DIR is unset", () => {
    const cwd = join(tmpdir(), `oma-console-none-${randomBytes(4).toString("hex")}`);
    mkdirSync(cwd, { recursive: true });
    try {
      expect(resolveConsoleDir({}, cwd)).toBeNull();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

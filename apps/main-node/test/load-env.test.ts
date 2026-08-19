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
import { pathToFileURL } from "node:url";
import {
  parseDotEnv,
  applyEnvFile,
  loadLocalEnv,
  localEnvCandidates,
} from "../src/lib/load-local-env";

describe("parseDotEnv", () => {
  it("parses KEY=value, comments, and quoted strings", () => {
    const parsed = parseDotEnv(
      [
        "# comment",
        "FOO=bar",
        "QUOTED=\"hello world\"",
        "SINGLE='x'",
        "EMPTY=",
        "",
        "SPACED = spaced ",
      ].join("\n"),
    );
    expect(parsed.FOO).toBe("bar");
    expect(parsed.QUOTED).toBe("hello world");
    expect(parsed.SINGLE).toBe("x");
    expect(parsed.EMPTY).toBe("");
    expect(parsed.SPACED).toBe("spaced");
  });
});

describe("applyEnvFile", () => {
  it("fills missing keys and does not override existing ones", () => {
    const dir = mkdtempSync(join(tmpdir(), `oma-env-${randomBytes(3).toString("hex")}-`));
    try {
      const path = join(dir, ".env");
      writeFileSync(path, "KEEP=from-file\nOVERRIDE=from-file\n");
      const env: NodeJS.ProcessEnv = { OVERRIDE: "already-set" };
      applyEnvFile(path, env);
      expect(env.KEEP).toBe("from-file");
      expect(env.OVERRIDE).toBe("already-set");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadLocalEnv", () => {
  it("loads repo-root .env when cwd is the package directory", () => {
    const root = mkdtempSync(join(tmpdir(), `oma-env-root-${randomBytes(3).toString("hex")}-`));
    try {
      const pkg = join(root, "apps/main-node");
      const lib = join(pkg, "src/lib");
      mkdirSync(lib, { recursive: true });
      writeFileSync(join(root, ".env"), "PLATFORM_ROOT_SECRET=from-repo-root\n");
      const fakeModule = pathToFileURL(join(lib, "load-local-env.ts")).href;
      writeFileSync(join(lib, "load-local-env.ts"), "");
      const env: NodeJS.ProcessEnv = {};
      const loaded = loadLocalEnv(env, { cwd: pkg, fromFile: fakeModule });
      expect(loaded.some((p) => p.endsWith(".env"))).toBe(true);
      expect(env.PLATFORM_ROOT_SECRET).toBe("from-repo-root");
      expect(localEnvCandidates({ cwd: pkg, fromFile: fakeModule })).toContain(
        join(root, ".env"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips dotenv files when applying to process.env under NODE_ENV=test", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    try {
      expect(loadLocalEnv()).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prev;
    }
  });
});

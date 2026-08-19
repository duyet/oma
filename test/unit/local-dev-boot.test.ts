import { describe, it, expect } from "vitest";
import { parse as parseJsonc } from "jsonc-parser";
// @ts-expect-error ?raw is a Vite string import, no type decl
import mainDevRaw from "../../apps/main/wrangler.dev.jsonc?raw";
// @ts-expect-error ?raw is a Vite string import, no type decl
import agentDevRaw from "../../apps/agent/wrangler.dev.jsonc?raw";
import rootPkg from "../../package.json";
import cliPkg from "../../packages/cli/package.json";
import mainNodePkg from "../../apps/main-node/package.json";
// @ts-expect-error ?raw is a Vite string import, no type decl
import sandboxDockerfile from "../../apps/agent/Dockerfile.sandbox?raw";
// @ts-expect-error ?raw is a Vite string import, no type decl
import omaServerBin from "../../apps/main-node/bin/oma-server.js?raw";
// @ts-expect-error ?raw is a Vite string import, no type decl
import omaCliBin from "../../packages/cli/bin/oma.js?raw";

interface WranglerDevConfig {
  ai?: unknown;
  browser?: unknown;
  worker_loaders?: unknown;
  containers?: Array<{ image?: string }>;
  assets?: { directory?: string };
  dev?: { enable_containers?: boolean };
}

const mainDev = parseJsonc(mainDevRaw) as WranglerDevConfig;
const agentDev = parseJsonc(agentDevRaw) as WranglerDevConfig;

describe("first-time local boot contracts", () => {
  it("pnpm dev builds console and uses local wrangler configs without a CF account", () => {
    expect(rootPkg.scripts.predev).toBe("node scripts/ensure-local-dev.mjs");
    expect(rootPkg.scripts.dev).toContain("--local");
    expect(rootPkg.scripts.dev).toContain("apps/main/wrangler.dev.jsonc");
    expect(rootPkg.scripts.dev).toContain("apps/agent/wrangler.dev.jsonc");
    expect(rootPkg.scripts["dev:main"]).toContain("apps/main/wrangler.dev.jsonc");
    expect(rootPkg.scripts["dev:agent"]).toContain("apps/agent/wrangler.dev.jsonc");
  });

  it("local main wrangler config has no always-remote AI binding", () => {
    expect(mainDev.ai).toBeUndefined();
    expect(mainDev.browser).toBeUndefined();
    expect(mainDev.worker_loaders).toBeUndefined();
    expect(mainDev.assets?.directory).toBe("../console/dist");
    expect(mainDev.dev?.enable_containers).toBe(false);
  });

  it("local agent wrangler config skips Docker and points at a repo Dockerfile", () => {
    expect(agentDev.browser).toBeUndefined();
    expect(agentDev.ai).toBeUndefined();
    expect(agentDev.dev?.enable_containers).toBe(false);
    expect(agentDev.containers?.[0]?.image).toBe("./Dockerfile.sandbox");
    expect(sandboxDockerfile).toMatch(/^FROM /m);
  });

  it("workspace CLI builds on install so pnpm exec oma has a bin", () => {
    expect(cliPkg.bin.oma).toBe("./bin/oma.js");
    expect(cliPkg.scripts.prepare).toMatch(/build/);
    expect(cliPkg.files).toContain("bin");
    expect(omaCliBin).toContain("dist/index.js");
  });

  it("main-node ships an oma-server bin and start script", () => {
    expect(mainNodePkg.bin["oma-server"]).toBe("./bin/oma-server.js");
    expect(mainNodePkg.scripts.start).toMatch(/tsx src\/index\.ts/);
    expect(omaServerBin).toContain("src/index.ts");
  });
});

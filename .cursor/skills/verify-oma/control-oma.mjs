#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const skillRoot = here;
const repoRoot = resolve(process.env.OMA_ROOT || join(here, "../../.."));
const runDir = join(skillRoot, ".run");
const statePath = join(runDir, "state.json");
const artifactsRoot = join(skillRoot, "artifacts");
const cursorArtifacts = "/opt/cursor/artifacts";
const chromePath =
  process.env.CHROME_PATH ||
  ["/usr/bin/google-chrome", "/usr/local/bin/google-chrome"].find((p) =>
    existsSync(p),
  );
const SURFACES = {
  web: {
    cwd: join(repoRoot, "apps/web"),
    defaultPort: 4321,
    readyPath: "/",
    args: (port) => [
      "exec",
      "astro",
      "dev",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
    ],
  },
  console: {
    cwd: join(repoRoot, "apps/console"),
    defaultPort: 5173,
    readyPath: "/login",
    args: (port) => [
      "exec",
      "vite",
      "--host",
      "127.0.0.1",
      "--port",
      String(port),
      "--strictPort",
    ],
  },
};

const CN_CASES = [
  { name: "last-padding-wins", args: ["p-2", "p-4"], want: "p-4" },
  { name: "last-text-wins", args: ["text-sm", "text-lg"], want: "text-lg" },
  { name: "falsy-skip", args: ["flex", false && "hidden", "gap-2"], want: "flex gap-2" },
  { name: "object-conditional", args: [{ flex: true, hidden: false, "items-center": true }], want: "flex items-center" },
  { name: "array-nested", args: [["px-2", "py-1"], "px-4"], want: "py-1 px-4" },
];

function die(msg, code = 1) {
  console.error(msg);
  process.exit(code);
}

function readState() {
  if (!existsSync(statePath)) return null;
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function writeState(state) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function runId() {
  return (
    process.env.OMA_VERIFY_RUN ||
    new Date().toISOString().replace(/[:.]/g, "-")
  );
}

function originOf(state) {
  return `http://127.0.0.1:${state.port}`;
}

async function waitForHttp(url, { timeoutMs = 60_000, test } = {}) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: "follow" });
      const body = await res.text();
      last = `HTTP ${res.status} (${body.length} bytes)`;
      if (res.ok && (!test || test(res, body))) return { res, body };
    } catch (err) {
      last = String(err.message || err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timeout waiting for ${url}: ${last}`);
}

async function cmdLaunch(argv) {
  const surface = argv[0];
  if (!SURFACES[surface]) die("usage: launch <web|console> [--port N]");
  const spec = SURFACES[surface];
  let port = spec.defaultPort;
  const portIdx = argv.indexOf("--port");
  if (portIdx >= 0) port = Number(argv[portIdx + 1]);
  if (!Number.isInteger(port) || port < 1) die("invalid --port");

  const existing = readState();
  if (existing && pidAlive(existing.pid)) {
    die(
      `already launched pid ${existing.pid} ${existing.surface} on :${existing.port}; run cleanup first`,
    );
  }

  mkdirSync(runDir, { recursive: true });
  const logPath = join(runDir, `${surface}.log`);
  const logFd = openSync(logPath, "w");
  const child = spawn("pnpm", spec.args(port), {
    cwd: spec.cwd,
    env: { ...process.env, FORCE_COLOR: "0" },
    stdio: ["ignore", logFd, logFd],
    detached: true,
  });
  child.unref();
  const id = runId();
  const state = {
    surface,
    pid: child.pid,
    port,
    url: `http://127.0.0.1:${port}`,
    readyPath: spec.readyPath,
    runId: id,
    logPath,
    startedAt: new Date().toISOString(),
  };
  writeState(state);

  const url = originOf(state) + spec.readyPath;
  try {
    await waitForHttp(url, {
      test: (_res, body) =>
        surface === "web" ? /Open Managed Agents/i.test(body) : /<!doctype html/i.test(body),
    });
  } catch (err) {
    console.error(err.message);
    await cmdCleanup([]);
    die("launch failed");
  }
  console.log(JSON.stringify({ ok: true, ...state }, null, 2));
}

async function cmdDoctor() {
  const state = readState();
  if (!state) die("doctor: no state.json (launch first)");
  const alive = pidAlive(state.pid);
  const url = originOf(state) + (state.readyPath || "/");
  let http = null;
  let body = "";
  try {
    const got = await fetch(url, { redirect: "follow" });
    body = await got.text();
    http = got.status;
  } catch (err) {
    http = String(err.message || err);
  }
  const identity =
    state.surface === "web"
      ? /Open Managed Agents/i.test(body)
      : /<!doctype html/i.test(body);
  const ok = alive && http === 200 && identity;
  const report = {
    ok,
    pid: state.pid,
    alive,
    surface: state.surface,
    port: state.port,
    url,
    http,
    identity,
  };
  console.log(JSON.stringify(report, null, 2));
  if (!ok) die("doctor: instance is not worth driving");
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      out[argv[i].slice(2)] = argv[i + 1];
      i++;
    }
  }
  return out;
}

async function withPage(fn, viewport = { width: 1280, height: 800 }) {
  if (!chromePath) die("CHROME_PATH / google-chrome not found");
  let chromium;
  try {
    const fromRoot = createRequire(join(repoRoot, "package.json"));
    const fromTest = createRequire(fromRoot.resolve("@playwright/test"));
    try {
      ({ chromium } = fromTest("playwright"));
    } catch {
      ({ chromium } = fromTest("playwright-core"));
    }
  } catch (err) {
    die(`playwright is not installed; pnpm install at repo root (${err.message})`);
  }
  const browser = await chromium.launch({
    executablePath: chromePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--headless=new"],
  });
  const page = await browser.newPage({ viewport });
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

function evidenceDir(featureId) {
  const state = readState();
  const id = state?.runId || runId();
  const dir = join(artifactsRoot, id, featureId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function publishArtifact(src) {
  if (!existsSync(cursorArtifacts)) return;
  mkdirSync(cursorArtifacts, { recursive: true });
  const dest = join(cursorArtifacts, src.split("/").slice(-2).join("-"));
  try {
    copyFileSync(src, dest);
  } catch {
    /* optional */
  }
}

async function writeProof(page, dir, extra) {
  const after = join(dir, extra.afterName || "after.png");
  const ariaPath = join(dir, "aria.yml");
  await page.screenshot({ path: after, fullPage: false });
  let aria = "";
  if (typeof page.locator("body").ariaSnapshot === "function") {
    aria = await page.locator("body").ariaSnapshot();
  } else {
    aria = await page.locator("body").innerText();
  }
  writeFileSync(ariaPath, aria + "\n");
  publishArtifact(after);
  publishArtifact(ariaPath);
  return { after, ariaPath };
}

function writeReport(dir, report) {
  const path = join(dir, "report.json");
  writeFileSync(path, JSON.stringify(report, null, 2) + "\n");
  publishArtifact(path);
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) die(`drive ${report.feature} failed`);
}

async function driveLandingHome(page, dir, state) {
  const url = originOf(state) + "/";
  await page.goto(url, { waitUntil: "networkidle" });
  const before = join(dir, "before.png");
  await page.screenshot({ path: before, fullPage: false });
  publishArtifact(before);
  const heading =
    "The self-hosted agent platform for any LLM provider and any sandbox";
  const assertions = [];
  const h1 = page.getByRole("heading", { name: heading });
  assertions.push({ id: "home-load", ok: await h1.isVisible(), detail: heading });
  const home = page.locator('a[aria-label="Open Managed Agents — home"]').first();
  assertions.push({
    id: "home-identity",
    ok: await home.isVisible(),
    detail: "home link",
  });
  const hosted = page.getByRole("link", { name: /Try hosted/i }).first();
  assertions.push({ id: "home-cta", ok: await hosted.isVisible(), detail: "Try hosted" });
  const nav = page.locator('nav[aria-label="Primary"]');
  assertions.push({ id: "home-nav", ok: await nav.isVisible(), detail: "Primary nav" });
  await writeProof(page, dir, {});
  return {
    feature: "landing-home",
    url: page.url(),
    assertions,
    ok: assertions.every((a) => a.ok),
  };
}

async function driveLandingFeatures(page, dir, state) {
  const url = originOf(state) + "/";
  await page.goto(url, { waitUntil: "networkidle" });
  const explore = page.locator('a[href="/features/"]').filter({ hasText: "Features" }).last();
  await explore.scrollIntoViewIfNeeded();
  const before = join(dir, "before.png");
  await page.screenshot({ path: before, fullPage: false });
  publishArtifact(before);
  await explore.click();
  await page.waitForURL(/\/features\/?$/);
  const heading = page.getByRole("heading", {
    name: "Everything you need to run agent fleets",
  });
  const assertions = [
    {
      id: "features-open",
      ok: /\/features\/?$/.test(new URL(page.url()).pathname),
      detail: page.url(),
    },
    {
      id: "features-heading",
      ok: await heading.isVisible(),
      detail: "Everything you need to run agent fleets",
    },
    {
      id: "features-why",
      ok: await page.getByText("Drop-in compatible").first().isVisible(),
      detail: "Drop-in compatible",
    },
  ];
  await writeProof(page, dir, {});
  return {
    feature: "landing-features",
    url: page.url(),
    assertions,
    ok: assertions.every((a) => a.ok),
  };
}

async function driveConsoleLogin(page, dir, state) {
  const origin = originOf(state);
  await page.goto(origin + "/login", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Welcome back" }).waitFor({ timeout: 30_000 });
  const before = join(dir, "before.png");
  await page.screenshot({ path: before, fullPage: false });
  publishArtifact(before);
  const assertions = [
    {
      id: "login-load",
      ok: await page.getByRole("heading", { name: "Welcome back" }).isVisible(),
      detail: "Welcome back",
    },
    {
      id: "login-email",
      ok: await page.locator("#auth-email").isVisible(),
      detail: "#auth-email",
    },
    {
      id: "login-submit",
      ok: await page.getByRole("button", { name: "Sign in" }).first().isVisible(),
      detail: "Sign in",
    },
  ];
  await writeProof(page, dir, {});
  await page.goto(origin + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const gated = page.url().includes("/login");
  assertions.push({ id: "login-gate", ok: gated, detail: page.url() });
  return {
    feature: "console-login",
    url: page.url(),
    assertions,
    ok: assertions.every((a) => a.ok),
  };
}

async function driveConsoleAgents(page, dir, state) {
  const origin = originOf(state);
  await page.goto(origin + "/agents", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const before = join(dir, "before.png");
  await page.screenshot({ path: before, fullPage: false });
  publishArtifact(before);
  const onLogin = page.url().includes("/login");
  const assertions = [
    {
      id: "agents-gate",
      ok: onLogin,
      detail: onLogin
        ? "signed-out /agents redirected to /login"
        : "session present; list path not skipped",
    },
  ];
  if (onLogin) {
    assertions.push({
      id: "agents-list",
      ok: true,
      skipped: true,
      detail: "skipped: no session",
    });
    assertions.push({
      id: "agents-empty",
      ok: true,
      skipped: true,
      detail: "skipped: no session",
    });
  } else {
    const heading = page.getByRole("heading", { name: /Agents/i }).first();
    assertions.push({
      id: "agents-list",
      ok: await heading.isVisible().catch(() => false),
      detail: "Agents heading",
    });
  }
  await writeProof(page, dir, {});
  const skipped = assertions.filter((a) => a.skipped).map((a) => a.id);
  return {
    feature: "console-agents",
    url: page.url(),
    assertions,
    skipped,
    ok: assertions.every((a) => a.ok),
  };
}

async function driveConsoleLoginMobile(page, dir, state) {
  const origin = originOf(state);
  await page.goto(origin + "/login", { waitUntil: "networkidle" });
  await page.getByRole("heading", { name: "Welcome back" }).waitFor({ timeout: 30_000 });
  const before = join(dir, "before.png");
  await page.screenshot({ path: before, fullPage: false });
  publishArtifact(before);
  const heading = page.getByRole("heading", { name: "Welcome back" });
  const box = await heading.boundingBox();
  const assertions = [
    {
      id: "login-load",
      ok: await heading.isVisible(),
      detail: "Welcome back",
    },
    {
      id: "login-email",
      ok: await page.locator("#auth-email").isVisible(),
      detail: "#auth-email",
    },
    {
      id: "login-submit",
      ok: await page.getByRole("button", { name: "Sign in" }).first().isVisible(),
      detail: "Sign in",
    },
    {
      id: "login-fits-viewport",
      ok: !!box && box.x >= 0 && box.x + box.width <= 390,
      detail: box ? JSON.stringify(box) : "no bounding box",
    },
  ];
  await writeProof(page, dir, {});
  await page.goto(origin + "/", { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  const gated = page.url().includes("/login");
  assertions.push({ id: "login-gate", ok: gated, detail: page.url() });
  return {
    feature: "console-login-mobile",
    url: page.url(),
    assertions,
    ok: assertions.every((a) => a.ok),
  };
}

async function driveConsoleAnalytics(page, dir, state) {
  const origin = originOf(state);
  await page.goto(origin + "/analytics", { waitUntil: "networkidle" });
  await page.waitForTimeout(800);
  const before = join(dir, "before.png");
  await page.screenshot({ path: before, fullPage: false });
  publishArtifact(before);
  const onLogin = page.url().includes("/login");
  const assertions = [
    {
      id: "analytics-gate",
      ok: onLogin,
      detail: onLogin
        ? "signed-out /analytics redirected to /login"
        : "session present; charts path not skipped",
    },
  ];
  if (onLogin) {
    const welcome = page.getByRole("heading", { name: "Welcome back" });
    await welcome.waitFor({ timeout: 30_000 }).catch(() => {});
    assertions.push({
      id: "analytics-login",
      ok: await welcome.isVisible().catch(() => false),
      detail: "Welcome back",
    });
    assertions.push({
      id: "analytics-charts",
      ok: true,
      skipped: true,
      detail: "skipped: no session",
    });
    assertions.push({
      id: "analytics-empty",
      ok: true,
      skipped: true,
      detail: "skipped: no session",
    });
  } else {
    const heading = page.getByRole("heading", { name: "Analytics" }).first();
    assertions.push({
      id: "analytics-charts",
      ok: await heading.isVisible().catch(() => false),
      detail: "Analytics heading",
    });
  }
  await writeProof(page, dir, {});
  const skipped = assertions.filter((a) => a.skipped).map((a) => a.id);
  return {
    feature: "console-analytics",
    url: page.url(),
    assertions,
    skipped,
    ok: assertions.every((a) => a.ok),
  };
}

const DRIVES = {
  "landing-home": driveLandingHome,
  "landing-features": driveLandingFeatures,
  "console-login": driveConsoleLogin,
  "console-login-mobile": driveConsoleLoginMobile,
  "console-agents": driveConsoleAgents,
  "console-analytics": driveConsoleAnalytics,
};

const DRIVE_VIEWPORTS = {
  "console-login-mobile": { width: 390, height: 844 },
};

async function cmdDrive(argv) {
  const feature = argv[0];
  if (!DRIVES[feature]) die(`usage: drive <${Object.keys(DRIVES).join("|")}>`);
  await cmdDoctor();
  const state = readState();
  const dir = evidenceDir(feature);
  const viewport = DRIVE_VIEWPORTS[feature] || { width: 1280, height: 800 };
  const report = await withPage((page) => DRIVES[feature](page, dir, state), viewport);
  report.artifacts = dir;
  report.at = new Date().toISOString();
  writeReport(dir, report);
}

async function cmdScreenshot(argv) {
  const args = parseArgs(argv);
  await cmdDoctor();
  const state = readState();
  const route = args.path || "/";
  const dir = evidenceDir("screenshot");
  const out = join(dir, args.out || "shot.png");
  await withPage(async (page) => {
    await page.goto(originOf(state) + route, { waitUntil: "networkidle" });
    await page.screenshot({ path: out, fullPage: false });
  });
  publishArtifact(out);
  console.log(JSON.stringify({ ok: true, path: out }));
}

async function cmdAssert(argv) {
  const args = parseArgs(argv);
  if (!args.heading) die("usage: assert --path <route> --heading <text>");
  await cmdDoctor();
  const state = readState();
  const route = args.path || "/";
  await withPage(async (page) => {
    await page.goto(originOf(state) + route, { waitUntil: "networkidle" });
    const visible = await page.getByRole("heading", { name: args.heading }).isVisible();
    if (!visible) die(`heading not visible: ${args.heading}`);
  });
  console.log(JSON.stringify({ ok: true, heading: args.heading }));
}

async function cmdLandingCheck() {
  await cmdDoctor();
  const state = readState();
  if (state.surface !== "web") die("landing-check requires surface web");
  const script = join(repoRoot, "apps/web/scripts/verify-landing.mjs");
  const result = spawnSync(process.execPath, [script], {
    cwd: join(repoRoot, "apps/web"),
    env: { ...process.env, LANDING_URL: originOf(state) },
    stdio: "inherit",
  });
  if (result.status !== 0) die("landing-check failed");
}

function pinFile() {
  mkdirSync(artifactsRoot, { recursive: true });
  return join(artifactsRoot, "cn-pin.json");
}

async function evalCn(appDir) {
  const utils = join(appDir, "src/lib/utils.ts");
  if (!existsSync(utils)) die(`missing ${utils}`);
  const probe = `
import { cn } from ${JSON.stringify(pathToFileURL(utils).href)};
const cases = ${JSON.stringify(CN_CASES)};
const results = cases.map((c) => ({ name: c.name, args: c.args, output: cn(...c.args), want: c.want }));
process.stdout.write(JSON.stringify(results));
`;
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", "--input-type=module"],
    {
      cwd: appDir,
      env: process.env,
      input: probe,
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    die(`pin-cn eval failed in ${appDir}:\n${result.stderr || result.stdout}`);
  }
  return JSON.parse(result.stdout);
}

async function cmdPinCn(argv) {
  const mode = argv[0];
  if (mode !== "capture" && mode !== "check") die("usage: pin-cn capture|check");
  const apps = {
    web: join(repoRoot, "apps/web"),
    console: join(repoRoot, "apps/console"),
  };
  const snapshot = {
    at: new Date().toISOString(),
    apps: {},
  };
  for (const [name, dir] of Object.entries(apps)) {
    snapshot.apps[name] = await evalCn(dir);
  }
  const dest = pinFile();
  if (mode === "capture") {
    writeFileSync(dest, JSON.stringify(snapshot, null, 2) + "\n");
    publishArtifact(dest);
    const mismatches = [];
    for (const [app, rows] of Object.entries(snapshot.apps)) {
      for (const row of rows) {
        if (row.want && row.output !== row.want) {
          mismatches.push({ app, ...row });
        }
      }
    }
    console.log(JSON.stringify({ ok: mismatches.length === 0, path: dest, mismatches }, null, 2));
    if (mismatches.length) die("pin-cn capture: fixture want mismatch");
    return;
  }
  if (!existsSync(dest)) die(`pin-cn check: missing ${dest} (capture first)`);
  const prev = JSON.parse(readFileSync(dest, "utf8"));
  const diffs = [];
  for (const app of Object.keys(apps)) {
    const before = prev.apps[app] || [];
    const after = snapshot.apps[app];
    for (let i = 0; i < after.length; i++) {
      if (before[i]?.output !== after[i].output) {
        diffs.push({
          app,
          name: after[i].name,
          before: before[i]?.output,
          after: after[i].output,
        });
      }
    }
  }
  const checkPath = dest.replace(/\.json$/, ".check.json");
  writeFileSync(
    checkPath,
    JSON.stringify({ ok: diffs.length === 0, diffs, after: snapshot }, null, 2) + "\n",
  );
  publishArtifact(checkPath);
  console.log(JSON.stringify({ ok: diffs.length === 0, diffs, path: checkPath }, null, 2));
  if (diffs.length) die("pin-cn check: merge output changed");
}

function cmdStatus() {
  const state = readState();
  if (!state) die("no state");
  console.log(JSON.stringify({ ...state, alive: pidAlive(state.pid) }, null, 2));
}

async function cmdCleanup() {
  const state = readState();
  if (!state) {
    console.log(JSON.stringify({ ok: true, skipped: "no state" }));
    return;
  }
  if (pidAlive(state.pid)) {
    try {
      process.kill(-state.pid, "SIGTERM");
    } catch {
      try {
        process.kill(state.pid, "SIGTERM");
      } catch {
        /* already gone */
      }
    }
    const start = Date.now();
    while (pidAlive(state.pid) && Date.now() - start < 5000) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (pidAlive(state.pid)) {
      try {
        process.kill(-state.pid, "SIGKILL");
      } catch {
        try {
          process.kill(state.pid, "SIGKILL");
        } catch {
          /* gone */
        }
      }
    }
  }
  rmSync(statePath, { force: true });
  console.log(
    JSON.stringify({
      ok: true,
      stopped: state.pid,
      evidence: artifactsRoot,
    }),
  );
}

const commands = {
  launch: cmdLaunch,
  doctor: cmdDoctor,
  drive: cmdDrive,
  screenshot: cmdScreenshot,
  assert: cmdAssert,
  "landing-check": cmdLandingCheck,
  "pin-cn": cmdPinCn,
  status: cmdStatus,
  cleanup: cmdCleanup,
};

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd || !commands[cmd]) {
  die(
    `usage: control-oma.mjs <${Object.keys(commands).join("|")}>`,
  );
}

await commands[cmd](rest);

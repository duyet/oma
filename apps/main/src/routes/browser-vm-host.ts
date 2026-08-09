/**
 * Browser-VM sandbox host page — the browser-tab twin of `oma bridge daemon`.
 *
 * GET /sandbox-tab serves a self-contained, dependency-free page (same
 * pattern as the publications widget.js) that:
 *
 *   1. registers this tab as a runtime — swaps a one-time pairing code
 *      (`?code=…&state=…`, minted by the Console) at
 *      POST /agents/runtime/exchange with `kind: "browser-vm"`, and persists
 *      the runtime token in localStorage so reloads reuse the registration
 *      (the exchange is idempotent per machine_id);
 *   2. opens the RuntimeRoom WebSocket (/agents/runtime/_attach — the token
 *      rides `?access_token=` because a browser WebSocket cannot set an
 *      Authorization header), sends `hello`, and heartbeats every ~25s so
 *      `pickOnlineRuntimeId(db, tenant, "browser-vm")` sees it online;
 *   3. services `sandbox.op` frames (exec / readFile / writeFile /
 *      setEnvVars / destroy) against an in-tab VM engine and replies
 *      `sandbox.result` — the exact frame shapes BrowserVmSandbox
 *      (packages/sandbox-sdk/src/adapters/browser-vm.ts) awaits;
 *   4. mirrors `/workspace` writes into OPFS so a tab reload restores state.
 *
 * Engine model: bring-your-own. v86 (BSD-2) is the open default — the page
 * dynamically loads `libv86.js` and boots an operator-supplied Linux image
 * (`?image=` / `?lib=`), then drives the VM over its serial console with
 * sentinel markers + base64 framing. Proprietary engines (WebContainers,
 * CheerpX) can be slotted in behind the same `Engine` interface by an
 * operator holding a license; the platform bundles nothing proprietary.
 *
 * COOP/COEP: v86 (and every SharedArrayBuffer-using engine) requires the
 * page to be cross-origin isolated, so this route sets
 * Cross-Origin-Opener-Policy: same-origin and
 * Cross-Origin-Embedder-Policy: require-corp. Embedded engine assets must be
 * CORS-loaded (the page uses `crossorigin` fetches) or CORP-tagged.
 *
 * Security: the page itself is public (outside /v1, no authMiddleware) but
 * inert without a valid one-time pairing code or a previously stored runtime
 * token — the same trust model as the CLI daemon's loopback pairing.
 *
 * Design doc: docs/browser-vm-sandbox.md.
 */

import { Hono } from "hono";
import type { Env } from "@duyet/oma-shared";

const browserVmHostRoutes = new Hono<{ Bindings: Env }>();

/**
 * Hosts allowed for the same-origin asset proxy. COEP require-corp blocks
 * cross-origin assets that lack CORP even when CORS ACAO is `*`; i.copy.sh
 * (v86's public buildroot images) is in that boat. The host page therefore
 * loads default images through this proxy so they are same-origin.
 */
const ASSET_PROXY_HOSTS = new Set([
  "i.copy.sh",
  "cdn.jsdelivr.net",
]);

browserVmHostRoutes.get("/", (c) => {
  return c.html(HOST_PAGE_HTML, 200, {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cache-Control": "no-store",
  });
});

// GET /sandbox-tab/asset?url=https://… — stream an allowlisted remote asset
// with same-origin CORP so COEP pages can load v86 images that the upstream
// CDN serves without Cross-Origin-Resource-Policy.
browserVmHostRoutes.get("/asset", async (c) => {
  const raw = c.req.query("url");
  if (!raw) return c.text("missing url", 400);
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return c.text("invalid url", 400);
  }
  if (target.protocol !== "https:") return c.text("https only", 400);
  if (!ASSET_PROXY_HOSTS.has(target.hostname)) {
    return c.text("host not allowlisted", 403);
  }
  // Range requests are not needed for v86's full-file load path; keep this
  // simple and stream the body through so large bzimages stay under Worker
  // memory limits.
  let upstream: Response;
  try {
    upstream = await fetch(target.toString(), {
      headers: { Accept: "application/octet-stream,*/*" },
    });
  } catch (e) {
    return c.text(
      "upstream fetch failed: " + (e instanceof Error ? e.message : String(e)),
      502,
    );
  }
  if (!upstream.ok || !upstream.body) {
    return c.text("upstream " + upstream.status, 502);
  }
  const headers = new Headers();
  headers.set(
    "content-type",
    upstream.headers.get("content-type") || "application/octet-stream",
  );
  const len = upstream.headers.get("content-length");
  if (len) headers.set("content-length", len);
  headers.set("cache-control", "public, max-age=86400, immutable");
  headers.set("cross-origin-resource-policy", "same-origin");
  // Expose length so the page's HEAD/size probe can read it when the asset
  // is fetched same-origin from the diagnostics panel.
  headers.set("access-control-expose-headers", "content-length");
  return new Response(upstream.body, { status: 200, headers });
});

export default browserVmHostRoutes;

/** Pure helper exported for unit tests (mirrors the page-side classifier). */
export function classifyV86Media(url: string): "bzimage" | "iso" | "state" | "hda" | "unknown" {
  const u = String(url || "").toLowerCase();
  // Compressed v86 save states are almost always `.bin.zst`.
  if (/\.bin\.zst$/i.test(u)) return "state";
  // Explicit state markers before generic .bin (which is usually a kernel).
  if (/(?:^|[/_-])(?:v86)?state(?:[/_.-]|$)/i.test(u) || /initial[_-]?state/i.test(u)) {
    return "state";
  }
  // Kernel bzImage — serial.html boots these with console on serial0.
  if (
    /bzimage/i.test(u) ||
    /vmlinu[xz]/i.test(u) ||
    /\/kernel(?:\.bin)?(?:$|[?#])/i.test(u)
  ) {
    return "bzimage";
  }
  if (/\.iso(?:\.gz)?(?:$|[?#])/i.test(u)) return "iso";
  if (/\.(?:img|raw|qcow2|vhd|vmdk)(?:\.gz)?(?:$|[?#])/i.test(u)) return "hda";
  // Bare `.bin` is ambiguous; for browser-vm we treat it as a kernel (the
  // historical bug was treating every .bin as initial_state and never
  // reaching a shell). Operators with a real state file should name it
  // `*.bin.zst` or put `state` in the path.
  if (/\.bin(?:$|[?#])/i.test(u)) return "bzimage";
  return "unknown";
}

/** True when a saved engine config still points at the pre-fix broken default. */
export function isLegacyDefaultImage(url: string): boolean {
  const u = String(url || "");
  return /cdn\.jsdelivr\.net\/gh\/copy\/images@[^/]+\/linux\.iso/i.test(u)
    || /copy\/images.*\/linux\.iso/i.test(u);
}

/** Build a same-origin proxy URL for an allowlisted remote asset. */
export function proxiedAssetUrl(absoluteUrl: string): string {
  return "/sandbox-tab/asset?url=" + encodeURIComponent(absoluteUrl);
}

// ── The page ────────────────────────────────────────────────────────────
//
// Deliberately a single inline document: no bundler step exists for
// apps/main assets (widget.js precedent), and inlining keeps COEP simple —
// only the optional engine library is fetched cross-origin.

const HOST_PAGE_HTML = /* html */ `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>OMA Browser Sandbox</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #ffffff; --fg: #1c1917; --muted: #78716c; --card: #ffffff;
    --line: #e7e5e4; --ok: #16a34a; --warn: #d97706; --err: #dc2626;
    --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    /* Amber-primary / neutral shadcn tokens (apps/web preset). */
    --mon-primary: oklch(0.555 0.163 48.998);
    --mon-primary-fg: oklch(0.987 0.022 95.277);
    --accent: var(--mon-primary);
    --mon-mono: "JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --mon-radius: 10px;
    --mon-radius-sm: 6px;
    --mon-track: color-mix(in oklch, var(--fg) 8%, transparent);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #0c0a09; --fg: #e7e5e4; --muted: #a8a29e; --card: #1c1917; --line: #292524;
      --mon-primary: oklch(0.769 0.188 70.08);
      --mon-primary-fg: oklch(0.279 0.077 45.635);
    }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg);
    font: 15px/1.5 system-ui, -apple-system, sans-serif; }
  main { max-width: 720px; margin: 0 auto; padding: 40px 20px; }
  main.wide { max-width: 980px; }
  h1 { font-size: 20px; margin: 0 0 4px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 13px; margin-bottom: 24px; }
  .card { background: var(--card); border: 1px solid var(--line);
    border-radius: 10px; padding: 16px 18px; margin-bottom: 14px; }
  .row { display: flex; align-items: center; gap: 10px; padding: 6px 0; }
  .row .k { width: 130px; color: var(--muted); font-size: 13px; flex-shrink: 0; }
  .row .v { font-family: var(--mono); font-size: 13px; word-break: break-all; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted);
    flex-shrink: 0; }
  .dot.ok { background: var(--ok); } .dot.warn { background: var(--warn); }
  .dot.err { background: var(--err); }
  #log { font-family: var(--mono); font-size: 12px; line-height: 1.7;
    max-height: 300px; overflow-y: auto; white-space: pre-wrap;
    word-break: break-all; color: var(--muted); }
  #log .op { color: var(--accent); }
  #log .err { color: var(--err); }
  .warnbox { border-left: 3px solid var(--warn); padding: 8px 12px;
    font-size: 13px; color: var(--muted); background: color-mix(in srgb, var(--warn) 6%, transparent); border-radius: 0 8px 8px 0; }
  code { font-family: var(--mono); font-size: 12px; }

  /* Headline banner — the one place that answers "is this tab working?". */
  .banner { display: flex; align-items: flex-start; gap: 12px; border: 1px solid var(--line);
    border-radius: var(--mon-radius); padding: 14px 16px; margin-bottom: 14px; }
  .banner .dot { margin-top: 6px; width: 10px; height: 10px; }
  .banner .bt { font-size: 15px; font-weight: 600; margin-bottom: 2px; }
  .banner .bd { font-size: 13px; color: var(--muted); }
  .banner.is-ok { border-color: color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .banner.is-warn { border-color: color-mix(in srgb, var(--warn) 45%, var(--line)); }
  .banner.is-err { border-color: color-mix(in srgb, var(--err) 45%, var(--line)); }

  /* Engine setup form */
  .field { display: block; margin-bottom: 10px; }
  .field span { display: block; font-size: 12px; color: var(--muted); margin-bottom: 4px; }
  .field input { width: 100%; font-family: var(--mon-mono); font-size: 12px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--line);
    border-radius: var(--mon-radius-sm); padding: 8px 10px; outline: none; }
  .field input:focus { border-color: var(--mon-primary); }
  .btn { font: inherit; font-size: 13px; font-weight: 600; background: var(--mon-primary);
    color: var(--mon-primary-fg); border: none; border-radius: var(--mon-radius-sm);
    padding: 8px 16px; cursor: pointer; }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn.ghost { background: transparent; color: var(--muted); border: 1px solid var(--line); }

  /* ── Monitor panel ─────────────────────────────────────────────────── */
  .mon-h2 { font-size: 14px; font-weight: 600; color: var(--fg); margin: 28px 0 10px; }
  .mon-h2:first-of-type { margin-top: 32px; }
  .mon-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 620px) { .mon-grid { grid-template-columns: 1fr; } }
  .mon-card { background: var(--card); border: 1px solid var(--line);
    border-radius: var(--mon-radius); padding: 14px 16px; margin-bottom: 14px; }
  .mon-title { font-size: 13px; font-weight: 600; color: var(--fg); margin-bottom: 10px; }
  .mon-stat-row { display: flex; align-items: baseline; justify-content: space-between;
    gap: 8px; margin-bottom: 8px; font-family: var(--mon-mono); font-size: 12px; }
  .mon-stat-row .lbl { color: var(--muted); }
  .mon-stat-row .val { font-weight: 600; }
  .meter { height: 6px; border-radius: 999px; background: var(--mon-track);
    overflow: hidden; margin-bottom: 12px; }
  .meter > i { display: block; height: 100%; background: var(--mon-primary);
    border-radius: 999px; transition: width 300ms var(--ease-snap, ease); width: 0%; }
  .spark { display: flex; align-items: flex-end; gap: 2px; height: 28px; margin-bottom: 4px; }
  .spark i { flex: 1; background: var(--mon-primary); border-radius: 1px 1px 0 0;
    min-height: 1px; opacity: 0.85; }
  table.mon-table { width: 100%; border-collapse: collapse; font-family: var(--mon-mono);
    font-size: 11.5px; }
  table.mon-table th { text-align: left; font-weight: 600; color: var(--muted);
    font-size: 11px; padding: 0 6px 6px; border-bottom: 1px solid var(--line); }
  table.mon-table td { padding: 4px 6px; border-bottom: 1px solid color-mix(in srgb, var(--line) 60%, transparent);
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 220px; }
  table.mon-table tr:last-child td { border-bottom: none; }
  .mon-empty { color: var(--muted); font-family: var(--mon-mono); font-size: 12px; padding: 6px 0; }
  .badge { display: inline-block; padding: 1px 6px; border-radius: var(--mon-radius-sm);
    font-size: 10px; font-weight: 600; font-family: var(--mon-mono); }
  .badge.ok { background: color-mix(in srgb, var(--ok) 16%, transparent); color: var(--ok); }
  .badge.err { background: color-mix(in srgb, var(--err) 16%, transparent); color: var(--err); }
  #activity { font-family: var(--mon-mono); font-size: 11.5px; line-height: 1.9;
    max-height: 260px; overflow-y: auto; }
  #activity .ln { display: flex; gap: 8px; white-space: pre; }
  #activity .t { color: var(--muted); flex-shrink: 0; }
  #activity .op { color: var(--mon-primary); flex-shrink: 0; width: 68px; }
  #activity .sid { color: var(--muted); flex-shrink: 0; width: 84px; overflow: hidden; text-overflow: ellipsis; }
  #activity .dur { color: var(--muted); flex-shrink: 0; margin-left: auto; }
  .term-out { font-family: var(--mon-mono); font-size: 12px; line-height: 1.6;
    background: var(--mon-track); border-radius: var(--mon-radius-sm);
    padding: 10px; max-height: 220px; overflow-y: auto; white-space: pre-wrap;
    word-break: break-all; margin-bottom: 8px; }
  .term-in { display: flex; gap: 8px; }
  .term-in .prompt { font-family: var(--mon-mono); font-size: 12px; color: var(--mon-primary);
    align-self: center; }
  .term-in input { flex: 1; font-family: var(--mon-mono); font-size: 12px;
    background: var(--bg); color: var(--fg); border: 1px solid var(--line);
    border-radius: var(--mon-radius-sm); padding: 7px 10px; outline: none; }
  .term-in input:focus { border-color: var(--mon-primary); }
  .term-in button { font-family: var(--mon-mono); font-size: 12px; font-weight: 600;
    background: var(--mon-primary); color: var(--mon-primary-fg); border: none;
    border-radius: var(--mon-radius-sm); padding: 0 14px; cursor: pointer; }
  .term-in button:disabled { opacity: 0.5; cursor: default; }
</style>
</head>
<body>
<main class="wide">
  <h1>OMA Browser Sandbox</h1>
  <div class="sub">This tab is a sandbox host. Keep it open while your agent session runs — closing it takes the sandbox offline.</div>

  <div class="banner" id="banner">
    <span class="dot" id="d-overall"></span>
    <div>
      <div class="bt" id="banner-title">Starting up…</div>
      <div class="bd" id="banner-detail">Registering this tab and booting the VM engine.</div>
    </div>
  </div>

  <div class="card">
    <div class="row"><span class="k">Registration</span><span class="dot" id="d-reg"></span><span class="v" id="s-reg">initializing…</span></div>
    <div class="row"><span class="k">Relay socket</span><span class="dot" id="d-ws"></span><span class="v" id="s-ws">—</span></div>
    <div class="row"><span class="k">VM engine</span><span class="dot" id="d-vm"></span><span class="v" id="s-vm">—</span></div>
    <div class="row"><span class="k">Runtime id</span><span class="v" id="s-rid">—</span></div>
  </div>

  <div class="card" id="image-diag">
    <div class="mon-title">VM image</div>
    <div class="row"><span class="k">URL</span><span class="v" id="img-url">—</span></div>
    <div class="row"><span class="k">Media kind</span><span class="v" id="img-kind">—</span></div>
    <div class="row"><span class="k">Size</span><span class="v" id="img-size">—</span></div>
    <div class="row"><span class="k">Download</span><span class="v" id="img-dl">—</span></div>
    <div class="row"><span class="k">Cache</span><span class="v" id="img-cache">—</span></div>
    <div class="row"><span class="k">Boot phase</span><span class="v" id="img-phase">—</span></div>
    <div class="row" style="margin-top:8px;gap:8px;flex-wrap:wrap">
      <button class="btn" id="btn-self-test" disabled>Self-test</button>
      <button class="btn ghost" id="btn-show-setup" type="button">Change image…</button>
      <span class="v" id="self-test-status" style="flex:1">—</span>
    </div>
  </div>

  <div class="card" id="engine-setup" hidden>
    <div class="mon-title">Custom VM image</div>
    <div class="warnbox" style="margin-bottom:12px">Override the default serial-ready buildroot kernel if needed. Assets must be
    CORS-accessible (and CORP-friendly) — this page is cross-origin isolated. Prefer a
    <code>bzimage</code> / <code>buildroot-bzimage*.bin</code> with serial console; plain
    <code>linux.iso</code> demos often never reach a serial shell. Pass
    <code>?lib=&amp;image=</code> to skip this form.</div>
    <label class="field"><span>libv86.js URL</span>
      <input id="cfg-lib" type="url" spellcheck="false" autocomplete="off" placeholder="https://cdn.jsdelivr.net/npm/v86@0.5.44/build/libv86.js" /></label>
    <label class="field"><span>Image URL (bzimage .bin, .iso, or .bin.zst state)</span>
      <input id="cfg-image" type="url" spellcheck="false" autocomplete="off" placeholder="https://i.copy.sh/buildroot-bzimage68.bin" /></label>
    <button class="btn" id="cfg-save">Boot VM</button>
  </div>

  <div class="mon-h2">Monitor</div>
  <div class="mon-grid">
    <div class="mon-card">
      <div class="mon-title">VM vitals</div>
      <div class="mon-stat-row"><span class="lbl">Memory</span><span class="val" id="mon-mem-txt">—</span></div>
      <div class="meter"><i id="mon-mem-bar"></i></div>
      <div class="mon-stat-row"><span class="lbl">CPU activity</span><span class="val" id="mon-cpu-txt">—</span></div>
      <div class="spark" id="mon-cpu-spark"></div>
      <div class="mon-stat-row"><span class="lbl">Engine</span><span class="val" id="mon-engine">—</span></div>
      <div class="mon-stat-row"><span class="lbl">Tab uptime</span><span class="val" id="mon-uptime">—</span></div>
      <div class="mon-stat-row"><span class="lbl">VM uptime</span><span class="val" id="mon-vm-uptime">—</span></div>
      <div class="mon-stat-row"><span class="lbl">Guest uptime</span><span class="val" id="mon-guest-uptime">—</span></div>
    </div>
    <div class="mon-card">
      <div class="mon-title">Sessions this tab is serving</div>
      <div id="mon-sessions"><div class="mon-empty">no sandbox ops yet</div></div>
    </div>
  </div>

  <div class="mon-card">
    <div class="mon-title">Processes <span id="mon-ps-status" style="text-transform:none;font-weight:400"></span></div>
    <div id="mon-ps"><div class="mon-empty">waiting for VM…</div></div>
  </div>

  <div class="mon-card">
    <div class="mon-title">Terminal</div>
    <div class="term-out" id="term-out">not connected — VM must be ready</div>
    <div class="term-in">
      <span class="prompt">$</span>
      <input id="term-in" type="text" placeholder="exec a command in the guest…" autocomplete="off" disabled />
      <button id="term-run" disabled>Run</button>
    </div>
  </div>

  <div class="mon-h2">Activity log</div>
  <div class="mon-card"><div id="activity"></div></div>

  <div class="card"><div id="log"></div></div>
</main>
<div id="v86-screen" style="display:none"><div style="white-space:pre;font:14px monospace"></div><canvas></canvas></div>
<script>
"use strict";
(() => {
  const qs = new URLSearchParams(location.search);
  const LS_KEY = "oma.browserVm.runtime";
  const LS_ENGINE_KEY = "oma.browserVm.engine";
  const HEARTBEAT_MS = 25000;
  const VERSION = "browser-vm-host/2";
  const PAGE_LOADED_AT = Date.now();

  // ── tiny UI helpers ──────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const sysState = { reg: "pending", ws: "pending", vm: "pending" };
  function setStatus(which, cls, text) {
    $("d-" + which).className = "dot" + (cls ? " " + cls : "");
    $("s-" + which).textContent = text;
    if (which in sysState) { sysState[which] = cls || "pending"; renderBanner(); }
  }
  // One headline verdict so a broken tab never *looks* fine while the agent
  // hangs waiting on it. Worst-of the three subsystems wins.
  const BANNER_COPY = {
    err: ["Not serving sandbox ops", "Fix the problem below — agent sessions targeting this tab will fail."],
    warn: ["Getting ready…", "This tab cannot serve sandbox ops until every row below is green."],
    pending: ["Starting up…", "Registering this tab and booting the VM engine."],
    ok: ["Serving sandbox ops", "Keep this tab open. Closing it takes the sandbox offline."],
  };
  function renderBanner() {
    const s = [sysState.reg, sysState.ws, sysState.vm];
    const worst = s.includes("err") ? "err"
      : s.includes("pending") ? "pending"
      : s.includes("warn") ? "warn" : "ok";
    const copy = BANNER_COPY[worst];
    $("banner").className = "banner is-" + (worst === "pending" ? "warn" : worst);
    $("d-overall").className = "dot " + (worst === "pending" ? "warn" : worst);
    $("banner-title").textContent = copy[0];
    $("banner-detail").textContent = copy[1];
  }
  function logLine(text, cls) {
    const el = document.createElement("div");
    if (cls) el.className = cls;
    el.textContent = new Date().toISOString().slice(11, 19) + "  " + text;
    const log = $("log");
    log.appendChild(el);
    while (log.childNodes.length > 500) log.removeChild(log.firstChild);
    log.scrollTop = log.scrollHeight;
  }

  // ── Monitor panel: VM vitals, guest processes, sessions, activity ────
  // Everything here is sourced from data this tab already has: the v86
  // engine's own memory_size config, a guest /proc poll run over the same
  // exec() path the relay uses, and the sandbox.op traffic this tab is
  // already servicing. No new engine surface is added.
  const monitor = {
    memTotalBytes: null,      // v86 memory_size — fixed at boot
    memUsedPct: null,
    guestUptimeSec: null,
    cpuSamples: [],           // rolling %busy samples for the sparkline
    prevCpuTicks: null,       // previous /proc/stat cpu-line ticks, for delta calc
    bootAt: null,             // Date.now() when the VM reported ready
    sessions: new Map(),      // session_id -> { count, lastOp, lastAt }
    activity: [],             // recent sandbox ops, newest last
    pollTimer: null,
    renderTimer: null,
    lastPollError: null,
  };
  const MAX_TRACKED_SESSIONS = 50;

  function fmtBytes(n) {
    if (n == null || !Number.isFinite(n)) return "—";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v.toFixed(v >= 10 || i === 0 ? 0 : 1) + " " + units[i];
  }
  function fmtDuration(sec) {
    if (sec == null || !Number.isFinite(sec)) return "—";
    sec = Math.floor(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h > 0 ? h + "h " : "") + (h > 0 || m > 0 ? m + "m " : "") + s + "s";
  }
  function fmtAgo(ts) {
    if (!ts) return "—";
    const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    return s < 1 ? "just now" : s + "s ago";
  }

  // Parses whatever ps flavor the guest image ships (procps -eo, procps
  // aux, or busybox's headerless PID/USER/TIME/COMMAND) into a common
  // shape. Rows without a %CPU/%MEM column still surface PID/CMD/STATE.
  function parsePs(text) {
    const rows = [];
    for (const raw of text.split("\\n")) {
      const line = raw.trim();
      if (!line || /^PID\\b/i.test(line) || /^USER\\b/i.test(line)) continue;
      let m = line.match(/^(\\d+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+(\\S+)\\s+(.+)$/);
      if (m) { rows.push({ pid: m[1], cpu: m[2], mem: m[3], stat: m[4], cmd: m[5] }); continue; }
      m = line.match(/^(\\S+)\\s+(\\d+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+\\S+\\s+\\S+\\s+\\S+\\s+(\\S+)\\s+\\S+\\s+\\S+\\s+(.+)$/);
      if (m) { rows.push({ pid: m[2], cpu: m[3], mem: m[4], stat: m[5], cmd: m[6] }); continue; }
      m = line.match(/^(\\d+)\\s+(\\S+)\\s+(\\S+)\\s+(.+)$/);
      if (m) { rows.push({ pid: m[1], cpu: null, mem: null, stat: "-", cmd: m[4] }); continue; }
    }
    rows.sort((a, b) => (parseFloat(b.cpu) || 0) - (parseFloat(a.cpu) || 0));
    return rows.slice(0, 15);
  }

  function parseGuestSnapshot(stdout) {
    const memPart = (stdout.split("---MEM---")[0] || "");
    const rest1 = stdout.split("---MEM---")[1] || "";
    const statPart = (rest1.split("---STAT---")[0] || "");
    const rest2 = rest1.split("---STAT---")[1] || "";
    const upPart = (rest2.split("---UP---")[0] || "");
    const rest3 = rest2.split("---UP---")[1] || "";
    const psPart = (rest3.split("---PS---")[0] || "");

    const totalKb = (memPart.match(/MemTotal:\\s+(\\d+)/) || [])[1];
    const availKb = (memPart.match(/MemAvailable:\\s+(\\d+)/) || [])[1] ||
      (memPart.match(/MemFree:\\s+(\\d+)/) || [])[1];
    if (totalKb) {
      monitor.memTotalBytes = parseInt(totalKb, 10) * 1024;
      if (availKb) {
        const usedKb = parseInt(totalKb, 10) - parseInt(availKb, 10);
        monitor.memUsedPct = Math.max(0, Math.min(100, (usedKb / parseInt(totalKb, 10)) * 100));
      }
    }

    const cpuLine = statPart.match(/^cpu\\s+(.+)$/m);
    if (cpuLine) {
      const ticks = cpuLine[1].trim().split(/\\s+/).map(Number);
      const idle = (ticks[3] || 0) + (ticks[4] || 0);
      const total = ticks.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
      if (monitor.prevCpuTicks) {
        const dTotal = total - monitor.prevCpuTicks.total;
        const dIdle = idle - monitor.prevCpuTicks.idle;
        if (dTotal > 0) {
          const pct = Math.max(0, Math.min(100, 100 * (1 - dIdle / dTotal)));
          monitor.cpuSamples.push(pct);
          if (monitor.cpuSamples.length > 40) monitor.cpuSamples.shift();
        }
      }
      monitor.prevCpuTicks = { total, idle };
    }

    const upMatch = upPart.match(/^([\\d.]+)/m);
    if (upMatch) monitor.guestUptimeSec = parseFloat(upMatch[1]);

    monitor.psRows = parsePs(psPart);
  }

  function renderMonitor() {
    // Vitals
    $("mon-mem-txt").textContent = monitor.memTotalBytes
      ? (monitor.memUsedPct != null
          ? Math.round(monitor.memUsedPct) + "% of " + fmtBytes(monitor.memTotalBytes)
          : fmtBytes(monitor.memTotalBytes) + " total")
      : "—";
    $("mon-mem-bar").style.width = (monitor.memUsedPct || 0) + "%";

    const lastCpu = monitor.cpuSamples[monitor.cpuSamples.length - 1];
    $("mon-cpu-txt").textContent = lastCpu != null ? Math.round(lastCpu) + "%" : "—";
    const spark = $("mon-cpu-spark");
    spark.innerHTML = "";
    const samples = monitor.cpuSamples.slice(-24);
    for (const v of samples) {
      const bar = document.createElement("i");
      bar.style.height = Math.max(4, v) + "%";
      spark.appendChild(bar);
    }

    $("mon-engine").textContent = monitor.engineName || "—";
    $("mon-uptime").textContent = fmtDuration((Date.now() - PAGE_LOADED_AT) / 1000);
    $("mon-vm-uptime").textContent = monitor.bootAt
      ? fmtDuration((Date.now() - monitor.bootAt) / 1000) : "not booted";
    $("mon-guest-uptime").textContent = monitor.guestUptimeSec != null ? fmtDuration(monitor.guestUptimeSec) : "—";

    // Processes
    const psStatus = $("mon-ps-status");
    psStatus.textContent = monitor.lastPollError ? "(" + monitor.lastPollError + ")" : "";
    const psEl = $("mon-ps");
    if (!monitor.psRows || monitor.psRows.length === 0) {
      psEl.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "mon-empty";
      empty.textContent = vmReady ? "no process data yet" : "VM not booted";
      psEl.appendChild(empty);
    } else {
      const table = document.createElement("table");
      table.className = "mon-table";
      table.innerHTML = "<thead><tr><th>PID</th><th>CMD</th><th>CPU%</th><th>MEM%</th><th>STATE</th></tr></thead>";
      const tbody = document.createElement("tbody");
      for (const p of monitor.psRows) {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + esc(p.pid) + "</td><td>" + esc(p.cmd) + "</td><td>" +
          (p.cpu != null ? esc(p.cpu) : "—") + "</td><td>" + (p.mem != null ? esc(p.mem) : "—") +
          "</td><td>" + esc(p.stat) + "</td>";
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      psEl.innerHTML = "";
      psEl.appendChild(table);
    }

    // Sessions
    const sessEl = $("mon-sessions");
    if (monitor.sessions.size === 0) {
      sessEl.innerHTML = '<div class="mon-empty">no sandbox ops yet</div>';
    } else {
      const table = document.createElement("table");
      table.className = "mon-table";
      table.innerHTML = "<thead><tr><th>Session</th><th>Ops</th><th>Last op</th><th>Last seen</th></tr></thead>";
      const tbody = document.createElement("tbody");
      const entries = Array.from(monitor.sessions.entries()).sort((a, b) => b[1].lastAt - a[1].lastAt);
      for (const [sid, s] of entries) {
        const tr = document.createElement("tr");
        tr.innerHTML = "<td>" + esc(sid.slice(0, 12)) + "</td><td>" + s.count + "</td><td>" +
          esc(s.lastOp) + "</td><td>" + esc(fmtAgo(s.lastAt)) + "</td>";
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      sessEl.innerHTML = "";
      sessEl.appendChild(table);
    }
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function recordActivity(entry) {
    monitor.activity.push(entry);
    if (monitor.activity.length > 300) monitor.activity.shift();
    const el = $("activity");
    const ln = document.createElement("div");
    ln.className = "ln";
    const time = document.createElement("span"); time.className = "t";
    time.textContent = new Date(entry.at).toISOString().slice(11, 19);
    const op = document.createElement("span"); op.className = "op"; op.textContent = entry.op;
    const sid = document.createElement("span"); sid.className = "sid";
    sid.textContent = entry.sessionId ? entry.sessionId.slice(0, 10) : "—";
    const badge = document.createElement("span");
    badge.className = "badge " + (entry.ok ? "ok" : "err");
    badge.textContent = entry.ok ? "ok" : "err";
    const dur = document.createElement("span"); dur.className = "dur";
    dur.textContent = entry.durationMs != null ? entry.durationMs + "ms" : "";
    ln.append(time, op, sid, badge, dur);
    el.appendChild(ln);
    while (el.childNodes.length > 300) el.removeChild(el.firstChild);
    el.scrollTop = el.scrollHeight;
    renderMonitor(); // keeps the sessions table live even before the VM is ready
  }

  function startMonitorPolling() {
    if (monitor.pollTimer) return;
    monitor.pollTimer = setInterval(() => { void pollGuest(); }, 3000);
    void pollGuest();
    // Ticks the uptime clock between polls. Skipped while hidden so a
    // backgrounded tab isn't rebuilding tables once a second forever.
    monitor.renderTimer = setInterval(() => { if (!document.hidden) renderMonitor(); }, 1000);
  }
  async function pollGuest() {
    if (!engine || !vmReady || document.hidden) return;
    try {
      const r = await engine.exec(
        "cat /proc/meminfo 2>/dev/null | head -5; echo ---MEM---; " +
        "cat /proc/stat 2>/dev/null | head -1; echo ---STAT---; " +
        "cat /proc/uptime 2>/dev/null; echo ---UP---; " +
        "(ps -eo pid,pcpu,pmem,stat,comm --sort=-pcpu 2>/dev/null | head -16) || " +
        "(ps aux 2>/dev/null | head -16) || ps 2>/dev/null | head -16; echo ---PS---",
        8000,
      );
      parseGuestSnapshot(r.stdout || "");
      monitor.lastPollError = null;
    } catch (e) {
      monitor.lastPollError = String(e.message || e).slice(0, 80);
    }
    renderMonitor();
  }

  // ── Terminal: a direct exec() REPL against the same engine the relay
  // uses — a local convenience, not a separate sandbox op.
  let terminalReady = false;
  function initTerminal() {
    if (terminalReady) return;
    terminalReady = true;
    const out = $("term-out"), input = $("term-in"), btn = $("term-run");
    out.textContent = "";
    input.disabled = false; btn.disabled = false;
    const history = []; let histIdx = -1;
    function printLn(text, cls) {
      const el = document.createElement("div");
      if (cls) el.style.color = "var(--" + cls + ")";
      el.textContent = text;
      out.appendChild(el);
      out.scrollTop = out.scrollHeight;
    }
    async function run() {
      const cmd = input.value.trim();
      if (!cmd) return;
      history.push(cmd); histIdx = history.length;
      input.value = ""; input.disabled = true; btn.disabled = true;
      printLn("$ " + cmd);
      try {
        const r = await engine.exec(cmd, 30000);
        if (r.stdout) printLn(r.stdout.replace(/\\n$/, ""));
        if (r.stderr) printLn(r.stderr.replace(/\\n$/, ""), "err");
        if (r.exit_code !== 0) printLn("[exit " + r.exit_code + "]", "muted");
      } catch (e) {
        printLn("error: " + (e.message || e), "err");
      }
      input.disabled = false; btn.disabled = false; input.focus();
    }
    btn.addEventListener("click", run);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") run();
      else if (ev.key === "ArrowUp") { if (histIdx > 0) { histIdx--; input.value = history[histIdx] || ""; } ev.preventDefault(); }
      else if (ev.key === "ArrowDown") { if (histIdx < history.length) { histIdx++; input.value = history[histIdx] || ""; } ev.preventDefault(); }
    });
  }

  // ── Engine seam ──────────────────────────────────────────────────────
  // An engine services the five sandbox ops against an in-tab VM:
  //   boot(): Promise<void>
  //   exec(command, timeoutMs): Promise<{exit_code, stdout, stderr}>
  //   readFile(path): Promise<string>
  //   writeFile(path, content): Promise<void>
  //   setEnvVars(env): Promise<void>
  //   destroy(): Promise<void>
  // v86 is the open (BSD-2) default. WebContainers/CheerpX are BYO-license:
  // implement this interface and register in ENGINES.

  // ── serial-console framing helpers ───────────────────────────────────
  //
  // A guest TTY in canonical mode echoes everything we type back down the
  // same serial line we are reading, and its line-discipline buffer is
  // typically 4096 bytes. Both facts are load-bearing:
  //
  //  * A marker that appears *literally* in the command we send comes back
  //    in the echo, so a naive indexOf() matches the echo instead of the
  //    real output — the round trip "succeeds" before the command has run
  //    (at boot that means declaring the VM ready while it is still sitting
  //    at a login prompt). shSplit() emits the marker via two adjacent
  //    shell-quoted halves: the guest concatenates them back into the whole
  //    token, but the bytes we type never contain it contiguously.
  //  * Any single line longer than the line buffer is silently truncated,
  //    so every line we send is kept under MAX_LINE and longer payloads are
  //    split across several round trips.
  const MAX_LINE = 1800;
  const MAX_WRITE_BYTES = 4 * 1024 * 1024;
  function shq(s) { return "'" + String(s).replace(/'/g, "'\\\\''") + "'"; }
  function shSplit(m) { return "'" + m.slice(0, 1) + "''" + m.slice(1) + "'"; }
  function emit(m) { return "printf '%s\\\\n' " + shSplit(m); }
  function rnd() { return Math.random().toString(36).slice(2, 10); }
  function linesFit(script) {
    return script.split("\\n").every((l) => l.length <= MAX_LINE);
  }
  // base64 <-> text via TextEncoder/TextDecoder: escape()/unescape() are
  // Latin-1 and throw URIError on any byte sequence that isn't valid UTF-8,
  // which turned "read a binary file" into an unusable "URI malformed".
  function textToB64(text) {
    const bytes = new TextEncoder().encode(text);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  function b64ToText(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder("utf-8").decode(bytes);
  }

  // Public defaults. The demo ISO (linux.iso) does NOT expose a usable
  // serial shell — every op then fails with "VM did not reach a shell
  // within 180s". Use the same buildroot bzimage v86's serial.html example
  // boots. Image bytes go through the same-origin /sandbox-tab/asset proxy
  // because i.copy.sh serves CORS but no CORP, which COEP require-corp
  // rejects for direct cross-origin loads.
  const DEFAULT_V86_LIB = "https://cdn.jsdelivr.net/npm/v86@0.5.44/build/libv86.js";
  const DEFAULT_V86_IMAGE_REMOTE = "https://i.copy.sh/buildroot-bzimage68.bin";
  const DEFAULT_V86_IMAGE = "/sandbox-tab/asset?url=" + encodeURIComponent(DEFAULT_V86_IMAGE_REMOTE);
  // BIOS blobs live on the copy/v86 repo; the npm package ships only lib + wasm.
  // jsDelivr ships CORP: cross-origin, so they load under COEP directly.
  const DEFAULT_V86_BIOS = "https://cdn.jsdelivr.net/gh/copy/v86@master/bios/seabios.bin";
  const DEFAULT_V86_VGA_BIOS = "https://cdn.jsdelivr.net/gh/copy/v86@master/bios/vgabios.bin";
  // Bump when the default image changes so stale localStorage engine
  // configs that pin the broken linux.iso are migrated on next load.
  const ENGINE_CONFIG_VERSION = 2;
  // Match v86/examples/serial.html — serial-ready buildroot kernels.
  const DEFAULT_BZIMAGE_CMDLINE = "tsc=reliable mitigations=off random.trust_cpu=on console=ttyS0";

  // PURE_HELPERS_START — unit-tested via extraction from the inline script.
  // Classify a guest media URL into the v86 option shape we should use.
  // Critical: do NOT treat every .bin as initial_state (that was the
  // pre-fix bug for buildroot-bzimage*.bin kernels).
  function classifyV86Media(url) {
    const u = String(url || "").toLowerCase();
    if (/\\.bin\\.zst(?:$|[?#])/i.test(u)) return "state";
    if (/(?:^|[/_-])(?:v86)?state(?:[/_.-]|$)/i.test(u) || /initial[_-]?state/i.test(u)) return "state";
    if (/bzimage/i.test(u) || /vmlinu[xz]/i.test(u) || /\\/kernel(?:\\.bin)?(?:$|[?#])/i.test(u)) return "bzimage";
    if (/\\.iso(?:\\.gz)?(?:$|[?#])/i.test(u)) return "iso";
    if (/\\.(?:img|raw|qcow2|vhd|vmdk)(?:\\.gz)?(?:$|[?#])/i.test(u)) return "hda";
    if (/\\.bin(?:$|[?#])/i.test(u)) return "bzimage";
    return "unknown";
  }
  function isLegacyDefaultImage(url) {
    const u = String(url || "");
    return /cdn\\.jsdelivr\\.net\\/gh\\/copy\\/images@[^/]+\\/linux\\.iso/i.test(u)
      || /copy\\/images.*\\/linux\\.iso/i.test(u);
  }
  function resolveImageUrlForFetch(url) {
    // Absolute remote images on hosts we proxy stay as-is when already
    // same-origin (path starts with /sandbox-tab/asset). Bare remote
    // buildroot URLs get proxied so COEP can load them.
    const u = String(url || "");
    if (!u || u.startsWith("/") || u.startsWith(location.origin + "/")) return u;
    try {
      const parsed = new URL(u, location.href);
      if (parsed.hostname === "i.copy.sh") {
        return "/sandbox-tab/asset?url=" + encodeURIComponent(parsed.href);
      }
    } catch { /* keep original */ }
    return u;
  }
  function buildV86BootOptions(imageUrl, libBase, biosUrl, vgaBiosUrl) {
    const kind = classifyV86Media(imageUrl);
    const opts = {
      wasm_path: libBase + "v86.wasm",
      memory_size: 128 * 1024 * 1024,
      vga_memory_size: 4 * 1024 * 1024,
      bios: { url: biosUrl },
      vga_bios: { url: vgaBiosUrl },
      screen_container: document.getElementById("v86-screen"),
      autostart: true,
      disable_keyboard: true,
      disable_mouse: true,
      media_kind: kind,
    };
    if (kind === "state") {
      opts.initial_state = { url: imageUrl };
    } else if (kind === "bzimage") {
      // Serial-ready path used by v86/examples/serial.html.
      opts.bzimage = { url: imageUrl, async: false };
      opts.filesystem = {};
      opts.cmdline = DEFAULT_BZIMAGE_CMDLINE;
    } else if (kind === "hda") {
      opts.hda = { url: imageUrl, async: true };
    } else {
      // iso + unknown fall back to cdrom (best effort; many demo ISOs have
      // no serial console and will hit the 180s shell timeout loud).
      opts.cdrom = { url: imageUrl };
    }
    return opts;
  }
  // PURE_HELPERS_END

  // Image diagnostics panel — size / download / cache / boot phase.
  const imageDiag = {
    url: "",
    kind: "—",
    sizeBytes: null,
    loadedBytes: null,
    phase: "idle",
    cache: "unknown",
    lastFile: "",
  };
  function setBootPhase(phase, detail) {
    imageDiag.phase = phase;
    const el = $("img-phase");
    if (el) el.textContent = detail ? phase + " — " + detail : phase;
  }
  function renderImageDiag() {
    if ($("img-url")) $("img-url").textContent = imageDiag.url || "—";
    if ($("img-kind")) $("img-kind").textContent = imageDiag.kind || "—";
    const sizeTxt = imageDiag.sizeBytes != null
      ? fmtBytes(imageDiag.sizeBytes)
        + (imageDiag.loadedBytes != null && imageDiag.loadedBytes < imageDiag.sizeBytes
          ? " (" + fmtBytes(imageDiag.loadedBytes) + " loaded)"
          : "")
      : (imageDiag.loadedBytes != null ? fmtBytes(imageDiag.loadedBytes) + " loaded" : "—");
    if ($("img-size")) $("img-size").textContent = sizeTxt;
    if ($("img-dl")) {
      if (imageDiag.sizeBytes && imageDiag.loadedBytes != null) {
        const pct = Math.min(100, Math.round(100 * imageDiag.loadedBytes / imageDiag.sizeBytes));
        $("img-dl").textContent = pct + "%"
          + (imageDiag.lastFile ? " · " + imageDiag.lastFile : "");
      } else if (imageDiag.phase === "ready") {
        $("img-dl").textContent = "complete";
      } else {
        $("img-dl").textContent = imageDiag.phase === "downloading" ? "in progress…" : "—";
      }
    }
    if ($("img-cache")) $("img-cache").textContent = imageDiag.cache;
  }
  async function probeImageMeta(url) {
    imageDiag.url = url;
    imageDiag.kind = classifyV86Media(url);
    imageDiag.sizeBytes = null;
    imageDiag.loadedBytes = null;
    imageDiag.cache = "probing…";
    renderImageDiag();
    try {
      // Prefer HEAD; some CDNs only answer GET. Abort quickly.
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      let res = await fetch(url, { method: "HEAD", mode: "cors", signal: ctrl.signal }).catch(() => null);
      if (!res || !res.ok || !res.headers.get("content-length")) {
        res = await fetch(url, { method: "GET", mode: "cors", headers: { Range: "bytes=0-0" }, signal: ctrl.signal }).catch(() => null);
      }
      clearTimeout(t);
      if (res && res.ok) {
        const cl = res.headers.get("content-length");
        const cr = res.headers.get("content-range"); // bytes 0-0/TOTAL
        if (cl) imageDiag.sizeBytes = parseInt(cl, 10);
        else if (cr) {
          const m = cr.match(/\\/(\\d+)\\s*$/);
          if (m) imageDiag.sizeBytes = parseInt(m[1], 10);
        }
        // Resource Timing: transferSize === 0 with decodedBodySize > 0 ⇒ disk cache.
        try {
          const entries = performance.getEntriesByName(new URL(url, location.href).href, "resource");
          const last = entries[entries.length - 1];
          if (last && "transferSize" in last) {
            imageDiag.cache = last.transferSize === 0 && last.decodedBodySize > 0
              ? "cached (browser)"
              : (last.transferSize > 0 ? "network (" + fmtBytes(last.transferSize) + ")" : "unknown");
          } else {
            imageDiag.cache = res.headers.get("cf-cache-status")
              || res.headers.get("x-cache")
              || "fetched";
          }
        } catch {
          imageDiag.cache = "fetched";
        }
      } else {
        imageDiag.cache = "probe failed";
      }
    } catch (e) {
      imageDiag.cache = "probe error: " + (e.message || e);
    }
    renderImageDiag();
  }

  // v86 engine: boots a Linux image and drives the serial console. Commands
  // are wrapped in sentinel markers; file content crosses the console as
  // base64 so binary-ish text survives the TTY.
  //
  // There is exactly one serial console and several independent callers —
  // the relay (possibly several sessions at once), the 3s monitor poll and
  // the terminal REPL — so every public op is serialized through #queue.
  // Without it two commands interleave on the same shell and shred each
  // other's output.
  class V86Engine {
    constructor(libUrl, imageUrl) {
      this.libUrl = libUrl;
      this.imageUrl = resolveImageUrlForFetch(imageUrl);
      this.emulator = null;
      this.serialBuf = "";
      this.serialBase = 0; // absolute stream index of serialBuf[0]
      this.waiters = [];
      this.env = {};
      this.queue = Promise.resolve();
      this.destroyed = false;
    }
    // Serializes ops. Absolute stream offsets (serialBase) rather than
    // serialBuf indices, because trimming the rolling buffer used to shift
    // every index a waiter had already captured.
    enqueue(fn) {
      const run = this.queue.then(() => fn(), () => fn());
      this.queue = run.then(() => undefined, () => undefined);
      return run;
    }
    exec(command, timeoutMs) { return this.enqueue(() => this.execRaw(command, timeoutMs)); }
    readFile(path) { return this.enqueue(() => this.readFileRaw(path)); }
    writeFile(path, content) { return this.enqueue(() => this.writeFileRaw(path, content)); }
    async boot() {
      setBootPhase("loading-lib", this.libUrl);
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = this.libUrl;
        s.crossOrigin = "anonymous";
        s.onload = resolve;
        s.onerror = () => reject(new Error("failed to load libv86.js from " + this.libUrl));
        document.head.appendChild(s);
      });
      const base = this.libUrl.replace(/[^/]*$/, "");
      void probeImageMeta(this.imageUrl);
      setBootPhase("downloading", "fetching guest image + BIOS");
      const opts = buildV86BootOptions(
        this.imageUrl, base, DEFAULT_V86_BIOS, DEFAULT_V86_VGA_BIOS,
      );
      imageDiag.kind = opts.media_kind;
      delete opts.media_kind;
      renderImageDiag();
      logLine("v86 media kind: " + imageDiag.kind + " · " + this.imageUrl);
      this.emulator = new window.V86(opts);
      this.emulator.add_listener("download-progress", (e) => {
        try {
          imageDiag.phase = "downloading";
          if (e && typeof e.loaded === "number") imageDiag.loadedBytes = e.loaded;
          if (e && typeof e.total === "number" && e.total > 0) imageDiag.sizeBytes = e.total;
          if (e && e.file_name) imageDiag.lastFile = String(e.file_name).split("/").pop();
          // Heuristic cache signal from a complete tiny transfer.
          if (e && e.total > 0 && e.loaded === e.total && e.total > 1024 * 1024) {
            // leave cache as probed unless still unknown
          }
          renderImageDiag();
          setBootPhase("downloading",
            (imageDiag.lastFile || "asset") + " " +
            (imageDiag.sizeBytes
              ? Math.min(100, Math.round(100 * (imageDiag.loadedBytes || 0) / imageDiag.sizeBytes)) + "%"
              : fmtBytes(imageDiag.loadedBytes || 0)));
        } catch { /* UI only */ }
      });
      this.emulator.add_listener("download-error", (e) => {
        const name = (e && e.file_name) || "asset";
        logLine("download error: " + name, "err");
        setBootPhase("download-failed", String(name));
      });
      this.emulator.add_listener("serial0-output-byte", (byte) => {
        this.serialBuf += String.fromCharCode(byte);
        if (this.serialBuf.length > 4 * 1024 * 1024) {
          const drop = this.serialBuf.length - 2 * 1024 * 1024;
          this.serialBuf = this.serialBuf.slice(drop);
          this.serialBase += drop;
        }
        for (const w of this.waiters.slice()) w();
      });
      // Wait for a shell: poke enter until a marker round-trips. The marker
      // is emitted split (see shSplit) so a login prompt echoing our
      // keystrokes can't be mistaken for a working shell.
      setBootPhase("waiting-for-shell", "serial console (up to 180s)");
      setStatus("vm", "warn", "waiting for guest shell…");
      const bootMarker = "__oma_boot_" + rnd() + "_";
      const deadline = Date.now() + 180000;
      for (;;) {
        if (Date.now() > deadline) {
          setBootPhase("failed", "VM did not reach a shell within 180s");
          throw new Error("VM did not reach a shell within 180s");
        }
        try {
          this.emulator.serial0_send("\\n");
          await this.rawRoundTrip(emit(bootMarker), bootMarker, 5000);
          break;
        } catch { /* still booting */ }
      }
      setBootPhase("configuring", "stty + /workspace");
      const ready = "__oma_ready_" + rnd() + "_";
      await this.rawRoundTrip(
        "stty -echo 2>/dev/null; mkdir -p /workspace; cd /workspace; " + emit(ready),
        ready, 15000,
      );
      // Both file ops ride base64 over the console; a guest image shipping
      // neither base64 nor openssl would fail every read/write with a
      // framing error. Say so up front instead.
      const probe = "__oma_b64ok_" + rnd() + "_";
      const probeOut = await this.rawRoundTrip(
        "{ command -v base64 >/dev/null 2>&1 || command -v openssl >/dev/null 2>&1; } && " +
        emit(probe) + "; " + emit(ready),
        ready, 15000,
      ).catch(() => "");
      this.hasBase64 = probeOut.indexOf(probe) !== -1;
      setBootPhase("ready", imageDiag.kind);
      imageDiag.cache = imageDiag.cache === "probing…" || imageDiag.cache === "unknown"
        ? "ready" : imageDiag.cache;
      renderImageDiag();
    }
    rawRoundTrip(cmd, marker, timeoutMs) {
      if (this.destroyed) return Promise.reject(new Error("VM has been destroyed"));
      if (!linesFit(cmd)) {
        return Promise.reject(new Error("serial line too long (> " + MAX_LINE + " bytes)"));
      }
      const start = this.serialBase + this.serialBuf.length;
      this.emulator.serial0_send(cmd + "\\n");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { drop(); reject(new Error("serial timeout: " + marker)); }, timeoutMs);
        const check = () => {
          const from = Math.max(0, start - this.serialBase);
          const rel = this.serialBuf.indexOf(marker, from);
          if (rel === -1) return;
          clearTimeout(timer); drop();
          resolve(this.serialBuf.slice(from, rel));
        };
        const drop = () => { this.waiters = this.waiters.filter((w) => w !== check); };
        this.waiters.push(check);
        check();
      });
    }
    async execRaw(command, timeoutMs) {
      const id = rnd();
      const rc = "__oma_rc_" + id + "_";
      const end = "__oma_end_" + id + "_";
      const outPath = "/tmp/.oma_out_" + id, errPath = "/tmp/.oma_err_" + id;
      // Env vars are re-exported per exec (serial shell has one session, but
      // stay defensive against VM-side shell restarts).
      const exports = Object.entries(this.env)
        .map(([k, v]) => "export " + k + "=" + shq(v)).join("; ");
      // The exit code is printed *before* the terminal marker so it has
      // provably arrived by the time the round trip resolves. Waiting on the
      // exit-code marker itself used to resolve before its own digits landed,
      // which reported exit_code -1 for every fast command.
      const body = (exports ? exports + "\\n" : "") +
        "{ " + command + "\\n} > " + outPath + " 2> " + errPath + "\\n" +
        "printf '%s%s\\\\n' " + shSplit(rc) + " $?\\n" + emit(end);
      let captured;
      try {
        // An agent command can be arbitrarily long; anything that wouldn't
        // survive the guest's line buffer is staged as a script file first.
        if (linesFit(body)) {
          captured = await this.rawRoundTrip(body, end, timeoutMs);
        } else {
          const scriptPath = "/tmp/.oma_cmd_" + id;
          await this.writeFileRaw(scriptPath, body);
          captured = await this.rawRoundTrip("sh " + scriptPath, end, timeoutMs);
        }
      } catch (e) {
        // The guest is still running the command — interrupt it so the next
        // op doesn't queue behind a wedged foreground process.
        try { this.emulator.serial0_send("\\u0003"); } catch { /* gone */ }
        throw e;
      }
      const at = captured.lastIndexOf(rc);
      const exitCode = at === -1 ? NaN : parseInt(captured.slice(at + rc.length).trim(), 10);
      const stdout = await this.readFileRaw(outPath).catch(() => "");
      const stderr = await this.readFileRaw(errPath).catch(() => "");
      // Awaited, not fire-and-forget: an un-awaited round trip would race the
      // next queued op on the same console.
      await this.rawRoundTrip(
        "rm -f " + outPath + " " + errPath + " /tmp/.oma_cmd_" + id + "; " + emit(end),
        end, 10000,
      ).catch(() => undefined);
      return { exit_code: Number.isFinite(exitCode) ? exitCode : -1, stdout, stderr };
    }
    async readFileRaw(path) {
      if (String(path).length > 1000) throw new Error("path too long for the serial console");
      const id = rnd();
      const m0 = "__oma_b64s_" + id + "_", m1 = "__oma_b64e_" + id + "_";
      const miss = "__oma_miss_" + id + "_";
      // A missing/unreadable file used to decode as empty content, so the
      // agent got "" for a file that isn't there. Emit an explicit marker.
      const out = await this.rawRoundTrip(
        emit(m0) + "; { base64 " + shq(path) + " 2>/dev/null || openssl base64 -in " + shq(path) +
        " 2>/dev/null || " + emit(miss) + "; }; " + emit(m1),
        m1, 30000,
      );
      const s = out.indexOf(m0);
      if (s === -1) throw new Error("readFile framing lost");
      const payload = out.slice(s + m0.length);
      if (payload.indexOf(miss) !== -1) throw new Error("no such file: " + path);
      const b64 = payload.replace(/[^A-Za-z0-9+/=]/g, "");
      try {
        return b64ToText(b64);
      } catch (e) {
        throw new Error("readFile decode failed for " + path + ": " + (e.message || e));
      }
    }
    async writeFileRaw(path, content) {
      if (String(path).length > 1000) throw new Error("path too long for the serial console");
      const b64 = textToB64(content);
      if (b64.length > MAX_WRITE_BYTES) {
        throw new Error("file too large for the browser-vm serial transport (" +
          fmtBytes(b64.length) + " of base64 > " + fmtBytes(MAX_WRITE_BYTES) + ")");
      }
      const id = rnd();
      const done = "__oma_w_" + id + "_";
      const stage = "/tmp/.oma_b64_" + id;
      await this.rawRoundTrip(
        "mkdir -p \\"$(dirname " + shq(path) + ")\\"; : > " + stage + "; " + emit(done),
        done, 30000,
      );
      // One round trip per chunk: appending every chunk to a single command
      // built a line megabytes long, which the guest's line discipline
      // silently truncated — large writes landed corrupt.
      const budget = MAX_LINE - (stage.length + 160);
      for (let i = 0; i < b64.length; i += budget) {
        const mk = done + i + "_";
        await this.rawRoundTrip(
          "printf %s '" + b64.slice(i, i + budget) + "' >> " + stage + "; " + emit(mk),
          mk, 30000,
        );
      }
      await this.rawRoundTrip(
        // printf %s leaves the staged base64 without a trailing newline;
        // some decoders treat that as a truncated final line.
        "printf '\\\\n' >> " + stage + "; " +
        "{ base64 -d " + stage + " > " + shq(path) + " 2>/dev/null || " +
        "openssl base64 -d -in " + stage + " -out " + shq(path) + " 2>/dev/null; }; " +
        "rm -f " + stage + "; " + emit(done),
        done, 60000,
      );
    }
    async setEnvVars(env) { Object.assign(this.env, env); }
    async destroy() {
      this.destroyed = true;
      for (const w of this.waiters.slice()) { try { w(); } catch { /* ignore */ } }
      try { this.emulator && this.emulator.destroy(); } catch { /* gone */ }
      this.emulator = null;
    }
  }

  // Engine config: query params win (a deliberate deep link), otherwise the
  // last values entered in the setup card, otherwise the public defaults.
  // DEFAULT_V86_* are declared above the V86Engine class.
  //
  // ENGINE_CONFIG_VERSION migrates operators who still have the pre-fix
  // linux.iso default cached in localStorage (that image never reaches a
  // serial shell). Explicit ?image= and intentionally saved non-legacy
  // URLs are left alone.
  function readEngineConfig() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(LS_ENGINE_KEY) || "null"); } catch { /* corrupt */ }
    if (saved && (saved.v !== ENGINE_CONFIG_VERSION || isLegacyDefaultImage(saved.image))) {
      logLine("migrating stored engine config (legacy image or stale version)");
      try { localStorage.removeItem(LS_ENGINE_KEY); } catch { /* private mode */ }
      saved = null;
    }
    const image = qs.get("image") || (saved && saved.image) || DEFAULT_V86_IMAGE;
    const lib = qs.get("lib") || (saved && saved.lib) || DEFAULT_V86_LIB;
    return { lib, image };
  }
  function saveEngineConfig(cfg) {
    try {
      localStorage.setItem(LS_ENGINE_KEY, JSON.stringify({
        v: ENGINE_CONFIG_VERSION,
        lib: cfg.lib,
        image: cfg.image,
      }));
    } catch { /* private mode */ }
  }

  const ENGINES = {
    v86: () => {
      const cfg = readEngineConfig();
      if (!cfg.lib || !cfg.image) return null;
      return new V86Engine(cfg.lib, cfg.image);
    },
    // webcontainers / cheerpx: BYO-license — implement the Engine seam and
    // register a factory here in your fork/deployment.
  };

  // ── OPFS mirror: /workspace writes survive a tab reload ──────────────
  async function opfsRoot() {
    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle("oma-workspace", { create: true });
  }
  async function opfsWrite(path, content) {
    try {
      const rel = path.replace(/^\\/workspace\\/?/, "");
      if (!rel || path[0] !== "/" || !path.startsWith("/workspace/")) return;
      let dir = await opfsRoot();
      const parts = rel.split("/").filter(Boolean);
      const name = parts.pop();
      for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
      const fh = await dir.getFileHandle(name, { create: true });
      const w = await fh.createWritable();
      await w.write(content);
      await w.close();
    } catch (e) { logLine("OPFS mirror failed: " + e.message, "err"); }
  }
  async function opfsRestore(engine) {
    try {
      const walk = async (dir, prefix) => {
        for await (const [name, handle] of dir.entries()) {
          if (handle.kind === "directory") await walk(handle, prefix + name + "/");
          else {
            const text = await (await handle.getFile()).text();
            await engine.writeFile("/workspace/" + prefix + name, text);
          }
        }
      };
      await walk(await opfsRoot(), "");
      logLine("restored /workspace from OPFS");
    } catch (e) { logLine("OPFS restore skipped: " + e.message, "err"); }
  }

  // ── Registration: pairing code → runtime token (localStorage) ────────
  function readStoredRuntime() {
    try { return JSON.parse(localStorage.getItem(LS_KEY) || "null"); } catch { return null; }
  }
  async function register() {
    const stored = readStoredRuntime();
    const code = qs.get("code"), state = qs.get("state");
    // A fresh pairing code is an explicit re-pair from the Console and wins
    // over a stored token when exchange succeeds: the stored one may have
    // been revoked, and preferring it left the tab reconnect-looping against
    // a dead token with no way out short of clearing site data.
    if (!code || !state) {
      if (stored && stored.token) {
        setStatus("reg", "ok", "registered (stored token)");
        $("s-rid").textContent = stored.runtime_id;
        return stored;
      }
      setStatus("reg", "err", "no pairing code — open this tab from the Console");
      throw new Error("unpaired");
    }
    const machineId = (stored && stored.machine_id) || crypto.randomUUID();
    setStatus("reg", "warn", "exchanging pairing code…");
    const res = await fetch("/agents/runtime/exchange", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code, state,
        machine_id: machineId,
        hostname: "browser:" + location.hostname,
        os: "browser",
        version: VERSION,
        kind: "browser-vm",
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      const brief = body.slice(0, 200);
      // Fall back to a previously stored token when re-pair fails (e.g. KV
      // write budget exhausted). A dead stored token still fails WS attach
      // and clears itself after MAX_PAIRING_ATTEMPTS.
      if (stored && stored.token) {
        logLine("exchange failed, using stored token: " + brief, "err");
        setStatus("reg", "ok", "registered (stored token; re-pair failed)");
        $("s-rid").textContent = stored.runtime_id;
        history.replaceState(null, "", location.pathname + keepEngineParams());
        return stored;
      }
      setStatus("reg", "err", "exchange failed: " + brief);
      throw new Error("exchange failed");
    }
    const data = await res.json();
    const record = { runtime_id: data.runtime_id, token: data.token, machine_id: machineId };
    localStorage.setItem(LS_KEY, JSON.stringify(record));
    // Drop the one-time code from the URL so a reload doesn't re-burn it.
    history.replaceState(null, "", location.pathname + keepEngineParams());
    setStatus("reg", "ok", "registered");
    $("s-rid").textContent = record.runtime_id;
    return record;
  }
  function keepEngineParams() {
    const keep = new URLSearchParams();
    for (const k of ["lib", "image", "engine"]) if (qs.get(k)) keep.set(k, qs.get(k));
    const s = keep.toString();
    return s ? "?" + s : "";
  }

  // ── Relay socket: hello + heartbeat + sandbox.op servicing ───────────
  let ws = null;
  let engine = null;
  let engineReady = null;
  let engineError = null;
  let vmReady = false;
  let hbTimer = null;
  let reconnectTimer = null;
  let wsAttempt = 0;
  let currentRecord = null;
  const MAX_PAIRING_ATTEMPTS = 5;

  function stopSocketTimers() {
    if (hbTimer) { clearInterval(hbTimer); hbTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  }

  function connect(record) {
    currentRecord = record;
    stopSocketTimers();
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = proto + "//" + location.host + "/agents/runtime/_attach?access_token=" +
      encodeURIComponent(record.token);
    setStatus("ws", "warn", "connecting…");
    ws = new WebSocket(url);
    const socket = ws;
    let opened = false;
    socket.onopen = () => {
      opened = true;
      wsAttempt = 0;
      setStatus("ws", "ok", "connected");
      socket.send(JSON.stringify({
        type: "hello", agents: [], version: VERSION,
        hostname: "browser:" + location.hostname, os: "browser",
      }));
      if (hbTimer) clearInterval(hbTimer);
      hbTimer = setInterval(() => {
        try { socket.send(JSON.stringify({ type: "ping" })); } catch { /* closing */ }
      }, HEARTBEAT_MS);
    };
    socket.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "sandbox.op") void handleOp(msg);
    };
    socket.onclose = () => {
      if (socket !== ws) return; // superseded by a newer socket
      stopSocketTimers();
      if (!opened) wsAttempt++;
      // A socket that never opens means the token was rejected. Retrying a
      // dead token forever is how a tab ends up looking connected-ish while
      // no agent can ever reach it — drop the pairing and say so instead.
      if (!opened && wsAttempt >= MAX_PAIRING_ATTEMPTS) {
        try { localStorage.removeItem(LS_KEY); } catch { /* private mode */ }
        setStatus("reg", "err", "pairing rejected or expired");
        setStatus("ws", "err", "not connected — reopen this tab from the Console");
        logLine("pairing rejected " + wsAttempt + "x — stored token cleared", "err");
        return;
      }
      const delay = Math.min(30000, 1000 * Math.pow(2, Math.min(wsAttempt, 5)));
      setStatus("ws", "err", "disconnected — retrying in " + Math.round(delay / 1000) + "s");
      reconnectTimer = setTimeout(() => connect(record), delay);
    };
    socket.onerror = () => { try { socket.close(); } catch { /* already */ } };
  }

  // A frozen (bfcache) or offline tab never runs its reconnect timer, so it
  // silently stops being a sandbox host while still looking fine on screen.
  // Re-arm on every signal that the tab is live and reachable again.
  function ensureConnected() {
    if (!currentRecord) return;
    if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
    if (wsAttempt >= MAX_PAIRING_ATTEMPTS) return;
    stopSocketTimers();
    connect(currentRecord);
  }
  window.addEventListener("pageshow", (ev) => { if (ev.persisted) ensureConnected(); });
  window.addEventListener("online", ensureConnected);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    ensureConnected();
    void pollGuest();
  });
  // Hand the relay a clean close on navigate-away so it stops routing ops
  // here instead of waiting out the heartbeat window.
  window.addEventListener("pagehide", () => {
    stopSocketTimers();
    try { ws && ws.close(1001, "sandbox tab closing"); } catch { /* already */ }
  });

  async function handleOp(msg) {
    const startedAt = Date.now();
    if (msg.session_id) {
      const s = monitor.sessions.get(msg.session_id) || { count: 0, lastOp: null, lastAt: null };
      s.count++; s.lastOp = msg.op; s.lastAt = startedAt;
      monitor.sessions.set(msg.session_id, s);
      // Long-lived tabs serve many sessions; evict the least-recent so the
      // map (and the table it renders) can't grow without bound.
      while (monitor.sessions.size > MAX_TRACKED_SESSIONS) {
        let oldestId = null, oldestAt = Infinity;
        for (const [id, v] of monitor.sessions) {
          if (v.lastAt < oldestAt) { oldestAt = v.lastAt; oldestId = id; }
        }
        monitor.sessions.delete(oldestId);
      }
    }
    const reply = (ok, result, error) => {
      const frame = {
        type: "sandbox.result",
        request_id: msg.request_id,
        session_id: msg.session_id,
        ok,
      };
      if (msg.tenant_id) frame.tenant_id = msg.tenant_id;
      if (ok) frame.result = result;
      else frame.error = error;
      try { ws.send(JSON.stringify(frame)); } catch { /* socket died */ }
      recordActivity({ at: startedAt, op: msg.op, sessionId: msg.session_id, ok, durationMs: Date.now() - startedAt });
    };
    logLine(msg.op + " " + (msg.command || msg.path || ""), "op");
    try {
      if (!engineReady) throw new Error(
        "no VM image configured in this browser sandbox tab — set the libv86.js and image " +
        "URLs on the tab (or open it with ?lib=&image=) and reload",
      );
      if (engineError) throw new Error("browser sandbox VM failed to boot: " + engineError);
      await engineReady;
      switch (msg.op) {
        case "exec": {
          const timeoutMs = (msg.timeout_seconds || 120) * 1000;
          reply(true, await engine.exec(String(msg.command || ""), timeoutMs));
          break;
        }
        case "readFile":
          reply(true, { content: await engine.readFile(String(msg.path || "")) });
          break;
        case "writeFile": {
          const path = String(msg.path || "");
          const content = String(msg.content ?? "");
          await engine.writeFile(path, content);
          void opfsWrite(path, content);
          reply(true, {});
          break;
        }
        case "setEnvVars":
          await engine.setEnvVars(msg.envVars || {});
          reply(true, {});
          break;
        case "destroy":
          // One tab can host several sessions against one VM, so a session
          // teardown must not tear down the engine. Drop the session's
          // bookkeeping and acknowledge.
          if (msg.session_id) monitor.sessions.delete(msg.session_id);
          logLine("session " + (msg.session_id || "?") + " released (VM kept for other sessions)");
          reply(true, {});
          break;
        default:
          reply(false, null, "unsupported op: " + String(msg.op));
      }
    } catch (e) {
      logLine("op failed: " + e.message, "err");
      reply(false, null, e.message || String(e));
    }
  }

  // ── Self-test: real guest exec after boot (not just agent-driven ops) ─
  async function runSelfTest() {
    const status = $("self-test-status");
    const btn = $("btn-self-test");
    if (!engine || !vmReady) {
      if (status) status.textContent = "fail: VM not ready";
      logLine("self-test skipped: VM not ready", "err");
      return false;
    }
    if (btn) btn.disabled = true;
    if (status) status.textContent = "running…";
    logLine("self-test: exec true", "op");
    try {
      const r1 = await engine.exec("true", 30000);
      if (r1.exit_code !== 0) {
        throw new Error("true exited " + r1.exit_code + (r1.stderr ? ": " + r1.stderr : ""));
      }
      logLine("self-test: exec echo oma-self-test-ok", "op");
      const r2 = await engine.exec("echo oma-self-test-ok", 30000);
      if (r2.exit_code !== 0) {
        throw new Error("echo exited " + r2.exit_code);
      }
      const out = String(r2.stdout || "");
      if (out.indexOf("oma-self-test-ok") === -1) {
        throw new Error("echo output missing marker (got " + JSON.stringify(out.slice(0, 80)) + ")");
      }
      if (status) status.textContent = "pass — guest exec ok";
      logLine("self-test passed", "op");
      return true;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (status) status.textContent = "fail: " + msg;
      logLine("self-test failed: " + msg, "err");
      return false;
    } finally {
      if (btn) btn.disabled = !vmReady;
    }
  }

  // ── boot sequence ────────────────────────────────────────────────────
  function bootEngine(engineName) {
    const factory = ENGINES[engineName];
    engine = factory ? factory() : null;
    if (!engine) {
      const cfg = readEngineConfig();
      $("cfg-lib").value = cfg.lib;
      $("cfg-image").value = cfg.image;
      $("engine-setup").hidden = false;
      setStatus("vm", "err", engineName + " — no image configured");
      setBootPhase("failed", "no image configured");
      renderMonitor();
      return;
    }
    const cfg = readEngineConfig();
    imageDiag.url = resolveImageUrlForFetch(cfg.image);
    imageDiag.kind = classifyV86Media(imageDiag.url);
    setBootPhase("starting", engineName);
    renderImageDiag();
    setStatus("vm", "warn", engineName + " booting…");
    engineReady = engine.boot()
      .then(() => opfsRestore(engine))
      .then(async () => {
        vmReady = true;
        setStatus("vm", "ok", engineName + " ready");
        logLine("VM ready");
        if (engine.hasBase64 === false) {
          logLine("warning: guest has neither base64 nor openssl — file reads/writes will fail", "err");
        }
        monitor.bootAt = Date.now();
        startMonitorPolling();
        initTerminal();
        if ($("btn-self-test")) $("btn-self-test").disabled = false;
        // Auto self-test once so the activity log proves the guest shell
        // without waiting for an agent session.
        await runSelfTest();
      })
      .catch((e) => {
        engineError = e.message || String(e);
        setStatus("vm", "err", "boot failed: " + engineError);
        setBootPhase("failed", engineError);
        logLine("VM boot failed: " + engineError, "err");
        renderMonitor();
        throw e;
      });
    // handleOp awaits engineReady, but if no op ever arrives nothing else
    // observes the rejection — keep the failure reportable without letting
    // it surface as an unhandled promise rejection.
    engineReady.catch(() => undefined);
  }

  (async () => {
    renderBanner();
    if (!crossOriginIsolated) {
      logLine("warning: page is not cross-origin isolated — SharedArrayBuffer engines will fail", "err");
    }
    const engineName = qs.get("engine") || "v86";
    monitor.engineName = engineName;
    $("cfg-save").addEventListener("click", () => {
      const lib = $("cfg-lib").value.trim(), image = $("cfg-image").value.trim();
      if (!lib || !image) { logLine("both a libv86.js URL and an image URL are required", "err"); return; }
      saveEngineConfig({ lib, image });
      // v86 can only be instantiated once per page, so re-read config on a
      // fresh load rather than hot-swapping engines under in-flight ops.
      location.reload();
    });
    if ($("btn-show-setup")) {
      $("btn-show-setup").addEventListener("click", () => {
        const cfg = readEngineConfig();
        $("cfg-lib").value = cfg.lib;
        $("cfg-image").value = cfg.image;
        $("engine-setup").hidden = false;
        $("cfg-image").focus();
      });
    }
    if ($("btn-self-test")) {
      $("btn-self-test").addEventListener("click", () => { void runSelfTest(); });
    }
    bootEngine(engineName);
    try {
      const record = await register();
      connect(record);
    } catch (e) {
      logLine(String(e.message || e), "err");
    }
  })();
})();
</script>
</body>
</html>`;

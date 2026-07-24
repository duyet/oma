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
 *      (packages/sandbox/src/adapters/browser-vm.ts) awaits;
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

browserVmHostRoutes.get("/", (c) => {
  return c.html(HOST_PAGE_HTML, 200, {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cache-Control": "no-store",
  });
});

export default browserVmHostRoutes;

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
    --bg: #fafaf9; --fg: #1c1917; --muted: #78716c; --card: #ffffff;
    --line: #e7e5e4; --ok: #16a34a; --warn: #d97706; --err: #dc2626;
    --accent: #4f46e5; --mono: ui-monospace, SFMono-Regular, Menlo, monospace;
    /* Monitor panel — amber-primary / neutral shadcn tokens (apps/web preset). */
    --mon-primary: oklch(0.555 0.163 48.998);
    --mon-primary-fg: oklch(0.987 0.022 95.277);
    --mon-mono: "JetBrains Mono Variable", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --mon-radius: 8px;
    --mon-radius-sm: 5px;
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

  /* ── Monitor panel ─────────────────────────────────────────────────── */
  .mon-h2 { font-size: 14px; font-weight: 600; letter-spacing: 0.02em;
    text-transform: uppercase; color: var(--muted); margin: 28px 0 10px; }
  .mon-h2:first-of-type { margin-top: 32px; }
  .mon-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
  @media (max-width: 620px) { .mon-grid { grid-template-columns: 1fr; } }
  .mon-card { background: var(--card); border: 1px solid var(--line);
    border-radius: var(--mon-radius); padding: 14px 16px; margin-bottom: 14px; }
  .mon-title { font-size: 12px; font-weight: 600; color: var(--muted);
    text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 10px; }
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
    text-transform: uppercase; letter-spacing: 0.02em; font-size: 10px;
    padding: 0 6px 6px; border-bottom: 1px solid var(--line); }
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

  <div class="card">
    <div class="row"><span class="k">Registration</span><span class="dot" id="d-reg"></span><span class="v" id="s-reg">initializing…</span></div>
    <div class="row"><span class="k">Relay socket</span><span class="dot" id="d-ws"></span><span class="v" id="s-ws">—</span></div>
    <div class="row"><span class="k">VM engine</span><span class="dot" id="d-vm"></span><span class="v" id="s-vm">—</span></div>
    <div class="row"><span class="k">Runtime id</span><span class="v" id="s-rid">—</span></div>
  </div>

  <div class="card" id="engine-hint" hidden>
    <div class="warnbox">No VM image configured. Pass <code>?lib=&lt;libv86.js URL&gt;&amp;image=&lt;v86 state/iso URL&gt;</code>
    (assets must be CORS-accessible — this page is cross-origin isolated).
    Until a VM boots, sandbox ops fail with a clear error instead of hanging.</div>
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
  const HEARTBEAT_MS = 25000;
  const VERSION = "browser-vm-host/1";

  // ── tiny UI helpers ──────────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  function setStatus(which, cls, text) {
    $("d-" + which).className = "dot" + (cls ? " " + cls : "");
    $("s-" + which).textContent = text;
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
    lastPollError: null,
  };

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
    $("mon-uptime").textContent = monitor.bootAt ? fmtDuration((Date.now() - monitor.bootAt) / 1000) : "not booted";
    $("mon-guest-uptime").textContent = monitor.guestUptimeSec != null ? fmtDuration(monitor.guestUptimeSec) : "—";

    // Processes
    const psStatus = $("mon-ps-status");
    psStatus.textContent = monitor.lastPollError ? "(" + monitor.lastPollError + ")" : "";
    const psEl = $("mon-ps");
    if (!monitor.psRows || monitor.psRows.length === 0) {
      psEl.innerHTML = "";
      const empty = document.createElement("div");
      empty.className = "mon-empty";
      empty.textContent = engineReady ? "no process data yet" : "VM not booted";
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
    monitor.pollTimer = setInterval(pollGuest, 3000);
    void pollGuest();
    setInterval(renderMonitor, 1000); // ticks the uptime clock even between polls
  }
  async function pollGuest() {
    if (!engine || !engineReady) return;
    if (document.hidden) return;
    try {
      await engineReady;
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
  function initTerminal() {
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

  // v86 engine: boots a Linux image and drives the serial console. Commands
  // are wrapped in sentinel markers; file content crosses the console as
  // base64 so binary-ish text survives the TTY.
  class V86Engine {
    constructor(libUrl, imageUrl) {
      this.libUrl = libUrl;
      this.imageUrl = imageUrl;
      this.emulator = null;
      this.serialBuf = "";
      this.waiters = [];
      this.env = {};
    }
    async boot() {
      await new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = this.libUrl;
        s.crossOrigin = "anonymous";
        s.onload = resolve;
        s.onerror = () => reject(new Error("failed to load libv86.js from " + this.libUrl));
        document.head.appendChild(s);
      });
      const base = this.libUrl.replace(/[^/]*$/, "");
      const isState = /\\.bin(\\.zst)?$|state/i.test(this.imageUrl);
      const opts = {
        wasm_path: base + "v86.wasm",
        memory_size: 128 * 1024 * 1024,
        vga_memory_size: 4 * 1024 * 1024,
        screen_container: document.getElementById("v86-screen"),
        autostart: true,
        disable_keyboard: true,
        disable_mouse: true,
      };
      if (isState) opts.initial_state = { url: this.imageUrl };
      else opts.cdrom = { url: this.imageUrl };
      this.emulator = new window.V86(opts);
      this.emulator.add_listener("serial0-output-byte", (byte) => {
        this.serialBuf += String.fromCharCode(byte);
        if (this.serialBuf.length > 4 * 1024 * 1024) this.serialBuf = this.serialBuf.slice(-2 * 1024 * 1024);
        for (const w of this.waiters.slice()) w();
      });
      // Wait for a shell: poke enter until an echo round-trips.
      const deadline = Date.now() + 180000;
      for (;;) {
        if (Date.now() > deadline) throw new Error("VM did not reach a shell within 180s");
        try {
          this.emulator.serial0_send("\\n");
          await this.rawRoundTrip("echo __oma_boot__", "__oma_boot__", 5000);
          break;
        } catch { /* still booting */ }
      }
      await this.rawRoundTrip("stty -echo; mkdir -p /workspace; cd /workspace; echo __oma_ready__", "__oma_ready__", 15000);
    }
    rawRoundTrip(cmd, marker, timeoutMs) {
      const start = this.serialBuf.length;
      this.emulator.serial0_send(cmd + "\\n");
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { drop(); reject(new Error("serial timeout: " + marker)); }, timeoutMs);
        const check = () => {
          const idx = this.serialBuf.indexOf(marker, start);
          if (idx === -1) return;
          clearTimeout(timer); drop();
          resolve(this.serialBuf.slice(start, idx));
        };
        const drop = () => { this.waiters = this.waiters.filter((w) => w !== check); };
        this.waiters.push(check);
        check();
      });
    }
    async exec(command, timeoutMs) {
      const id = Math.random().toString(36).slice(2, 10);
      const done = "__oma_done_" + id + "_";
      // Env vars are re-exported per exec (serial shell has one session, but
      // stay defensive against VM-side shell restarts).
      const exports = Object.entries(this.env)
        .map(([k, v]) => "export " + k + "=" + shq(v)).join("; ");
      const script = (exports ? exports + "; " : "") +
        "{ " + command + "\\n} > /tmp/.oma_out 2> /tmp/.oma_err; " +
        "printf '" + done + "%s\\\\n' $?";
      const pre = await this.rawRoundTrip(script, done, timeoutMs);
      void pre;
      const tail = this.serialBuf.slice(this.serialBuf.indexOf(done) + done.length);
      const exitCode = parseInt(tail, 10);
      const stdout = await this.readFile("/tmp/.oma_out").catch(() => "");
      const stderr = await this.readFile("/tmp/.oma_err").catch(() => "");
      return { exit_code: Number.isFinite(exitCode) ? exitCode : -1, stdout, stderr };
    }
    async readFile(path) {
      const id = Math.random().toString(36).slice(2, 10);
      const m0 = "__oma_b64s_" + id + "__", m1 = "__oma_b64e_" + id + "__";
      const out = await this.rawRoundTrip(
        "echo " + m0 + "; base64 " + shq(path) + " 2>/dev/null || openssl base64 -in " + shq(path) + "; echo " + m1,
        m1, 30000,
      );
      const s = out.indexOf(m0);
      if (s === -1) throw new Error("readFile framing lost");
      const b64 = out.slice(s + m0.length).replace(/[^A-Za-z0-9+/=]/g, "");
      // Symmetric with writeFile's UTF-8-safe encode — bare atob() would
      // return Latin-1 bytes and mojibake any non-ASCII file/exec output.
      return decodeURIComponent(escape(atob(b64)));
    }
    async writeFile(path, content) {
      const b64 = btoa(unescape(encodeURIComponent(content)));
      const id = Math.random().toString(36).slice(2, 10);
      const done = "__oma_w_" + id + "__";
      let script = "mkdir -p $(dirname " + shq(path) + "); : > " + shq(path) + ".b64";
      for (let i = 0; i < b64.length; i += 2000) {
        script += "; printf %s '" + b64.slice(i, i + 2000) + "' >> " + shq(path) + ".b64";
      }
      script += "; base64 -d " + shq(path) + ".b64 > " + shq(path) +
        " 2>/dev/null || openssl base64 -d -in " + shq(path) + ".b64 -out " + shq(path) +
        "; rm -f " + shq(path) + ".b64; echo " + done;
      await this.rawRoundTrip(script, done, 60000);
    }
    async setEnvVars(env) { Object.assign(this.env, env); }
    async destroy() {
      try { this.emulator && this.emulator.destroy(); } catch { /* gone */ }
      this.emulator = null;
    }
  }
  function shq(s) { return "'" + String(s).replace(/'/g, "'\\\\''") + "'"; }

  const ENGINES = {
    v86: () => {
      const lib = qs.get("lib");
      const image = qs.get("image");
      if (!lib || !image) return null;
      return new V86Engine(lib, image);
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
  async function register() {
    const stored = JSON.parse(localStorage.getItem(LS_KEY) || "null");
    if (stored && stored.token) {
      setStatus("reg", "ok", "registered (stored token)");
      $("s-rid").textContent = stored.runtime_id;
      return stored;
    }
    const code = qs.get("code"), state = qs.get("state");
    if (!code || !state) {
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
      setStatus("reg", "err", "exchange failed: " + body.slice(0, 200));
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

  function connect(record) {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const url = proto + "//" + location.host + "/agents/runtime/_attach?access_token=" +
      encodeURIComponent(record.token);
    setStatus("ws", "warn", "connecting…");
    ws = new WebSocket(url);
    let hb = null;
    ws.onopen = () => {
      setStatus("ws", "ok", "connected");
      ws.send(JSON.stringify({
        type: "hello", agents: [], version: VERSION,
        hostname: "browser:" + location.hostname, os: "browser",
      }));
      hb = setInterval(() => {
        try { ws.send(JSON.stringify({ type: "ping" })); } catch { /* closing */ }
      }, HEARTBEAT_MS);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "sandbox.op") void handleOp(msg);
    };
    ws.onclose = () => {
      clearInterval(hb);
      setStatus("ws", "err", "disconnected — retrying in 3s");
      setTimeout(() => connect(record), 3000);
    };
    ws.onerror = () => { try { ws.close(); } catch { /* already */ } };
  }

  async function handleOp(msg) {
    const startedAt = Date.now();
    if (msg.session_id) {
      const s = monitor.sessions.get(msg.session_id) || { count: 0, lastOp: null, lastAt: null };
      s.count++; s.lastOp = msg.op; s.lastAt = startedAt;
      monitor.sessions.set(msg.session_id, s);
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
        "no VM engine configured in this tab — reopen the sandbox tab with ?lib=&image= (v86) set",
      );
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

  // ── boot sequence ────────────────────────────────────────────────────
  (async () => {
    if (!crossOriginIsolated) {
      logLine("warning: page is not cross-origin isolated — SharedArrayBuffer engines will fail", "err");
    }
    const engineName = qs.get("engine") || "v86";
    monitor.engineName = engineName;
    const factory = ENGINES[engineName];
    engine = factory ? factory() : null;
    if (!engine) {
      $("engine-hint").hidden = false;
      setStatus("vm", "warn", engineName + " (unconfigured)");
      renderMonitor();
    } else {
      setStatus("vm", "warn", engineName + " booting…");
      engineReady = engine.boot()
        .then(() => opfsRestore(engine))
        .then(() => {
          setStatus("vm", "ok", engineName + " ready");
          logLine("VM ready");
          monitor.bootAt = Date.now();
          startMonitorPolling();
          initTerminal();
        })
        .catch((e) => {
          setStatus("vm", "err", "boot failed: " + e.message);
          logLine("VM boot failed: " + e.message, "err");
          renderMonitor();
          throw e;
        });
    }
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

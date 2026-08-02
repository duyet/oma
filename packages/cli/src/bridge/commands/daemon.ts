/**
 * `oma bridge daemon` — long-running reverse-WS to the control plane.
 *
 * Slice 1 scope: register, report manifest, heartbeat. No session spawning
 * yet — that lands in slice 2 (handle `session.start` / `session.prompt`
 * messages from the server, route to ACP agents, stream events back).
 *
 * Reconnect: exponential backoff capped at 60s. Heartbeat: 5min interval.
 * The daemon process never exits on transport errors — only on SIGTERM /
 * SIGINT (clean shutdown) or unrecoverable bugs (creds file missing /
 * malformed). Under launchd, even those exits get restarted within ~10s
 * thanks to KeepAlive=true.
 */

import { hostname } from "node:os";
import { join } from "node:path";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { readCreds, readSettings } from "../lib/config.js";
import { osTag, currentProfile, paths } from "../lib/platform.js";
import { detectAll, loadRegistry } from "@duyet/oma-acp-runtime/registry";
import { SessionManager } from "../lib/session-manager.js";
import { BridgeSandboxManager, createOpenShellBackend } from "../lib/bridge-sandbox.js";
import { resolveSandboxBackend } from "../lib/sandbox-backend.js";
import { resolveOpenShellTlsFromEnv } from "../lib/openshell-client.js";
import { detectLocalSkills } from "../lib/local-skills.js";
import { attachAgentVersions } from "../lib/agent-versions.js";

/**
 * Build the agent roster reported in the `hello` manifest: which ACP agents
 * are on $PATH (detectAll), each annotated with a best-effort self-reported
 * `--version` (fail-soft → omitted when unknown). Probes run in parallel with
 * a short timeout so a hung binary can't stall the heartbeat.
 */
async function buildAgentRoster(): Promise<
  Array<{ id: string; binary: string; version?: string }>
> {
  const detected = await detectAll();
  return attachAgentVersions(
    detected.map((a) => ({ id: a.id, binary: a.spec.command, wraps: a.wraps })),
  ).then((rows) =>
    // Drop the internal `wraps` field — the platform only needs id/binary/version.
    rows.map(({ id, binary, version }) => (version ? { id, binary, version } : { id, binary })),
  );
}
import { printBanner, log, c } from "../lib/style.js";
import { PKG_VERSION } from "../lib/version.js";
import { nextBackoff } from "../lib/reconnect.js";
import { writeDaemonState, type DaemonState } from "../lib/daemon-state.js";
import { bumpRelay } from "../../counters.js";
import WebSocket from "ws";

// CF Workers WS connections to *.workers.dev (lane URLs) idle out fast —
// observed ~5-30s before TCP RST without keep-alive traffic. Even prod custom
// domains drop within minutes of silence. Send a small ping every 25s so the
// connection stays warm without burning much bandwidth or DO CPU.
const HEARTBEAT_INTERVAL_MS = 25 * 1000;
const RECONNECT_BACKOFF_MIN_MS = 1000;
const RECONNECT_BACKOFF_MAX_MS = 60 * 1000;
// If the server hasn't sent ANY frame (pong / welcome / session.*) within
// this window, the socket is presumed half-open — the OS hasn't surfaced the
// TCP break yet, but the daemon is effectively deaf. We proactively terminate
// so the reconnect loop can re-establish a live connection instead of silently
// sitting on a dead socket for minutes. Tuned to ~2.5 missed heartbeats.
const LIVENESS_TIMEOUT_MS = 70 * 1000;


export async function runDaemon(): Promise<void> {
  const creds = await readCreds();
  if (!creds) {
    process.stderr.write(
      "✗ no credentials. Run `oma bridge setup` first.\n",
    );
    process.exit(2);
  }

  const profile = currentProfile();
  const profileTag = profile ? `  [profile=${profile}]` : "";
  printBanner(`daemon — runtime ${creds.runtimeId.slice(0, 8)}… → ${creds.serverUrl}${profileTag}`, PKG_VERSION);

  // Warm the merged ACP registry cache (official @cdn.agentclientprotocol.com
  // + OMA overlay) once at startup. All downstream sync resolveKnownAgent /
  // detect / detectAll calls in this process then read from the cached
  // merged list. Network failure here is non-fatal — registry-fetch falls
  // back to disk cache, then to overlay-only; the daemon must keep working
  // for users on planes / dev networks.
  const cachePath = join(paths().configDir, "registry-cache.json");
  await loadRegistry({ cachePath });

  // Convert https:// → wss:// (or http→ws for dev). The exchange flow
  // wrote whatever scheme the user passed via --server-url to setup.
  const wsBase = creds.serverUrl.replace(/^http(s?):\/\//, "ws$1://").replace(/\/$/, "");
  const wsUrl = `${wsBase}/agents/runtime/_attach`;

  let backoffBaseMs = 0;

  // Live snapshot of daemon health, flushed to daemon-state.json so
  // `oma bridge status` (a separate process) can report connectivity +
  // heartbeat freshness. Best-effort; never gates the session loop.
  const state: DaemonState = {
    pid: process.pid,
    startedAt: Date.now(),
    attachedAt: null,
    lastHeartbeatAt: null,
    connected: false,
    tenantCount: creds.tenants.length,
  };
  const flushState = () => writeDaemonState(state);

  // Graceful shutdown: drain in-flight turns up to 10s, then dispose
  // (which keeps spawn cwds so ACP recovery via session/load works on
  // the next session.start). Mirrors the cloud agent's DO-eviction
  // recovery model — see SessionManager.drain() for the full flow.
  // A second signal escapes immediately; the user wants out NOW. The
  // 10s deadline is tuned to launchd's default ExitTimeOut of 20s — we
  // drain for 10, plus ~2s grace + ~1s of dispose, leaving headroom
  // before launchd would SIGKILL us.
  const DRAIN_DEADLINE_MS = 10_000;
  let draining = false;
  let stopping = false;
  const stop = (sig: string, force = false) => {
    if (stopping) return;
    if (draining && !force) {
      // Second signal during drain → escalate to force.
      log.warn(`${sig} again — abandoning drain, exiting now`);
      stopping = true;
      try { unlinkSync(join(paths().configDir, "daemon.pid")); } catch { /* missing */ }
      try { unlinkSync(join(paths().configDir, "daemon-state.json")); } catch { /* missing */ }
      void sessions.disposeAll();
      // Force path: don't wait — the user asked to exit NOW. Remote boxes
      // (openshell) may leak; that's the price of the second signal.
      void sandboxes.destroyAll();
      if (currentWs) {
        try { currentWs.close(1000, "shutdown"); } catch { /* already closing */ }
      }
      return;
    }
    draining = true;
    log.step(`${sig} received, draining (${DRAIN_DEADLINE_MS / 1000}s deadline; sessions recover via session/load on reconnect)`);
    try { unlinkSync(join(paths().configDir, "daemon.pid")); } catch { /* missing or perms */ }
    try { unlinkSync(join(paths().configDir, "daemon-state.json")); } catch { /* missing or perms */ }
    void (async () => {
      const r = await sessions.drain(DRAIN_DEADLINE_MS, {
        onProgress: (active, msLeft) => {
          log.hint(`${active} turns active, ${Math.ceil(msLeft / 1000)}s left`);
        },
      }).catch((e) => {
        log.err(`drain failed: ${(e as Error).message}`);
        return { initialTurns: 0, abortedTurns: 0, sessions: 0 };
      });
      const naturallyCompleted = r.initialTurns - r.abortedTurns;
      if (r.abortedTurns > 0) {
        log.warn(
          `deadline reached — aborted ${r.abortedTurns} in-flight turn(s); ` +
            `they'll resume via ACP session/load when the server reconnects`,
        );
      }
      log.ok(
        `drained ${r.sessions} session(s) (${naturallyCompleted}/${r.initialTurns} turns completed cleanly)`,
      );
      stopping = true;
      // Awaited (bounded internally) so an openshell box actually gets its
      // DeleteSandbox before the process goes away.
      await sandboxes.destroyAll();
      if (currentWs) {
        try { currentWs.close(1000, "shutdown"); } catch { /* already closing */ }
      }
    })();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  // Write a pid file so `oma bridge agents refresh` can find this process
  // by profile (paths().configDir is profile-aware) and signal it. Best-
  // effort: a missing pid file just means the refresh verb degrades to
  // "daemon not found" — daemon itself keeps working.
  try {
    mkdirSync(paths().configDir, { recursive: true });
    writeFileSync(join(paths().configDir, "daemon.pid"), String(process.pid), "utf-8");
  } catch (e) {
    process.stderr.write(`! pid file write failed (non-fatal): ${(e as Error).message}\n`);
  }
  flushState();

  // SIGHUP — `oma bridge agents refresh` AND `oma bridge refresh`. Both
  // are side-channel reloads: do NOT touch the WS, do NOT restart
  // sessions, do NOT kill ACP children. Two things to refresh:
  //   1. Agent detection — re-fetch official ACP registry, re-snapshot
  //      npm/uv installs, re-scan local skills, re-send the hello
  //      manifest so the relay reflects new wrappers the user installed.
  //   2. Per-tenant credentials — re-read the creds file and push the
  //      updated tenant key map into SessionManager so newly-authorized
  //      tenants become sessionable without a daemon restart. The creds
  //      file may also have been replaced with a new token via setup
  //      --force, but we deliberately DON'T reattach the WS here — the
  //      next reconnect cycle picks the new token up. (Tenant key
  //      changes happen far more often than token rotation, and reloading
  //      keys with stale `creds` in scope is harmless because the WS
  //      uses the original auth bearer only.)
  process.on("SIGHUP", () => {
    void (async () => {
      log.step("SIGHUP — refreshing agent detection + credentials");
      try {
        const freshCreds = await readCreds();
        if (freshCreds) {
          sessions.setTenantKeys(freshCreds.tenants);
          state.tenantCount = freshCreds.tenants.length;
          flushState();
          log.ok(`re-loaded credentials  (${freshCreds.tenants.length} tenants)`);
        } else {
          log.warn("credentials file disappeared mid-SIGHUP; tenant keys unchanged");
        }
        await loadRegistry({ cachePath, forceRefresh: true });
        const agents = await buildAgentRoster();
        const localSkillsDetailed = await detectLocalSkills();
        const localSkills: Record<string, Array<{ id: string; name?: string; description?: string; source: string; source_label?: string }>> = {};
        for (const [agentId, skills] of Object.entries(localSkillsDetailed)) {
          if (!skills) continue;
          localSkills[agentId] = skills.map(({ path: _path, ...rest }) => rest);
        }
        if (currentWs && currentWs.readyState === WebSocket.OPEN) {
          currentWs.send(JSON.stringify({
            type: "hello",
            machine_id: creds.machineId,
            hostname: hostname(),
            os: osTag(),
            version: PKG_VERSION,
            agents,
            local_skills: localSkills,
          }));
          log.ok(`re-published manifest  (${agents.length} agents)`);
        } else {
          log.warn("WS not attached — manifest will be re-sent on next connect");
        }
      } catch (e) {
        log.warn(`refresh failed: ${(e as Error).message}`);
      }
    })();
  });

  let currentWs: WebSocket | null = null;
  // SessionManager survives WS drops — keeps the ACP child processes alive
  // so a brief network blip doesn't kill in-progress conversations. Each
  // WS attach calls setSender() to point at the new socket.
  const sessions = new SessionManager(() => {
    /* placeholder — replaced on first attach via setSender */
  });
  // Wire daemon's identity into SessionManager so it can fetch session
  // bundles from main and stamp the right per-tenant API key onto ACP
  // children's MCP proxy auth (no spawn-env LLM key — user manages that
  // themselves). The per-tenant `oma_*` keys come from setTenantKeys
  // below, NOT from setSpawnEnv — keys live in a tenant-keyed map so a
  // multi-tenant daemon can hand the right one to each spawned ACP
  // child based on the session's tenant_id pin.
  sessions.setSpawnEnv({
    apiUrl: creds.serverUrl,
    runtimeToken: creds.token,
  });
  sessions.setTenantKeys(creds.tenants);

  // Relayed sandbox ops for cloud agents with a *local* environment. Like
  // SessionManager it survives WS drops (per-session workdirs persist); each
  // attach re-points its sender at the new socket via setSend().
  //
  // Which substrate runs those ops is an explicit opt-in (daemon settings or
  // BRIDGE_SANDBOX_BACKEND) — see lib/sandbox-backend.ts for why there is no
  // "gateway is installed → use it" auto-detect here. Log the resolved
  // backend + reason once so the choice is visible in the daemon log.
  const backendSel = resolveSandboxBackend(process.env, await readSettings());
  const sandboxes = new BridgeSandboxManager(
    () => {
      /* placeholder — replaced on first attach via setSend */
    },
    backendSel.kind === "openshell"
      ? {
          backend: createOpenShellBackend({
            endpoint: backendSel.endpoint!,
            token: process.env.OPENSHELL_TOKEN,
            image: process.env.OPENSHELL_IMAGE,
            tls: resolveOpenShellTlsFromEnv(process.env),
            logger: { warn: (m) => log.warn(m), log: (m) => log.step(m) },
          }),
        }
      : undefined,
  );
  log.ok(
    `sandbox backend: ${c.cyan(backendSel.kind)}` +
      `${backendSel.kind === "openshell" ? ` → ${backendSel.endpoint}` : ""}  ${c.dim(backendSel.reason)}`,
  );

  while (!stopping) {
    try {
      const ws = new WebSocket(wsUrl, {
        headers: { Authorization: `Bearer ${creds.token}` },
      });
      currentWs = ws;

      await waitOpen(ws);
      backoffBaseMs = 0;
      log.ok(`attached to ${c.cyan(wsBase)}`);

      // Track the last frame we heard from the server. Any inbound message
      // (pong / welcome / session.*) counts as proof the socket is live;
      // the watchdog below terminates it if this goes stale.
      let lastServerActivityAt = Date.now();
      state.attachedAt = Date.now();
      state.connected = true;
      flushState();

      const agents = await buildAgentRoster();
      // Scan local skill dirs (~/.claude/skills/, ~/.claude/plugins/*/skills/)
      // so the platform can show users what's available + let them blocklist
      // specific skills per-agent. Strips the absolute `path` field — the
      // platform doesn't need to know the user's home layout.
      const localSkillsDetailed = await detectLocalSkills();
      const localSkills: Record<string, Array<{ id: string; name?: string; description?: string; source: string; source_label?: string }>> = {};
      for (const [agentId, skills] of Object.entries(localSkillsDetailed)) {
        if (!skills) continue;
        localSkills[agentId] = skills.map(({ path: _path, ...rest }) => rest);
      }
      ws.send(JSON.stringify({
        type: "hello",
        machine_id: creds.machineId,
        hostname: hostname(),
        os: osTag(),
        version: PKG_VERSION,
        agents,
        local_skills: localSkills,
      }));
      // Re-announce any sessions we were running before the WS drop.
      // First-attach this is a no-op (no sessions yet).
      sessions.announceAll();

      const heartbeat = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        // Half-open detection: the server pongs every ping, so a silent
        // gap wider than LIVENESS_TIMEOUT_MS means the connection is dead
        // even though the OS hasn't RST'd it yet. Force a close to kick
        // the reconnect loop rather than keep a deaf socket alive.
        const silentMs = Date.now() - lastServerActivityAt;
        if (silentMs > LIVENESS_TIMEOUT_MS) {
          log.warn(`no server traffic for ${Math.round(silentMs / 1000)}s — connection stale, forcing reconnect`);
          try { ws.terminate(); } catch { /* already gone */ }
          return;
        }
        ws.send(JSON.stringify({ type: "ping" }));
        state.lastHeartbeatAt = Date.now();
        flushState();
      }, HEARTBEAT_INTERVAL_MS);

      // Re-point SessionManager at the new socket. Sessions from the prior
      // attach are still alive (their ACP children kept running across the
      // WS drop). Re-announce them so the server's session_state cache
      // gets refreshed and any browser that reattaches sees ready again.
      sessions.setSender((msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      });
      sandboxes.setSend((msg) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      });

      ws.on("message", (data: Buffer) => {
        // Any frame from the server proves the socket is alive — refresh
        // the liveness clock before we even parse it.
        lastServerActivityAt = Date.now();
        let msg: { type?: string; [k: string]: unknown };
        try { msg = JSON.parse(data.toString()); } catch { return; }
        process.stderr.write(`← server: ${msg.type ?? "?"}\n`);
        switch (msg.type) {
          case "welcome":
          case "pong":
            return;
          case "session.start":
            process.stderr.write(`  session.start sid=${(msg.session_id as string)?.slice(0, 8)} agent=${msg.agent_id}\n`);
            bumpRelay();
            void sessions.start(msg as never);
            return;
          case "session.prompt":
            void sessions.prompt(msg as never);
            return;
          case "session.cancel":
            sessions.cancel(msg.session_id as string, msg.turn_id as string);
            return;
          case "session.dispose":
            void sessions.dispose(msg.session_id as string);
            return;
          case "sandbox.op":
            void sandboxes.handle(msg as never);
            return;
          default:
            process.stderr.write(`! unhandled server message: ${msg.type ?? "?"}\n`);
        }
      });

      // Wait until the WS closes (clean shutdown or transport drop).
      await new Promise<void>((resolve) => {
        ws.once("close", (code, reason) => {
          clearInterval(heartbeat);
          state.connected = false;
          flushState();
          log.step(`WS closed  ${c.dim(`code=${code} reason=${reason?.toString() || "—"}`)}`);
          resolve();
        });
      });

      // Lost the WS but keep the ACP children alive — they'll be
      // reachable again on the next successful attach. Backoff loop
      // continues below.
    } catch (e) {
      log.warn(`WS attach failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    if (stopping) break;
    const { delayMs, baseMs } = nextBackoff(backoffBaseMs, {
      minMs: RECONNECT_BACKOFF_MIN_MS,
      maxMs: RECONNECT_BACKOFF_MAX_MS,
    });
    backoffBaseMs = baseMs;
    log.step(`reconnecting in ${delayMs}ms`);
    await sleep(delayMs);
  }

  log.step("daemon exited");
  process.exit(0);
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onUnexpected = (_req: unknown, res: { statusCode?: number }) => {
      cleanup();
      reject(new Error(`unexpected response: HTTP ${res.statusCode}`));
    };
    const cleanup = () => {
      ws.removeListener("open", onOpen);
      ws.removeListener("error", onError);
      ws.removeListener("unexpected-response", onUnexpected as never);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("unexpected-response", onUnexpected as never);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

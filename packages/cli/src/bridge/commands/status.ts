/**
 * `oma bridge status` — print local creds + (best-effort) ping the server
 * to verify the runtime is reachable and the token is still valid.
 *
 * No daemon process discovery (would require platform-specific PID files
 * or `launchctl list` parsing). Status is "do you have a creds file" +
 * "does the server still know about you" — for "is the daemon process
 * actually running" the user can check `launchctl list | grep oma`
 * (macOS), `systemctl --user status dev.oma.bridge` (Linux),
 * `schtasks /query /tn dev.oma.bridge` (Windows), or look at the logs.
 */

import { readCreds, readSettings } from "../lib/config.js";
import { resolveSandboxBackend } from "../lib/sandbox-backend.js";
import { probeOpenShellGateway, resolveOpenShellTlsFromEnv } from "../lib/openshell-client.js";
import { paths, currentProfile } from "../lib/platform.js";
import { detectServiceKind } from "../lib/service-manager.js";
import { printBanner, log, c, sym } from "../lib/style.js";
import { PKG_VERSION } from "../lib/version.js";
import { probeRuntimeToken } from "../lib/probe.js";
import { readDaemonState, isPidAlive, formatAge } from "../lib/daemon-state.js";
import { fetchRuntimeSessions, renderSessionsTable } from "../lib/sessions-probe.js";
import { readCounters } from "../../counters.js";

export async function runStatus(): Promise<void> {
  const profile = currentProfile();
  const profileTag = profile ? `  [profile=${profile}]` : "";
  printBanner(`status${profileTag}`, PKG_VERSION);
  const p = paths();
  const creds = await readCreds();

  if (!creds) {
    log.warn("not set up — run `oma bridge setup` to register this machine");
    log.hint(`looked for ${p.credsFile}`);
    process.exit(1);
  }

  const kind = detectServiceKind();
  const row = (k: string, v: string) =>
    process.stderr.write(`  ${c.dim(k.padEnd(11))} ${v}\n`);
  row("server",     creds.serverUrl);
  row("runtime_id", creds.runtimeId);
  row("machine_id", creds.machineId);
  row("registered", new Date(creds.createdAt * 1000).toISOString());
  row("creds file", c.dim(p.credsFile));
  row("log file",   c.dim(p.logFile));
  row("service",    c.dim(`${kind}${p.serviceFile ? ` → ${p.serviceFile}` : ""}`));

  // Authorized workspaces — the daemon can spawn ACP children for any of
  // these. Empty (or a lone `__unknown__` stub from an offline v1→v2
  // migration) means the user should run `oma bridge refresh`.
  if (creds.tenants.length > 0) {
    const names = creds.tenants
      .map((t) => (t.id === "__unknown__" ? c.yellow(`${t.name} (unresolved)`) : t.name))
      .join(", ");
    row("workspaces", `${creds.tenants.length}  ${c.dim(names)}`);
  } else {
    row("workspaces", c.yellow("none — run `oma bridge refresh`"));
  }

  // Local daemon liveness, read from the daemon-state file it flushes on
  // start / attach / heartbeat. This answers "is the background process
  // actually running and connected right now" without shelling out to
  // launchctl / systemctl.
  const dstate = readDaemonState();
  if (!dstate) {
    row("daemon", c.yellow("not running (no state file — start via `oma bridge setup` or `oma bridge daemon`)"));
  } else if (!isPidAlive(dstate.pid)) {
    row("daemon", c.yellow(`stale (pid ${dstate.pid} not alive — service may be restarting)`));
  } else {
    const conn = dstate.connected ? c.green("connected") : c.yellow("disconnected");
    const hb = dstate.lastHeartbeatAt
      ? `heartbeat ${formatAge(Date.now() - dstate.lastHeartbeatAt)}`
      : "no heartbeat yet";
    const up = `up ${formatAge(Date.now() - dstate.startedAt).replace(/ ago$/, "")}`;
    row("daemon", `${conn}  ${c.dim(`pid ${dstate.pid} · ${hb} · ${up}`)}`);
  }

  // Which substrate executes relayed sandbox ops. This is the main way a user
  // confirms isolation is really on, so for openshell we also probe the
  // gateway — "configured" and "reachable" are different claims.
  const backend = resolveSandboxBackend(process.env, await readSettings());
  if (backend.kind === "openshell") {
    const up = await probeOpenShellGateway(backend.endpoint!, resolveOpenShellTlsFromEnv(process.env));
    row(
      "sandbox",
      `${c.green("openshell")} ${c.dim(backend.endpoint!)}  ` +
        `${up ? c.green("reachable") : c.yellow("unreachable")}  ${c.dim(backend.reason)}`,
    );
  } else {
    row("sandbox", `subprocess ${c.dim("(host filesystem, no isolation) · " + backend.reason)}`);
  }

  // Local activity counters (best-effort, observability-only). "today"
  // fields roll over at local midnight; totals are lifetime.
  const counters = readCounters();
  row(
    "activity",
    `${c.dim("relayed")} ${counters.relayedToday} today ${c.dim(`(${counters.relayedTotal} total)`)}  ${c.dim("· commands")} ${counters.commandsToday} today ${c.dim(`(${counters.commandsTotal} total)`)}`,
  );

  process.stderr.write("\n");
  log.step("probing server");
  const probe = await probeRuntimeToken(creds.serverUrl, creds.token);
  if (probe.ok) {
    log.ok("token accepted (server reachable)");
  } else if (probe.reason === "invalid") {
    process.stderr.write(
      `  ${sym.err()} ${c.red(`server no longer recognises this runtime (${probe.detail})`)}\n`,
    );
    log.hint("run `oma bridge setup --force` to re-register");
    process.exit(1);
  } else {
    process.stderr.write(`  ${sym.err()} ${c.red(`probe failed: ${probe.detail}`)}\n`);
    process.exit(1);
  }
  process.stderr.write("\n");

  // Running sessions on this machine's runtime. Best-effort: reconstructed
  // client-side (no server-side runtime filter) by listing each authorized
  // workspace's agents bound to this runtime, then its running sessions.
  // Any unreachable/unauthorized workspace is skipped with a dim note — it
  // must never turn a healthy `status` into a failure.
  log.step("running sessions");
  const sessions = await fetchRuntimeSessions(creds);
  if (!sessions.ok) {
    log.hint(sessions.note ?? "unavailable");
  } else {
    if (sessions.note) log.hint(sessions.note);
    for (const line of renderSessionsTable(sessions.rows, { baseUrl: creds.serverUrl })) {
      process.stderr.write(`${line}\n`);
    }
  }
  process.stderr.write("\n");
}

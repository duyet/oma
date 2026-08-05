/**
 * `oma bridge pair` — one-shot non-interactive pairing.
 *
 * Companion to the daemon's self-pair branch (daemon.ts): reads a pairing
 * code + state from the environment (or `--code` / `--state` flags), redeems
 * them against `/agents/runtime/exchange`, persists the resulting v2
 * credentials, prints the new runtime id, and exits. Intended for k8s / CI
 * where `oma bridge setup`'s browser OAuth can't run — the chart's
 * `pairing.existingSecret` values block injects the same env the daemon's
 * self-pair path reads, so this command is what the chart's init loop runs
 * before exec'ing into the daemon.
 *
 * Exit codes: 0 on success, 2 on missing inputs or exchange failure.
 */

import { hostname } from "node:os";
import { writeCreds, getOrCreateMachineId } from "../lib/config.js";
import { osTag, currentProfile } from "../lib/platform.js";
import { pairNonInteractive } from "../lib/pair.js";
import { printBanner, log, c } from "../lib/style.js";
import { PKG_VERSION } from "../lib/version.js";
import { paths } from "../lib/platform.js";

export interface PairCommandOpts {
  /** API root. Defaults to OMA_SERVER_URL env or the public prod instance. */
  serverUrl: string;
  /** Pairing code. Defaults to OMA_PAIRING_CODE env. */
  code?: string;
  /** Pairing state token. Defaults to OMA_PAIRING_STATE env. */
  state?: string;
}

export async function runPair(opts: PairCommandOpts): Promise<void> {
  const serverUrl = opts.serverUrl;
  const code = opts.code ?? process.env.OMA_PAIRING_CODE;
  const state = opts.state ?? process.env.OMA_PAIRING_STATE;

  if (!code || !state) {
    process.stderr.write(
      "✗ missing pairing code. Set OMA_PAIRING_CODE + OMA_PAIRING_STATE\n" +
        "  (or pass --code / --state), minted by POST /v1/runtimes/pairing-token.\n",
    );
    process.exit(2);
  }

  const profile = currentProfile();
  const profileTag = profile ? `  [profile=${profile}]` : "";
  printBanner(`pair — redeem pairing code against ${serverUrl}${profileTag}`, PKG_VERSION);

  const machineId = process.env.OMA_MACHINE_ID ?? (await getOrCreateMachineId());
  let creds;
  try {
    creds = await pairNonInteractive({
      serverUrl,
      pairingCode: code,
      pairingState: state,
      hostname: process.env.OMA_HOSTNAME ?? hostname(),
      os: osTag(),
      machineId,
      version: PKG_VERSION,
    });
  } catch (e) {
    process.stderr.write(
      `✗ pairing failed: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    // Match setup.ts's force-exit pattern — undici keep-alive sockets can
    // otherwise hold the process open for ~5min after a failed exchange.
    setImmediate(() => process.exit(2));
    return;
  }

  await writeCreds(creds);
  log.ok(`runtime registered  ${c.dim(creds.runtimeId.slice(0, 8) + "…")}  (${creds.tenants.length} workspaces authorized)`);
  log.ok(`credentials written  ${c.dim(paths().credsFile)}`);
  log.hint("next: `oma bridge daemon` (or `oma bridge setup --no-service` to install + start).");
  setImmediate(() => process.exit(0));
}

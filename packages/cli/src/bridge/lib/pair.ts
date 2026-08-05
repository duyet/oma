/**
 * Non-interactive runtime pairing — redeem a pairing code without a browser.
 *
 * The normal `oma bridge setup` flow is OAuth: the daemon process binds a
 * localhost socket, opens a browser to the Console, and waits for the
 * browser to redirect back with a one-time `code`. That works on a laptop,
 * not in a Kubernetes pod or CI shell where there is no user to click
 * "Allow this machine".
 *
 * Track 2 of the k8s-registration feature ships a second code type on the
 * backend — `k8s_pairing` — minted by `POST /v1/runtimes/pairing-token` and
 * multi-use within its TTL. The daemon redeems it via the same
 * `/agents/runtime/exchange` endpoint (no browser callback), using env vars
 * the chart injects from a Secret. See `POST /agents/runtime/exchange` in
 * apps/main/src/routes/runtimes.ts for the server side.
 *
 * This module is pure fetch + mapping. The hostname / os / version fields
 * are passed in by the caller (daemon self-pair and the one-shot `oma bridge
 * pair` command both reuse `osTag()` + `PKG_VERSION` from their own site) so
 * the only I/O this module does is the exchange HTTP call.
 */

import type { CredentialsV2 } from "./config.js";

/** Shape returned by `/agents/runtime/exchange` when `multi_tenant: true`. */
interface ExchangeResponse {
  runtime_id: string;
  token: string;
  /** v2 shape — one entry per (runtime, tenant) pair. */
  tenants: Array<{ id: string; name: string; role: string; agent_api_key: string }>;
}

export interface PairOpts {
  /** API root, e.g. "https://app.oma.duyet.net". */
  serverUrl: string;
  /** Pairing code from `POST /v1/runtimes/pairing-token` (`kind: "k8s_pairing"`). */
  pairingCode: string;
  /** Server-issued state token that accompanies the code. */
  pairingState: string;
  /** Reported `hostname` for the runtime row. */
  hostname: string;
  /** Reported `os` tag (e.g. "linux/arm64"). */
  os: string;
  /** Stable per-user machine fingerprint. */
  machineId: string;
  /** CLI version, reported to the server as `version`. */
  version: string;
}

/**
 * Redeem a pairing code against `/agents/runtime/exchange` and map the v2
 * response to `CredentialsV2`. Throws on non-2xx or non-JSON response — the
 * caller (daemon or `oma bridge pair`) surfaces the error message.
 *
 * Body shape mirrors `setup.ts:postExchange` exactly:
 * `{ code, state, machine_id, hostname, os, version, multi_tenant: true }`,
 * so the server's code-type dispatch (`oauth` vs `k8s_pairing`) is the only
 * thing that differs from the interactive path.
 */
export async function pairNonInteractive(opts: PairOpts): Promise<CredentialsV2> {
  const url = `${opts.serverUrl.replace(/\/$/, "")}/agents/runtime/exchange`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: opts.pairingCode,
      state: opts.pairingState,
      machine_id: opts.machineId,
      hostname: opts.hostname,
      os: opts.os,
      version: opts.version,
      // Opt into the v2 multi-tenant response — server returns one entry
      // per (runtime, tenant) pair instead of a single legacy agent_api_key.
      multi_tenant: true,
    }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`exchange failed: HTTP ${res.status}: ${text}`);
  }
  let body: ExchangeResponse;
  try {
    body = JSON.parse(text) as ExchangeResponse;
  } catch {
    throw new Error(`exchange returned non-JSON: ${text.slice(0, 200)}`);
  }
  return {
    v: 2,
    serverUrl: opts.serverUrl,
    runtimeId: body.runtime_id,
    token: body.token,
    tenants: body.tenants.map((t) => ({
      id: t.id,
      name: t.name,
      agentApiKey: t.agent_api_key,
    })),
    machineId: opts.machineId,
    createdAt: Math.floor(Date.now() / 1000),
  };
}

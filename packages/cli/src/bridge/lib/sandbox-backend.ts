/**
 * Which substrate executes relayed sandbox ops on this machine.
 *
 *   subprocess  — the default. `child_process` on the host filesystem: the
 *                 agent sees the user's real repos, toolchains, and CLI
 *                 auth, with zero isolation. That is the whole point of a
 *                 "local" environment.
 *   openshell   — ops run inside an OpenShell sandbox on this machine:
 *                 isolated, gateway-enforced egress, and EMPTY — none of
 *                 the user's files or tools are visible.
 *
 * Selection precedence:
 *   1. persisted daemon settings (`oma bridge setup` writes them),
 *   2. `BRIDGE_SANDBOX_BACKEND=openshell|subprocess`,
 *   3. subprocess.
 *
 * NOTE — deliberate divergence from `resolveBridgeBackendKind`
 * (apps/k8s-bridge/src/backend.ts), which flips to OpenShell as soon as
 * OPENSHELL_GATEWAY_ENDPOINT is present. That rule is safe for a dedicated
 * in-cluster deployment and unsafe on a laptop: a user who installed
 * OpenShell for unrelated reasons would silently flip their daemon and every
 * agent would lose sight of their real repos and toolchains. So: explicit
 * opt-in only, NO endpoint-presence auto-detect.
 */

import { DEFAULT_OPENSHELL_ENDPOINT } from "./openshell-client.js";

export type SandboxBackendKind = "subprocess" | "openshell";

export interface SandboxBackendSettings {
  /** Persisted choice from `oma bridge setup`. */
  sandboxBackend?: SandboxBackendKind;
  /** Persisted gateway endpoint (`host:port`). */
  openshellEndpoint?: string;
}

export interface SandboxBackendSelection {
  kind: SandboxBackendKind;
  /** Human-readable reason, safe to log as-is. */
  reason: string;
  /** Gateway endpoint — only meaningful when kind === "openshell". */
  endpoint?: string;
}

export function resolveSandboxBackend(
  env: Record<string, string | undefined>,
  settings?: SandboxBackendSettings | null,
): SandboxBackendSelection {
  const endpoint =
    settings?.openshellEndpoint || env.OPENSHELL_GATEWAY_ENDPOINT || DEFAULT_OPENSHELL_ENDPOINT;

  const configured = settings?.sandboxBackend;
  if (configured === "openshell") {
    return { kind: "openshell", reason: "daemon config: sandboxBackend=openshell", endpoint };
  }
  if (configured === "subprocess") {
    return { kind: "subprocess", reason: "daemon config: sandboxBackend=subprocess" };
  }

  const v = (env.BRIDGE_SANDBOX_BACKEND ?? "").trim().toLowerCase();
  if (v === "openshell") {
    return { kind: "openshell", reason: "BRIDGE_SANDBOX_BACKEND=openshell (explicit)", endpoint };
  }
  if (v === "subprocess" || v === "local") {
    return { kind: "subprocess", reason: `BRIDGE_SANDBOX_BACKEND=${v} (explicit)` };
  }

  return { kind: "subprocess", reason: "default (host subprocess; no explicit opt-in)" };
}

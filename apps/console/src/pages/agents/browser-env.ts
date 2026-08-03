/**
 * Browser runtime mode for the agent form.
 *
 * "Browser" is not a harness — it's the `browser-vm` sandbox provider
 * (docs/browser-vm-sandbox.md): the session's sandbox ops are relayed to a
 * WASM VM running in a browser tab the user opens. The harness stays the
 * cloud one. So the form expresses the choice as "this agent prefers a
 * browser-vm environment", stored on the agent's `metadata` (an existing,
 * arbitrary API field) and honoured by the session-create flows.
 */

export const BROWSER_VM_PROVIDER = "browser-vm";

/** Agent metadata key holding the environment new sessions should default to. */
export const DEFAULT_ENV_METADATA_KEY = "default_environment_id";

export interface EnvironmentLite {
  id: string;
  name: string;
  config?: { sandbox_provider?: string; type?: string } | null;
}

/** `sandbox_provider` wins over the legacy `type` field, matching
 *  `resolveCfSandbox` and the rest of the console (lib/sandboxTab.ts). */
export function isBrowserVmEnvironment(env: EnvironmentLite): boolean {
  const provider = env.config?.sandbox_provider ?? env.config?.type;
  return provider === BROWSER_VM_PROVIDER;
}

export function browserVmEnvironments(envs: EnvironmentLite[]): EnvironmentLite[] {
  return envs.filter(isBrowserVmEnvironment);
}

/** Body for creating a browser-vm environment from the agent form. Both
 *  fields are set because readers differ on which one they consult. */
export function newBrowserEnvironmentBody(name = "Browser VM") {
  return {
    name,
    description: "Runs sessions against a WASM VM in a paired browser tab.",
    config: { type: BROWSER_VM_PROVIDER, sandbox_provider: BROWSER_VM_PROVIDER },
  };
}

/**
 * Environment a new session for this agent should start on: the agent's own
 * preference when it declares one, else the caller's existing default (the
 * single-environment shortcut). Returns "" when the user still has to pick.
 */
export function preferredEnvironmentId(
  metadata: Record<string, unknown> | undefined,
  fallback: string | null,
): string {
  const preferred = metadata?.[DEFAULT_ENV_METADATA_KEY];
  if (typeof preferred === "string" && preferred) return preferred;
  return fallback ?? "";
}

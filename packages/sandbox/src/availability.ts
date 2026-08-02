// Per-deployment provider availability — the "why can't I use this?" answer.
//
// `/v1/hosting_types` used to list only the providers that happened to be
// *seeded* (see `seedSystemProviders`), so a provider that can't run on this
// deployment simply vanished from the Console with no explanation. That's the
// least useful failure mode: an operator looking for "k8s" on a Cloudflare
// deployment sees nothing and can't tell whether they mistyped it, whether
// it's unsupported, or whether they forgot a secret.
//
// This module answers that question for every id in SYSTEM_PROVIDERS, from
// data we actually have: the descriptor's `cfCompatible` / `nodeCompatible`
// flags, `classifyCfSandboxProvider`, the descriptor's `envKeys`, and the
// runtime's own env map. Pure / no I/O, so it's unit-testable and safe to
// call from a Worker.

import { SYSTEM_PROVIDERS, classifyCfSandboxProvider } from "./provider-config";

/** Which of the two deployments is answering. */
export type DeploymentRuntime = "cloudflare" | "node";

export type ProviderAvailabilityState =
  /** Wired on this deployment and configured — sessions can select it. */
  | "available"
  /** Supported here, but a required secret / binding isn't set yet. */
  | "needs_config"
  /** Cannot run on this deployment at all, no matter the configuration. */
  | "unavailable";

export interface ProviderAvailability {
  state: ProviderAvailabilityState;
  /** Human-readable, safe to render verbatim. Always set. */
  reason: string;
  /** Env vars that would move a `needs_config` provider to `available`. */
  missing_env?: string[];
}

/**
 * Providers whose adapters are architecturally Worker-safe (pure fetch) but
 * whose driver SDKs aren't bundled into the single-file Worker script, so
 * selecting them on Cloudflare fails at session start. Documented in
 * AGENTS.md's sandbox-provider table; both work on the self-host Node
 * runtime.
 */
const CF_UNBUNDLED_PROVIDERS = new Set(["daytona", "e2b"]);

/**
 * Cloudflare-side secret names that gate an otherwise-wired remote provider.
 * These are `wrangler secret put` values rather than the descriptor's
 * `envKeys` (which describe the Node runtime's env), so they're listed
 * separately — the CF resolver reads exactly these.
 * See `resolveCfSandbox` (apps/agent/src/runtime/sandbox.ts).
 */
const CF_REQUIRED_SECRETS: Record<string, string> = {
  boxrun: "BOXRUN_URL",
  "k8s-remote": "K8S_SANDBOX_GATEWAY_URL",
  openshell: "OPENSHELL_BRIDGE_URL",
  "k8s-bridge": "K8S_BRIDGE_URL",
};

export interface AvailabilityInput {
  /** Provider id (`SystemProviderDescriptor.type`), or a BYOK config's type. */
  providerId: string;
  runtime: DeploymentRuntime;
  /** Runtime env / secrets, `process.env`-shaped. */
  env: Record<string, string | undefined>;
  /**
   * Cloudflare only: whether the Worker Loader (`LOADER`) binding is present.
   * `dynamic-workers` needs it and there is no env var that stands in for it.
   */
  hasWorkerLoader?: boolean;
}

/**
 * Classify one provider for one deployment. Never throws; an id this build
 * doesn't know about is reported as available-but-unverified rather than
 * invented as broken (BYOK providers register types we don't ship).
 */
export function describeProviderAvailability(input: AvailabilityInput): ProviderAvailability {
  const { providerId, runtime, env } = input;
  const desc = SYSTEM_PROVIDERS.find((p) => p.type === providerId);
  if (!desc) {
    return {
      state: "available",
      reason: "Custom provider — availability is determined by its own configuration.",
    };
  }

  return runtime === "cloudflare"
    ? describeForCloudflare(desc.type, desc.label, env, input.hasWorkerLoader === true)
    : describeForNode(desc.type, desc.label, env);
}

function describeForCloudflare(
  type: string,
  label: string,
  env: Record<string, string | undefined>,
  hasWorkerLoader: boolean,
): ProviderAvailability {
  if (type === "dynamic-workers") {
    return hasWorkerLoader
      ? { state: "available", reason: "The Worker Loader (LOADER) binding is present." }
      : {
          state: "unavailable",
          reason:
            "Needs the Worker Loader (LOADER) binding, which this Worker doesn't have. " +
            "Add a `worker_loaders` entry to wrangler.jsonc (the binding is entitlement-gated).",
        };
  }

  const resolution = classifyCfSandboxProvider(type);

  if (resolution.kind === "bridge") {
    return {
      state: "available",
      reason:
        type === "browser-vm"
          ? "Relayed to a paired browser sandbox tab over the RuntimeRoom WebSocket. Open a tab to run work here."
          : "Relayed to a paired machine running `oma bridge daemon` over the RuntimeRoom WebSocket.",
    };
  }

  if (resolution.kind === "unavailable") {
    return {
      state: "unavailable",
      reason: `${label} is Node-only — it needs a Node builtin (child_process, a native binding, or local kubeconfig/filesystem access) that a Cloudflare Worker doesn't have, and there is no relay path. Use the self-host Node runtime instead.`,
    };
  }

  if (CF_UNBUNDLED_PROVIDERS.has(type)) {
    return {
      state: "unavailable",
      reason: `${label}'s driver SDK isn't bundled into the Cloudflare Worker, so selecting it here fails at session start. It works on the self-host Node runtime.`,
    };
  }

  const secret = CF_REQUIRED_SECRETS[type];
  if (secret && !env[secret]) {
    return {
      state: "needs_config",
      reason: `Requires the ${secret} secret. Set it with \`wrangler secret put ${secret}\` — without it, sessions selecting ${label} fail with a session.error.`,
      missing_env: [secret],
    };
  }

  return { state: "available", reason: `${label} is wired on this Cloudflare deployment.` };
}

function describeForNode(
  type: string,
  label: string,
  env: Record<string, string | undefined>,
): ProviderAvailability {
  const desc = SYSTEM_PROVIDERS.find((p) => p.type === type)!;

  if (desc.nodeCompatible === false) {
    return {
      state: "unavailable",
      reason: `${label} is Cloudflare-only — it depends on a Worker binding with no Node equivalent. Deploy on Cloudflare to use it.`,
    };
  }

  if (type === "browser-vm") {
    return {
      state: "unavailable",
      reason:
        "Browser sandbox tabs relay through the RuntimeRoom Durable Object, which only exists on the Cloudflare deployment.",
    };
  }

  // litebox's env keys are tunables (memory/cpu), not credentials — absent
  // just means defaults, so it's never "needs_config". Same rationale as
  // `checkProviderRequirements`.
  if (desc.envKeys.length > 0 && type !== "litebox") {
    const missing = desc.envKeys.filter((k) => !env[k]);
    if (missing.length === desc.envKeys.length) {
      return {
        state: "needs_config",
        reason: `Not configured — set ${missing.join(" or ")} in this runtime's environment to enable ${label}.`,
        missing_env: missing,
      };
    }
  }

  return { state: "available", reason: `${label} is wired on this self-host Node runtime.` };
}

/**
 * One `/v1/hosting_types` row. Both runtimes build these; the fields mirror
 * what the Console's provider cards read.
 */
export interface HostingTypeEntry {
  id: string;
  label: string;
  description: string;
  type: "system" | "byok";
  provider: string;
  external: boolean;
  capabilities: string[];
  health: unknown;
  availability: ProviderAvailability;
}

/**
 * Rows for every provider this build ships that the registry did *not* seed
 * — the ones that used to silently vanish from the Console. They carry no
 * health (nothing was probed) but always carry an availability reason.
 *
 * `seededTypes` is the set of `SandboxProviderConfig.type` values already in
 * the response, so a seeded provider is never duplicated.
 */
export function buildUnseededHostingTypes(
  seededTypes: Set<string>,
  runtime: DeploymentRuntime,
  env: Record<string, string | undefined>,
  opts: { hasWorkerLoader?: boolean } = {},
): HostingTypeEntry[] {
  const rows: HostingTypeEntry[] = [];
  for (const desc of SYSTEM_PROVIDERS) {
    if (seededTypes.has(desc.type)) continue;
    rows.push({
      id: desc.type,
      label: desc.label,
      description: desc.description,
      type: "system",
      provider: desc.type,
      external: !["subprocess", "cloud", "browser-vm"].includes(desc.type),
      capabilities: [...desc.capabilities],
      health: null,
      availability: describeProviderAvailability({
        providerId: desc.type,
        runtime,
        env,
        hasWorkerLoader: opts.hasWorkerLoader,
      }),
    });
  }
  return rows;
}

/**
 * Availability for every provider this build knows about, keyed by id — the
 * shape `/v1/hosting_types` merges into its response so the Console can show
 * providers that are *not* seeded alongside the ones that are.
 */
export function describeAllProviderAvailability(
  runtime: DeploymentRuntime,
  env: Record<string, string | undefined>,
  opts: { hasWorkerLoader?: boolean } = {},
): Map<string, ProviderAvailability> {
  const out = new Map<string, ProviderAvailability>();
  for (const desc of SYSTEM_PROVIDERS) {
    out.set(
      desc.type,
      describeProviderAvailability({
        providerId: desc.type,
        runtime,
        env,
        hasWorkerLoader: opts.hasWorkerLoader,
      }),
    );
  }
  return out;
}

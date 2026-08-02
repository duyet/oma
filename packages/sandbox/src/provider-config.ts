// Provider configuration — the BYOK (bring your own key) contract.
//
// Each SandboxProviderConfig holds everything needed to create sandbox
// executors: adapter type, API key (user-provided or system), endpoint URL,
// and provider-specific tunables. Multiple provider configs can coexist;
// environments select one by ID instead of the old single SANDBOX_PROVIDER.
//
// System providers are seeded from env vars at startup (e.g. DAYTONA_API_KEY
// → a provider config with isSystem=true). User providers are added via
// POST /v1/sandbox_providers and persisted.

import type { SandboxFactory, SandboxFactoryContext, SandboxExecutor } from "./ports";

/**
 * A single sandbox provider registration.
 */
export interface SandboxProviderConfig {
  /** Unique provider id — used in environment `config.sandbox_provider`. */
  id: string;
  /** Adapter type: "subprocess" | "litebox" | "boxrun" | "daytona" | "e2b" | "k8s" | "cloud". */
  type: string;
  /** Human-readable label (e.g. "My Daytona account"). */
  label: string;
  /** Optional longer description. */
  description?: string;
  /** User-provided API key (BYOK). Empty for system providers that read env vars directly. */
  apiKey?: string;
  /** Custom base URL for the provider's API. */
  baseURL?: string;
  /** Provider-specific settings (image, memory, cpu, namespace, etc.). */
  config?: Record<string, string>;
  /** When true, this config was seeded from env vars and cannot be deleted. */
  isSystem: boolean;
  /** Tenant scope — null for system-wide, set for tenant-scoped BYOK. */
  tenantId?: string;
  /** Timestamps. */
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Resolved provider — a config paired with its import factory.
 * The factory is loaded once and cached so subsequent sandbox creates
 * skip the dynamic import.
 */
export interface ResolvedSandboxProvider {
  config: SandboxProviderConfig;
  factory: SandboxFactory;
}

// ─── System provider key map ─────────────────────────────────────────
//
// Maps adapter type → { envKeys: string[], factoryPath: string }.
// Used to seed system providers from process.env at startup and to
// generate the hosting_types response.

export interface SystemProviderDescriptor {
  /** Adapter type string (matches adapter file name). */
  type: string;
  /** Human label. */
  label: string;
  /** Short description for hosting_types / docs. */
  description: string;
  /** Env vars this provider reads. First one found seeds the provider. */
  envKeys: string[];
  /** Dynamic import path for the factory. */
  factoryPath: string;
  /**
   * Human-readable capability tags surfaced in the Console provider
   * cards. Each tag advertises a feature the sandbox adapter supports.
   * Standard values: "exec", "files", "pause_resume", "cf_compatible".
   */
  capabilities: string[];
  /**
   * Whether this adapter is architecturally capable of running inside a
   * Cloudflare Worker: pure outbound HTTP/fetch calls, no Node-only
   * builtins (child_process, native FFI bindings, local kubeconfig/
   * filesystem access). `false` means the adapter cannot run in a Worker
   * at all, regardless of bundling — a session configured for it on the
   * Cloudflare deployment must fail clearly, not silently fall back.
   * See `classifyCfSandboxProvider` below and
   * apps/agent/src/runtime/sandbox.ts's `resolveCfSandbox`, which reads
   * this flag (not the registry's lazy `import(factoryPath)` — that path
   * uses a runtime-variable import target, which esbuild can't statically
   * bundle for a single-file Worker script, so it's Node-only in practice).
   */
  cfCompatible: boolean;
}

export const SYSTEM_PROVIDERS: SystemProviderDescriptor[] = [
  {
    type: "subprocess",
    label: "Local subprocess",
    description: "Node child_process on the host. Zero isolation — trusted local dev only.",
    envKeys: [],
    factoryPath: "@duyet/oma-sandbox/adapters/local-subprocess",
    cfCompatible: false,
    capabilities: ["exec", "files"],
  },
  {
    type: "litebox",
    label: "LiteBox (local micro-VM)",
    description: "Local Firecracker micro-VM per box. Hardware isolation, no daemon.",
    envKeys: ["LITEBOX_MEMORY_MIB"],
    factoryPath: "@duyet/oma-sandbox/adapters/litebox",
    cfCompatible: false,
    capabilities: ["exec", "files", "pause_resume"],
  },
  {
    type: "boxrun",
    label: "BoxRun (remote micro-VM)",
    description: "Talks to a remote BoxLite HTTP control plane — hardware isolation without local KVM.",
    envKeys: ["BOXRUN_URL", "BOXRUN_TOKEN"],
    factoryPath: "@duyet/oma-sandbox/adapters/boxrun",
    cfCompatible: true,
    capabilities: ["exec", "files", "pause_resume"],
  },
  {
    type: "daytona",
    label: "Daytona",
    description: "Daytona SaaS — a managed Linux VM per session. Requires DAYTONA_API_KEY.",
    envKeys: ["DAYTONA_API_KEY", "DAYTONA_API_URL"],
    factoryPath: "@duyet/oma-sandbox/adapters/daytona",
    cfCompatible: true,
    capabilities: ["exec", "files", "pause_resume"],
  },
  {
    type: "e2b",
    label: "E2B",
    description: "E2B Firecracker microVM per session (~250ms cold from a warm pool). Requires E2B_API_KEY.",
    envKeys: ["E2B_API_KEY", "E2B_API_URL"],
    factoryPath: "@duyet/oma-sandbox/adapters/e2b",
    cfCompatible: true,
    capabilities: ["exec", "files", "pause_resume"],
  },
  {
    type: "k8s",
    label: "Kubernetes",
    description: "Pod provisioned via the kubernetes-sigs agent-sandbox controller.",
    envKeys: ["OMA_K8S_NAMESPACE"],
    factoryPath: "@duyet/oma-sandbox/adapters/kubernetes",
    cfCompatible: false,
    capabilities: ["exec", "files", "pause_resume"],
  },
  {
    type: "k8s-bridge",
    label: "K8s Bridge (remote)",
    description: "Remote sandbox via HTTP bridge to a Kubernetes cluster.",
    envKeys: ["K8S_BRIDGE_URL"],
    factoryPath: "@duyet/oma-sandbox/adapters/k8s-bridge",
    cfCompatible: true,
    capabilities: ["exec", "files", "pause_resume"],
  },
  {
    type: "k8s-remote",
    label: "Kubernetes (remote gateway)",
    description: "Talks to an in-cluster k8s-sandbox-gateway over plain fetch — k8s pods without a Worker-side kubeconfig.",
    envKeys: ["K8S_SANDBOX_GATEWAY_URL", "K8S_SANDBOX_TOKEN"],
    factoryPath: "@duyet/oma-sandbox/adapters/kubernetes-remote",
    cfCompatible: true,
    capabilities: ["exec", "files", "pause_resume"],
  },
  {
    type: "cloud",
    label: "Cloudflare Sandbox",
    description: "Managed sandbox — uses Cloudflare Containers.",
    envKeys: [],
    factoryPath: "", // CF path is direct, not via adapters
    cfCompatible: true,
    capabilities: ["exec", "files", "pause_resume", "cf_compatible"],
  },
  {
    type: "docker-compose",
    label: "Docker Compose",
    description: "Per-session Docker Compose sandbox with docker-compose.yml. Requires a Docker socket.",
    envKeys: ["DOCKER_COMPOSE_PROJECT_DIR"],
    factoryPath: "@duyet/oma-sandbox/adapters/docker-compose",
    cfCompatible: false,
    capabilities: ["exec", "files"],
  },
  {
    type: "github-actions",
    label: "GitHub Actions",
    description: "Run sandbox commands via GitHub Actions workflow_dispatch. Pure fetch, no Node builtins.",
    envKeys: ["GITHUB_ACTIONS_OWNER", "GITHUB_ACTIONS_REPO", "GITHUB_ACTIONS_WORKFLOW", "GITHUB_TOKEN"],
    factoryPath: "@duyet/oma-sandbox/adapters/github-actions",
    cfCompatible: true,
    capabilities: ["exec", "files"],
  },
  {
    type: "remote-agent",
    label: "Remote Agent (BYOK)",
    description: "BYOK remote machine sandbox via a lightweight HTTP agent. Pure fetch, no Node builtins.",
    envKeys: ["REMOTE_AGENT_URL", "REMOTE_AGENT_TOKEN"],
    factoryPath: "@duyet/oma-sandbox/adapters/remote-agent",
    cfCompatible: true,
    capabilities: ["exec", "files", "pause_resume"],
  },
  {
    type: "openshell",
    label: "NVIDIA OpenShell",
    description:
      "NVIDIA OpenShell gateway (gRPC) — policy-enforced, isolated agent sandboxes with credential + network governance. " +
      "Self-host Node talks gRPC directly; the Cloudflare deployment reaches it over plain fetch via the k8s-bridge OpenShell backend (OPENSHELL_BRIDGE_URL).",
    envKeys: ["OPENSHELL_GATEWAY_ENDPOINT"],
    factoryPath: "@duyet/oma-sandbox/adapters/openshell",
    cfCompatible: true,
    capabilities: ["exec", "files"],
  },
  {
    type: "browser-vm",
    label: "Browser VM (WASM)",
    description: "Agent sandbox running as a WASM VM (WebContainers / CheerpX) inside a user's browser tab. Relayed over the RuntimeRoom WebSocket — zero server-side sandbox compute.",
    envKeys: [],
    factoryPath: "@duyet/oma-sandbox/adapters/browser-vm",
    cfCompatible: true,
    capabilities: ["exec", "files"],
  },
];

// ─── Cloudflare-side classification ──────────────────────────────────
//
// The registry's `createExecutor` (registry.ts) lazily resolves adapters
// via `import(desc.factoryPath)`, where `factoryPath` is read off a Map
// entry at runtime — a non-literal import target. esbuild can't statically
// bundle that for a single-file Worker script, and workerd has no runtime
// module resolution to fall back on, so the registry itself cannot be used
// from a Cloudflare Worker. `resolveCfSandbox` in
// apps/agent/src/runtime/sandbox.ts uses `classifyCfSandboxProvider`
// instead, then statically imports only the specific cfCompatible adapters
// it actually wires up.

export type CfSandboxResolution =
  | { kind: "cloudflare" }
  | { kind: "remote"; type: string }
  | { kind: "bridge"; type: string }
  | { kind: "unavailable"; type: string };

/**
 * Classify a `sandbox_provider` id (or legacy `config.type`) for the
 * Cloudflare deployment. Pure / no I/O so it's unit-testable without any
 * Workers runtime.
 *
 *  - absent, `"cloud"`, or an id this registry doesn't recognize →
 *    `{ kind: "cloudflare" }` — degrade to the existing CloudflareSandbox
 *    default rather than hard-failing a misconfigured/unknown id (mirrors
 *    apps/main-node's `resolveEnvProvider` "unknown → fall back" behavior).
 *  - `"subprocess"` (or its alias `"local"`) → `{ kind: "bridge", type:
 *    "subprocess" }`. A Worker can't spawn `child_process`, but on the
 *    Cloudflare deployment we relay these ops to a user-paired local machine
 *    (the `oma bridge daemon`) via the RuntimeRoom DO — see
 *    apps/agent/src/runtime/bridge-relay.ts. Resolution still fails loud (a
 *    clear session.error) when no runtime is online.
 *  - a known id with `cfCompatible: true` → `{ kind: "remote", type }`.
 *  - a known id with `cfCompatible: false` → `{ kind: "unavailable", type }`
 *    (litebox / k8s / docker-compose — Node-only, cannot run in a Worker at
 *    all, and no relay path).
 */
export function classifyCfSandboxProvider(
  providerId: string | undefined | null,
): CfSandboxResolution {
  const id = (providerId ?? "").trim().toLowerCase();
  if (!id || id === "cloud") return { kind: "cloudflare" };
  // Local subprocess environments relay to a paired bridge runtime.
  if (id === "subprocess" || id === "local") return { kind: "bridge", type: "subprocess" };
  // Browser VM environments relay to a user's browser tab over the
  // RuntimeRoom WebSocket — same relay shape as subprocess, different peer.
  if (id === "browser-vm") return { kind: "bridge", type: "browser-vm" };
  const desc = SYSTEM_PROVIDERS.find((p) => p.type === id);
  if (!desc) return { kind: "cloudflare" };
  return desc.cfCompatible ? { kind: "remote", type: id } : { kind: "unavailable", type: id };
}

/**
 * Seed system provider configs from env vars. Returns an array of
 * SandboxProviderConfig, one per adapter type that can be reached
 * with the current env (or always for subprocess/litebox).
 */
export function seedSystemProviders(
  env: Record<string, string | undefined>,
): SandboxProviderConfig[] {
  const providers: SandboxProviderConfig[] = [];

  for (const desc of SYSTEM_PROVIDERS) {
    // subprocess, cloud, and browser-vm are always available — like
    // subprocess, browser-vm needs no env key: reachability is a runtime
    // question (is a paired tab online?), answered per-op by the relay.
    if (desc.type === "subprocess" || desc.type === "cloud" || desc.type === "browser-vm") {
      providers.push({
        id: desc.type,
        type: desc.type,
        label: desc.label,
        description: desc.description,
        isSystem: true,
      });
      continue;
    }

    // Other providers need at least one env key to confirm they're reachable
    if (desc.envKeys.length > 0 && desc.envKeys.some((k) => env[k])) {
      providers.push({
        id: desc.type,
        type: desc.type,
        label: desc.label,
        description: desc.description,
        apiKey: desc.envKeys.length === 1 ? env[desc.envKeys[0]] : undefined,
        isSystem: true,
      });
    }
  }

  return providers;
}

/**
 * Build a flat env map from a provider config, suitable for passing to
 * the adapter factory. Merges the config's apiKey, baseURL, and extras
 * into a single record so factories (which read process.env-shaped maps)
 * work without changes.
 */
export function providerConfigToEnv(config: SandboxProviderConfig): Record<string, string> {
  const env: Record<string, string> = {};

  if (config.apiKey) {
    switch (config.type) {
      case "daytona":
        env.DAYTONA_API_KEY = config.apiKey;
        break;
      case "e2b":
        env.E2B_API_KEY = config.apiKey;
        break;
      case "boxrun":
        env.BOXRUN_TOKEN = config.apiKey;
        break;
      case "k8s-bridge":
        env.K8S_BRIDGE_TOKEN = config.apiKey;
        break;
      case "github-actions":
        env.GITHUB_TOKEN = config.apiKey;
        break;
      case "remote-agent":
        env.REMOTE_AGENT_TOKEN = config.apiKey;
        break;
      case "openshell":
        env.OPENSHELL_TOKEN = config.apiKey;
        break;
    }
  }

  if (config.baseURL) {
    switch (config.type) {
      case "daytona":
        env.DAYTONA_API_URL = config.baseURL;
        break;
      case "e2b":
        env.E2B_API_URL = config.baseURL;
        break;
      case "boxrun":
        env.BOXRUN_URL = config.baseURL;
        break;
      case "k8s-bridge":
        env.K8S_BRIDGE_URL = config.baseURL;
        break;
      case "github-actions":
        env.GITHUB_API_BASE_URL = config.baseURL;
        break;
      case "remote-agent":
        env.REMOTE_AGENT_URL = config.baseURL;
        break;
      case "openshell":
        env.OPENSHELL_GATEWAY_ENDPOINT = config.baseURL;
        break;
      case "docker-compose":
        env.DOCKER_COMPOSE_PROJECT_DIR = config.baseURL;
        break;
    }
  }

  // Provider-specific extras
  if (config.config) {
    for (const [k, v] of Object.entries(config.config)) {
      env[k.toUpperCase()] = v;
    }
  }

  return env;
}

// ─── Default local sandbox auto-detection (OpenShell vs subprocess) ──
//
// When a session's environment has no explicit `sandbox_provider` and the
// deployment has no global SANDBOX_PROVIDER override, main-node has always
// fallen back to the "subprocess" adapter (zero isolation, trusted local
// dev only) — even when an OpenShell gateway is fully configured
// (OPENSHELL_GATEWAY_ENDPOINT set). `resolveDefaultLocalSandboxProvider`
// closes that gap: it prefers OpenShell for that *implicit* default case
// when the gateway is configured AND currently reachable, and only then.
// It never touches an explicit selection (per-environment
// `sandbox_provider` or a set SANDBOX_PROVIDER) — those already work
// today and keep failing loudly if misconfigured, per this repo's
// "explicit selection is trusted, silent fallback is worse than failing
// loud" convention (see AGENTS.md's sub-agent sandbox section).
//
// Pure / DI'd: the actual gRPC reachability probe (network I/O) lives in
// adapters/openshell.ts (`probeOpenShellGateway`) and is passed in by the
// caller, so this function — like `classifyCfSandboxProvider` above — is
// unit-testable without any real network or Workers runtime.

export type LocalSandboxMode = "auto" | "openshell" | "subprocess";

/**
 * Parse the OPENSHELL_MODE override env var.
 *   "auto"       (default, or unset/unrecognized) — probe reachability.
 *   "openshell"  — force OpenShell, skip the probe entirely.
 *   "subprocess" — force subprocess, skip the probe entirely.
 */
export function parseOpenShellMode(raw: string | undefined): LocalSandboxMode {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "openshell" || v === "subprocess") return v;
  return "auto";
}

export interface DefaultProviderSelection {
  /** The provider id to use as the implicit default. */
  providerId: "openshell" | "subprocess";
  /** Human-readable reason, safe to log as-is. */
  reason: string;
}

/**
 * Decide the implicit default sandbox provider (used only when no
 * explicit `sandbox_provider` / SANDBOX_PROVIDER is set) between
 * "openshell" and "subprocess". Deterministic ordering:
 *
 *   1. OPENSHELL_MODE=subprocess → "subprocess", no probe.
 *   2. OPENSHELL_MODE=openshell  → "openshell" if OPENSHELL_GATEWAY_ENDPOINT
 *      is set (no probe — an explicit force is trusted, same as any other
 *      explicit provider selection); "subprocess" (misconfiguration
 *      warning) if the endpoint is missing, since there's nothing to force.
 *   3. auto (default) + no OPENSHELL_GATEWAY_ENDPOINT → "subprocess", no
 *      probe (nothing configured to probe).
 *   4. auto + endpoint set → probe; reachable → "openshell", unreachable
 *      or the probe throwing → "subprocess". The probe call is wrapped so
 *      a throwing probe implementation can never take down session start.
 */
export async function resolveDefaultLocalSandboxProvider(
  env: Record<string, string | undefined>,
  probeReachable: (endpoint: string) => Promise<boolean>,
): Promise<DefaultProviderSelection> {
  const mode = parseOpenShellMode(env.OPENSHELL_MODE);
  const endpoint = env.OPENSHELL_GATEWAY_ENDPOINT;

  if (mode === "subprocess") {
    return { providerId: "subprocess", reason: "OPENSHELL_MODE=subprocess (explicit override)" };
  }

  if (mode === "openshell") {
    if (!endpoint) {
      return {
        providerId: "subprocess",
        reason: "OPENSHELL_MODE=openshell but OPENSHELL_GATEWAY_ENDPOINT is unset — nothing to force, falling back",
      };
    }
    return { providerId: "openshell", reason: "OPENSHELL_MODE=openshell (explicit override)" };
  }

  // auto
  if (!endpoint) {
    return { providerId: "subprocess", reason: "OPENSHELL_GATEWAY_ENDPOINT not set" };
  }

  try {
    const reachable = await probeReachable(endpoint);
    return reachable
      ? { providerId: "openshell", reason: `OpenShell gateway ${endpoint} reachable` }
      : { providerId: "subprocess", reason: `OpenShell gateway ${endpoint} unreachable` };
  } catch (err) {
    return {
      providerId: "subprocess",
      reason: `OpenShell gateway probe threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check whether a set of env vars (from process.env-style record) is
 * sufficient for a given adapter type. Returns null if yes; an error
 * message if not.
 */
export function checkProviderRequirements(
  type: string,
  env: Record<string, string | undefined>,
): string | null {
  const desc = SYSTEM_PROVIDERS.find((p) => p.type === type);
  if (!desc) return `Unknown provider type: ${type}`;
  if (desc.envKeys.length === 0) return null; // no requirements

  const missing = desc.envKeys.filter((k) => !env[k]);
  if (missing.length > 0 && desc.type !== "litebox") {
    // litebox is optional — missing memory/cpu just means defaults
    return `Missing required env vars: ${missing.join(", ")}`;
  }

  return null;
}

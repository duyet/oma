/**
 * Curated data for the Environment detail page: one-click package bundles
 * for the packages editor, and sandbox-provider availability/setup notes
 * surfaced next to the provider badge.
 *
 * Sources of truth this mirrors — keep in sync if either changes:
 *  - AGENTS.md "Environments" → "Sandbox Provider on the Cloudflare
 *    Deployment" (required secrets, CF vs self-host availability)
 *  - packages/sandbox-sdk/src/provider-config.ts SYSTEM_PROVIDERS (provider
 *    ids, env var names, cfCompatible classification)
 */

// =================================================================
// Package presets
// =================================================================

/** Package managers a preset may populate — mirrors the `MANAGERS` array
 *  editable in EnvironmentDetail.tsx (`gem` is intentionally excluded
 *  there; OMA's sandbox-base doesn't have ruby installed yet). */
export type PresetManager = "apt" | "cargo" | "go" | "npm" | "pip";

export interface PackagePreset {
  id: string;
  label: string;
  /** Short summary shown as a tooltip on the preset button. */
  description: string;
  packages: Partial<Record<PresetManager, string[]>>;
}

export const PACKAGE_PRESETS: PackagePreset[] = [
  {
    id: "data-science",
    label: "Data science",
    description: "numpy, pandas, matplotlib, scikit-learn (pip)",
    packages: {
      pip: ["numpy", "pandas", "matplotlib", "scikit-learn"],
    },
  },
  {
    id: "web-scraping",
    label: "Web scraping",
    description: "requests, beautifulsoup4, playwright + a headless browser (pip + apt)",
    packages: {
      pip: ["requests", "beautifulsoup4", "lxml", "playwright"],
      apt: ["chromium"],
    },
  },
  {
    id: "node-tooling",
    label: "Node tooling",
    description: "typescript, tsx, eslint, prettier (npm)",
    packages: {
      npm: ["typescript", "tsx", "eslint", "prettier"],
    },
  },
  {
    id: "rust-cli",
    label: "Rust CLI",
    description: "ripgrep, fd-find, bat (cargo) + jq (apt)",
    packages: {
      cargo: ["ripgrep", "fd-find", "bat"],
      apt: ["jq"],
    },
  },
];

// =================================================================
// Provider guidance
// =================================================================

export type CfAvailability = "default" | "available" | "relay" | "unavailable";

export interface ProviderGuidance {
  id: string;
  /** Env var(s) that must be set (e.g. via `wrangler secret put`) for the
   *  provider to resolve on the Cloudflare deployment. Undefined when none
   *  is required. */
  requiredSecret?: string;
  optionalSecret?: string;
  cf: { status: CfAvailability; note: string };
  selfHost: { note: string };
  /** Networking guidance — mainly relevant when this environment's
   *  Networking section is set to "Limited". */
  networking?: string;
  limitations?: string[];
}

export const PROVIDER_GUIDANCE: ProviderGuidance[] = [
  {
    id: "cloud",
    cf: {
      status: "default",
      note: "Default managed sandbox — Cloudflare Containers. No setup required.",
    },
    selfHost: {
      note: "Falls back to this host's configured default provider, not Cloudflare Containers.",
    },
  },
  {
    id: "boxrun",
    requiredSecret: "BOXRUN_URL",
    cf: {
      status: "available",
      note: "Talks to a remote BoxRun control plane over plain fetch, no driver SDK. Missing the secret fails sessions clearly rather than silently falling back.",
    },
    selfHost: { note: "Same BoxRun HTTP client, configured the same way." },
    networking: "If Networking is set to Limited, allow-list the BoxRun host.",
  },
  {
    id: "k8s-remote",
    requiredSecret: "K8S_SANDBOX_GATEWAY_URL",
    cf: {
      status: "available",
      note: "Talks to an in-cluster k8s-sandbox-gateway over plain fetch (boxrun-shaped HTTP API: create / exec+SSE / files-as-tar / destroy). Missing the secret fails sessions clearly.",
    },
    selfHost: {
      note: "Not needed on self-host — it talks to the cluster directly via KubernetesSandboxExecutor. Use \"k8s\" there instead.",
    },
    networking: "If Networking is set to Limited, allow-list the gateway host.",
    limitations: [
      "Memory-store and session-outputs bind-mounts aren't available over the gateway's HTTP tar API.",
    ],
  },
  {
    id: "openshell",
    requiredSecret: "OPENSHELL_BRIDGE_URL",
    optionalSecret: "OPENSHELL_BRIDGE_TOKEN",
    cf: {
      status: "available",
      note: "The OpenShell gateway is gRPC-only, so Cloudflare talks to a k8s-bridge running its OpenShell backend over plain fetch instead.",
    },
    selfHost: {
      note: "Speaks gRPC directly to the OpenShell gateway (OPENSHELL_GATEWAY_ENDPOINT) — no bridge needed.",
    },
    networking: "If Networking is set to Limited, allow-list the bridge host.",
    limitations: [
      "Memory-store and session-outputs mounts aren't available over the HTTP API, same as BoxRun and k8s-remote.",
    ],
  },
  {
    id: "daytona",
    requiredSecret: "DAYTONA_API_KEY",
    cf: {
      status: "unavailable",
      note: "Outbound-HTTP-only in principle, but not yet wired on Cloudflare — the Daytona driver SDK isn't bundled into the Worker. Selecting this fails clearly with a session.error.",
    },
    selfHost: { note: "Works today via the full sandbox-provider registry." },
  },
  {
    id: "e2b",
    requiredSecret: "E2B_API_KEY",
    cf: {
      status: "unavailable",
      note: "Outbound-HTTP-only in principle, but not yet wired on Cloudflare — the E2B driver SDK isn't bundled into the Worker. Selecting this fails clearly with a session.error.",
    },
    selfHost: { note: "Works today via the full sandbox-provider registry." },
  },
  {
    id: "subprocess",
    cf: {
      status: "relay",
      note: "Works via the bridge relay when a paired machine is online — each sandbox op relays to your most-recently-heartbeated `oma bridge daemon` over WebSocket. Fails clearly (\"no bridge runtime connected\") when none is.",
    },
    selfHost: {
      note: "Direct Node child_process on the host. Zero isolation — trusted local dev only.",
    },
    limitations: [
      "Loopback credential proxy injects vault tokens for git HTTPS and plain http://. gh, curl https://…, and other own-TLS tools still use the machine's credentials (OMA does not install a CA).",
      "Memory-store and session-outputs mounts aren't wired.",
    ],
  },
  {
    id: "litebox",
    cf: {
      status: "unavailable",
      note: "A native micro-VM binding — cannot run in a Worker at all, and there's no relay path. Use the self-host runtime instead.",
    },
    selfHost: { note: "Local Firecracker micro-VM per box. Hardware isolation, no daemon." },
  },
  {
    id: "k8s",
    requiredSecret: "OMA_K8S_NAMESPACE",
    cf: {
      status: "unavailable",
      note: "Requires a local kubeconfig — a Worker has none and there's no relay path. Use \"k8s-remote\" on Cloudflare instead.",
    },
    selfHost: {
      note: "Provisions a pod directly via the kubernetes-sigs agent-sandbox controller.",
    },
  },
  {
    id: "docker-compose",
    requiredSecret: "DOCKER_COMPOSE_PROJECT_DIR",
    cf: {
      status: "unavailable",
      note: "Requires a Docker socket — cannot run in a Worker at all, and there's no relay path. Use the self-host runtime instead.",
    },
    selfHost: { note: "Per-session Docker Compose sandbox." },
  },
  {
    id: "k8s-bridge",
    requiredSecret: "K8S_BRIDGE_URL",
    cf: {
      status: "available",
      note: "Remote HTTP bridge to a Kubernetes cluster — pure fetch, no Node builtins.",
    },
    selfHost: { note: "Same HTTP bridge client, configured the same way." },
    networking: "If Networking is set to Limited, allow-list the bridge host.",
  },
  {
    id: "github-actions",
    requiredSecret: "GITHUB_ACTIONS_OWNER, GITHUB_ACTIONS_REPO, GITHUB_ACTIONS_WORKFLOW, GITHUB_TOKEN",
    cf: {
      status: "available",
      note: "Runs sandbox commands via GitHub Actions workflow_dispatch — pure fetch, no Node builtins.",
    },
    selfHost: { note: "Same GitHub Actions client, configured the same way." },
  },
  {
    id: "remote-agent",
    requiredSecret: "REMOTE_AGENT_URL",
    optionalSecret: "REMOTE_AGENT_TOKEN",
    cf: {
      status: "available",
      note: "BYOK remote machine sandbox via a lightweight HTTP agent — pure fetch, no Node builtins.",
    },
    selfHost: { note: "Same HTTP agent client, configured the same way." },
    networking: "If Networking is set to Limited, allow-list the remote agent host.",
  },
];

const GUIDANCE_ALIASES: Record<string, string> = {
  local: "subprocess",
  kubernetes: "k8s",
};

/** Look up provider guidance by id, resolving known aliases. Returns
 *  undefined (fail-soft) for unrecognized/custom BYOK provider ids —
 *  callers should show a generic "no specific guidance" message rather
 *  than erroring or omitting the panel entirely. */
export function getProviderGuidance(providerId: string | undefined): ProviderGuidance | undefined {
  const id = (providerId ?? "cloud").trim().toLowerCase();
  const canonical = GUIDANCE_ALIASES[id] ?? id;
  return PROVIDER_GUIDANCE.find((p) => p.id === canonical);
}

// OMA EnvironmentConfig → NVIDIA OpenShell SandboxPolicy mapping.
//
// This module is PURE (no gRPC, no Node builtins, no I/O) so it bundles into
// a Cloudflare Worker and is trivially unit-testable. The gRPC adapter
// (`openshell.ts`, self-host) and the CF path (apps/agent → k8s-bridge
// OpenShell backend) both feed their environment config through here and
// attach the resulting policy to `SandboxSpec.policy` (proto field 7).
//
// Upstream model (proto/sandbox.proto, `openshell.sandbox.v1.SandboxPolicy`):
// OpenShell is **default-deny** for egress — the in-sandbox proxy rejects any
// destination not named by a NetworkPolicyRule endpoint. There is deliberately
// NO allow-all wildcard: the policy validator rejects a bare `*`/`**` host
// (architecture/security-policy.md, "Host Wildcards"). Consequences:
//
//   - networking.type "limited" maps cleanly: allowed_hosts (+ package-manager
//     registries when allow_package_managers, + the OMA MCP-proxy host when
//     allow_mcp_servers) become NetworkEndpoint entries under one rule.
//   - networking.type "unrestricted" is NOT expressible as a policy. We emit
//     no policy (so the gateway applies its built-in default policy) and warn
//     loudly — silent partial enforcement would be worse than a clear note.
//
// Field names here are snake_case to match proto-loader's `keepCase: true`
// decoding in openshell.ts — the object is passed straight to the gRPC stub.

/** Structural subset of `EnvironmentConfig["config"]` this mapping reads. */
export interface OpenShellPolicyInput {
  networking?: {
    type: "unrestricted" | "limited";
    allowed_hosts?: string[];
    allow_mcp_servers?: boolean;
    allow_package_managers?: boolean;
  };
  packages?: {
    pip?: string[];
    npm?: string[];
    apt?: string[];
    cargo?: string[];
    gem?: string[];
    go?: string[];
  };
}

export interface OpenShellPolicyOptions {
  /** Hosts the sandbox must reach to use the OMA MCP proxy — deployment
   *  specific (the main worker on CF, main-node on self-host). Added to the
   *  egress allowlist when `networking.allow_mcp_servers` is true. */
  mcpProxyHosts?: string[];
}

// ── Wire shape (matches proto/sandbox.proto field names under keepCase) ──

export interface OpenShellNetworkEndpoint {
  host: string;
  port?: number;
}

export interface OpenShellNetworkPolicyRule {
  name: string;
  endpoints: OpenShellNetworkEndpoint[];
}

export interface OpenShellFilesystemPolicy {
  include_workdir: boolean;
  read_only?: string[];
  read_write?: string[];
}

export interface OpenShellSandboxPolicy {
  version: number;
  filesystem?: OpenShellFilesystemPolicy;
  network_policies?: Record<string, OpenShellNetworkPolicyRule>;
}

export interface OpenShellPolicyMapping {
  /** The mapped policy, or undefined when no policy should be attached
   *  (unrestricted / no networking config → gateway's built-in default). */
  policy?: OpenShellSandboxPolicy;
  /** Requested-but-unenforceable settings, safe to log verbatim. Non-empty
   *  means something the caller asked for is NOT reflected in `policy`. */
  warnings: string[];
}

// Package-manager → registry hosts the sandbox must reach to install from it.
// Keyed by the OMA `packages` manager name. Kept conservative and explicit
// (no wildcards) so each entry is a valid OpenShell exact-host endpoint.
const PACKAGE_REGISTRY_HOSTS: Record<string, string[]> = {
  pip: ["pypi.org", "files.pythonhosted.org"],
  npm: ["registry.npmjs.org"],
  apt: ["deb.debian.org", "security.debian.org", "archive.ubuntu.com", "security.ubuntu.com"],
  cargo: ["crates.io", "static.crates.io", "index.crates.io"],
  gem: ["rubygems.org", "index.rubygems.org"],
  go: ["proxy.golang.org", "sum.golang.org"],
};

/**
 * Map an OMA environment config to an OpenShell SandboxPolicy.
 *
 * Deterministic and side-effect-free. The caller is responsible for logging
 * the returned `warnings` and attaching `policy` (when present) to the
 * CreateSandbox spec.
 */
export function mapEnvironmentConfigToOpenShellPolicy(
  config: OpenShellPolicyInput | undefined | null,
  options: OpenShellPolicyOptions = {},
): OpenShellPolicyMapping {
  const warnings: string[] = [];
  const net = config?.networking;

  // No networking config at all → let the gateway apply its built-in default
  // policy. Not a warning: absence of config is not a requested-but-dropped
  // setting.
  if (!net) {
    return { policy: undefined, warnings };
  }

  if (net.type === "unrestricted") {
    warnings.push(
      "networking.type=unrestricted is not expressible as an OpenShell policy: " +
        "OpenShell enforces default-deny egress with no allow-all wildcard. " +
        "Attaching no policy so the gateway's built-in default applies — this is " +
        "NOT unrestricted access. Author explicit allowed_hosts (networking.type=limited) " +
        "or a gateway-global policy override for broader egress.",
    );
    return { policy: undefined, warnings };
  }

  // networking.type === "limited": build an explicit egress allowlist.
  const hosts: string[] = [];
  const addHost = (h: string) => {
    const host = h.trim().toLowerCase();
    if (!host) return;
    // OpenShell rejects bare "*"/"**" (match-every-host) at policy load.
    if (host === "*" || host === "**") {
      warnings.push(
        `allowed_hosts entry "${h}" (match-every-host) is rejected by OpenShell's ` +
          "policy validator and was dropped — list explicit hosts or first-label " +
          "wildcards like *.example.com instead.",
      );
      return;
    }
    if (!hosts.includes(host)) hosts.push(host);
  };

  for (const h of net.allowed_hosts ?? []) addHost(h);

  if (net.allow_package_managers) {
    const declared = Object.entries(config?.packages ?? {})
      .filter(([, list]) => Array.isArray(list) && list.length > 0)
      .map(([mgr]) => mgr);
    if (declared.length === 0) {
      warnings.push(
        "networking.allow_package_managers is true but no packages are declared — " +
          "cannot infer which registry hosts to allow. Declare packages (pip/npm/apt/...) " +
          "or add the registry hosts to allowed_hosts explicitly.",
      );
    } else {
      for (const mgr of declared) {
        for (const host of PACKAGE_REGISTRY_HOSTS[mgr] ?? []) addHost(host);
      }
    }
  }

  if (net.allow_mcp_servers) {
    const mcpHosts = options.mcpProxyHosts ?? [];
    if (mcpHosts.length === 0) {
      warnings.push(
        "networking.allow_mcp_servers is true but no MCP-proxy host was provided to " +
          "the policy mapper — the sandbox will not be allowed to reach the OMA MCP proxy. " +
          "Configure the deployment's MCP-proxy host so it can be added to the egress allowlist.",
      );
    } else {
      for (const host of mcpHosts) addHost(host);
    }
  }

  // Packages inform the egress allowlist but are NOT installed by the OpenShell
  // path (the adapter only sets image + env; it does not build images).
  if (hasDeclaredPackages(config)) {
    warnings.push(
      "environment.config.packages are used to derive registry egress rules but are " +
        "NOT auto-installed on the OpenShell path — bake them into a custom OPENSHELL_IMAGE.",
    );
  }

  const policy: OpenShellSandboxPolicy = {
    version: 1,
    // Give the agent its workspace read-write; OpenShell enriches the rest of
    // the baseline runtime paths itself (architecture/security-policy.md).
    filesystem: { include_workdir: true },
  };

  if (hosts.length > 0) {
    policy.network_policies = {
      oma: {
        name: "oma",
        endpoints: hosts.map((host) => ({ host })),
      },
    };
  } else {
    warnings.push(
      "networking.type=limited produced an empty egress allowlist — the sandbox will be " +
        "fully network-isolated (default-deny with no allowed hosts).",
    );
  }

  return { policy, warnings };
}

function hasDeclaredPackages(config: OpenShellPolicyInput | undefined | null): boolean {
  const pkgs = config?.packages;
  if (!pkgs) return false;
  return Object.values(pkgs).some((list) => Array.isArray(list) && list.length > 0);
}

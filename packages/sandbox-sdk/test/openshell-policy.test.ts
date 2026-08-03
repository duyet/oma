import { describe, expect, it } from "vitest";
import {
  mapEnvironmentConfigToOpenShellPolicy,
  type OpenShellPolicyInput,
} from "../src/adapters/openshell-policy";

describe("mapEnvironmentConfigToOpenShellPolicy", () => {
  it("returns no policy and no warnings when networking is absent", () => {
    const r = mapEnvironmentConfigToOpenShellPolicy({});
    expect(r.policy).toBeUndefined();
    expect(r.warnings).toEqual([]);
  });

  it("returns no policy for undefined/null config", () => {
    expect(mapEnvironmentConfigToOpenShellPolicy(undefined).policy).toBeUndefined();
    expect(mapEnvironmentConfigToOpenShellPolicy(null).policy).toBeUndefined();
  });

  describe("unrestricted", () => {
    it("emits no policy and warns loudly (no allow-all wildcard exists)", () => {
      const r = mapEnvironmentConfigToOpenShellPolicy({ networking: { type: "unrestricted" } });
      expect(r.policy).toBeUndefined();
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatch(/unrestricted/);
      expect(r.warnings[0]).toMatch(/default-deny/);
    });
  });

  describe("limited", () => {
    it("maps allowed_hosts to a single network policy rule of endpoints", () => {
      const r = mapEnvironmentConfigToOpenShellPolicy({
        networking: { type: "limited", allowed_hosts: ["api.github.com", "example.com"] },
      });
      expect(r.policy).toBeDefined();
      expect(r.policy!.version).toBe(1);
      expect(r.policy!.filesystem).toEqual({ include_workdir: true });
      expect(r.policy!.network_policies!.oma.endpoints).toEqual([
        { host: "api.github.com" },
        { host: "example.com" },
      ]);
      expect(r.warnings).toEqual([]);
    });

    it("lowercases, trims, and de-duplicates hosts", () => {
      const r = mapEnvironmentConfigToOpenShellPolicy({
        networking: { type: "limited", allowed_hosts: [" API.github.com ", "api.github.com"] },
      });
      expect(r.policy!.network_policies!.oma.endpoints).toEqual([{ host: "api.github.com" }]);
    });

    it("drops bare */** hosts with a warning (rejected by OpenShell's validator)", () => {
      const r = mapEnvironmentConfigToOpenShellPolicy({
        networking: { type: "limited", allowed_hosts: ["*", "**", "api.github.com"] },
      });
      expect(r.policy!.network_policies!.oma.endpoints).toEqual([{ host: "api.github.com" }]);
      expect(r.warnings.filter((w) => /match-every-host/.test(w))).toHaveLength(2);
    });

    it("adds package-manager registry hosts for declared managers when allow_package_managers", () => {
      const r = mapEnvironmentConfigToOpenShellPolicy({
        networking: { type: "limited", allowed_hosts: ["example.com"], allow_package_managers: true },
        packages: { pip: ["numpy"], npm: ["left-pad"] },
      });
      const hosts = r.policy!.network_policies!.oma.endpoints.map((e) => e.host);
      expect(hosts).toContain("pypi.org");
      expect(hosts).toContain("files.pythonhosted.org");
      expect(hosts).toContain("registry.npmjs.org");
      expect(hosts).toContain("example.com");
      // apt/cargo/... not declared → not added
      expect(hosts).not.toContain("crates.io");
    });

    it("warns when allow_package_managers is set but no packages declared", () => {
      const r = mapEnvironmentConfigToOpenShellPolicy({
        networking: { type: "limited", allowed_hosts: ["example.com"], allow_package_managers: true },
      });
      expect(r.warnings.some((w) => /no packages are declared/.test(w))).toBe(true);
    });

    it("adds MCP-proxy hosts when allow_mcp_servers and hosts are provided", () => {
      const r = mapEnvironmentConfigToOpenShellPolicy(
        { networking: { type: "limited", allowed_hosts: ["example.com"], allow_mcp_servers: true } },
        { mcpProxyHosts: ["mcp.oma.internal"] },
      );
      const hosts = r.policy!.network_policies!.oma.endpoints.map((e) => e.host);
      expect(hosts).toContain("mcp.oma.internal");
    });

    it("warns when allow_mcp_servers but no MCP-proxy host is provided", () => {
      const r = mapEnvironmentConfigToOpenShellPolicy({
        networking: { type: "limited", allowed_hosts: ["example.com"], allow_mcp_servers: true },
      });
      expect(r.warnings.some((w) => /allow_mcp_servers/.test(w))).toBe(true);
    });

    it("warns that declared packages are not auto-installed on the OpenShell path", () => {
      const r = mapEnvironmentConfigToOpenShellPolicy({
        networking: { type: "limited", allowed_hosts: ["example.com"] },
        packages: { pip: ["numpy"] },
      });
      expect(r.warnings.some((w) => /NOT auto-installed/.test(w))).toBe(true);
    });

    it("warns when the resulting allowlist is empty (fully network-isolated)", () => {
      const r = mapEnvironmentConfigToOpenShellPolicy({ networking: { type: "limited" } });
      expect(r.policy!.network_policies).toBeUndefined();
      expect(r.warnings.some((w) => /empty egress allowlist/.test(w))).toBe(true);
    });

    it("maps every package manager to its registry hosts", () => {
      const config: OpenShellPolicyInput = {
        networking: { type: "limited", allow_package_managers: true },
        packages: { pip: ["a"], npm: ["b"], apt: ["c"], cargo: ["d"], gem: ["e"], go: ["f"] },
      };
      const hosts = mapEnvironmentConfigToOpenShellPolicy(config).policy!.network_policies!.oma.endpoints.map(
        (e) => e.host,
      );
      for (const h of [
        "pypi.org",
        "registry.npmjs.org",
        "deb.debian.org",
        "crates.io",
        "rubygems.org",
        "proxy.golang.org",
      ]) {
        expect(hosts).toContain(h);
      }
    });
  });
});

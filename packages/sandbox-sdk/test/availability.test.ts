import { describe, it, expect } from "vitest";
import {
  describeProviderAvailability,
  buildUnseededHostingTypes,
} from "../src/availability";
import { SYSTEM_PROVIDERS } from "../src/provider-config";

const NO_ENV: Record<string, string | undefined> = {};

describe("describeProviderAvailability — Cloudflare", () => {
  it("marks Node-only providers unavailable with a runtime reason", () => {
    for (const id of ["litebox", "k8s", "docker-compose"]) {
      const a = describeProviderAvailability({ providerId: id, runtime: "cloudflare", env: NO_ENV });
      expect(a.state).toBe("unavailable");
      expect(a.reason).toMatch(/Node-only/);
      expect(a.reason).toMatch(/self-host Node runtime/);
    }
  });

  it("gates dynamic-workers on the LOADER binding, not an env var", () => {
    const without = describeProviderAvailability({
      providerId: "dynamic-workers",
      runtime: "cloudflare",
      env: NO_ENV,
    });
    expect(without.state).toBe("unavailable");
    expect(without.reason).toMatch(/LOADER/);

    const with_ = describeProviderAvailability({
      providerId: "dynamic-workers",
      runtime: "cloudflare",
      env: NO_ENV,
      hasWorkerLoader: true,
    });
    expect(with_.state).toBe("available");
  });

  it("reports the exact missing secret for remote providers", () => {
    const a = describeProviderAvailability({ providerId: "boxrun", runtime: "cloudflare", env: NO_ENV });
    expect(a.state).toBe("needs_config");
    expect(a.missing_env).toEqual(["BOXRUN_URL"]);
    expect(a.reason).toMatch(/wrangler secret put BOXRUN_URL/);

    const configured = describeProviderAvailability({
      providerId: "boxrun",
      runtime: "cloudflare",
      env: { BOXRUN_URL: "https://boxrun.example" },
    });
    expect(configured.state).toBe("available");
  });

  it("names the gateway secret for k8s-remote and openshell", () => {
    expect(
      describeProviderAvailability({ providerId: "k8s-remote", runtime: "cloudflare", env: NO_ENV })
        .missing_env,
    ).toEqual(["K8S_SANDBOX_GATEWAY_URL"]);
    expect(
      describeProviderAvailability({ providerId: "openshell", runtime: "cloudflare", env: NO_ENV })
        .missing_env,
    ).toEqual(["OPENSHELL_BRIDGE_URL"]);
  });

  it("explains that daytona / e2b SDKs aren't bundled into the Worker", () => {
    for (const id of ["daytona", "e2b"]) {
      const a = describeProviderAvailability({ providerId: id, runtime: "cloudflare", env: NO_ENV });
      expect(a.state).toBe("unavailable");
      expect(a.reason).toMatch(/isn't bundled/);
    }
  });

  it("describes subprocess and browser-vm as relayed, not unavailable", () => {
    const sub = describeProviderAvailability({ providerId: "subprocess", runtime: "cloudflare", env: NO_ENV });
    expect(sub.state).toBe("available");
    expect(sub.reason).toMatch(/oma bridge daemon/);

    const vm = describeProviderAvailability({ providerId: "browser-vm", runtime: "cloudflare", env: NO_ENV });
    expect(vm.state).toBe("available");
    expect(vm.reason).toMatch(/browser sandbox tab/);
  });

  it("treats an unknown (BYOK) id as available rather than inventing a fault", () => {
    const a = describeProviderAvailability({ providerId: "my-byok-thing", runtime: "cloudflare", env: NO_ENV });
    expect(a.state).toBe("available");
    expect(a.reason).toMatch(/Custom provider/);
  });
});

describe("describeProviderAvailability — self-host Node", () => {
  it("marks nodeCompatible:false providers unavailable", () => {
    const a = describeProviderAvailability({ providerId: "dynamic-workers", runtime: "node", env: NO_ENV });
    expect(a.state).toBe("unavailable");
    expect(a.reason).toMatch(/Cloudflare-only/);
  });

  it("marks browser-vm unavailable — the relay is a Durable Object", () => {
    const a = describeProviderAvailability({ providerId: "browser-vm", runtime: "node", env: NO_ENV });
    expect(a.state).toBe("unavailable");
    expect(a.reason).toMatch(/RuntimeRoom Durable Object/);
  });

  it("makes Node-only providers available here", () => {
    for (const id of ["litebox", "k8s", "docker-compose", "subprocess"]) {
      const a = describeProviderAvailability({ providerId: id, runtime: "node", env: { OMA_K8S_NAMESPACE: "ns", DOCKER_COMPOSE_PROJECT_DIR: "/x" } });
      expect(a.state).toBe("available");
    }
  });

  it("lists the missing env vars for an unconfigured provider", () => {
    const a = describeProviderAvailability({ providerId: "daytona", runtime: "node", env: NO_ENV });
    expect(a.state).toBe("needs_config");
    expect(a.missing_env).toContain("DAYTONA_API_KEY");
  });

  it("never calls litebox unconfigured — its env keys are tunables", () => {
    const a = describeProviderAvailability({ providerId: "litebox", runtime: "node", env: NO_ENV });
    expect(a.state).toBe("available");
  });
});

describe("buildUnseededHostingTypes", () => {
  it("emits a row for every provider that wasn't seeded, each with a reason", () => {
    const rows = buildUnseededHostingTypes(new Set(["cloud"]), "cloudflare", NO_ENV);
    expect(rows).toHaveLength(SYSTEM_PROVIDERS.length - 1);
    expect(rows.find((r) => r.id === "cloud")).toBeUndefined();
    for (const r of rows) {
      expect(r.health).toBeNull();
      expect(r.availability.reason.length).toBeGreaterThan(0);
    }
  });

  it("does not duplicate a seeded provider", () => {
    const seeded = new Set(SYSTEM_PROVIDERS.map((p) => p.type));
    expect(buildUnseededHostingTypes(seeded, "node", NO_ENV)).toHaveLength(0);
  });
});

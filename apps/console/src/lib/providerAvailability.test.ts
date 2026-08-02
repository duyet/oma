import { describe, expect, it } from "vitest";
import {
  partitionByAvailability,
  providerAvailabilityView,
  runtimeLabel,
} from "./providerAvailability";

describe("providerAvailabilityView", () => {
  it("treats a missing availability field as plainly available", () => {
    const v = providerAvailabilityView(undefined);
    expect(v.state).toBe("available");
    expect(v.usable).toBe(true);
    expect(v.badge).toBeNull();
    expect(v.reason).toBeNull();
  });

  it("keeps the backend's reason verbatim for an unavailable provider", () => {
    const v = providerAvailabilityView({
      state: "unavailable",
      reason: "Kubernetes is Node-only — use the self-host Node runtime instead.",
    });
    expect(v.usable).toBe(false);
    expect(v.badge).toBe("Unavailable here");
    expect(v.reason).toBe("Kubernetes is Node-only — use the self-host Node runtime instead.");
  });

  it("keeps a needs_config provider usable and surfaces the missing secrets", () => {
    const v = providerAvailabilityView({
      state: "needs_config",
      reason: "Requires the BOXRUN_URL secret.",
      missing_env: ["BOXRUN_URL"],
    });
    expect(v.usable).toBe(true);
    expect(v.badge).toBe("Needs config");
    expect(v.missingEnv).toEqual(["BOXRUN_URL"]);
  });

  it("says nothing when a provider is available", () => {
    const v = providerAvailabilityView({ state: "available", reason: "Wired here." });
    expect(v.badge).toBeNull();
    expect(v.reason).toBeNull();
  });
});

describe("partitionByAvailability", () => {
  it("separates unavailable providers without dropping any", () => {
    const items = [
      { id: "cloud", availability: { state: "available" as const, reason: "ok" } },
      { id: "boxrun", availability: { state: "needs_config" as const, reason: "secret" } },
      { id: "k8s", availability: { state: "unavailable" as const, reason: "node only" } },
      { id: "legacy", availability: undefined },
    ];
    const { usable, unavailable } = partitionByAvailability(items, (i) => i.availability);
    expect(usable.map((i) => i.id)).toEqual(["cloud", "boxrun", "legacy"]);
    expect(unavailable.map((i) => i.id)).toEqual(["k8s"]);
  });
});

describe("runtimeLabel", () => {
  it("names the two deployments and stays quiet otherwise", () => {
    expect(runtimeLabel("cloudflare")).toBe("Cloudflare deployment");
    expect(runtimeLabel("node")).toBe("Self-host Node runtime");
    expect(runtimeLabel(undefined)).toBeNull();
    expect(runtimeLabel("something-else")).toBeNull();
  });
});

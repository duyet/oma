import { describe, expect, it } from "vitest";
import {
  deriveHomeRuntimePresence,
  pickHomeRuntime,
  resolveHomePresence,
  sessionStatusKind,
} from "./home-runtime";

describe("deriveHomeRuntimePresence", () => {
  const now = 1_700_000_090;

  it("provisioning with no runtime", () => {
    expect(deriveHomeRuntimePresence(null, now)).toBe("provisioning");
  });

  it("never labels a stale heartbeat as online", () => {
    expect(
      deriveHomeRuntimePresence({ id: "rt_1", status: "online", last_heartbeat: now - 200 }, now),
    ).toBe("offline");
  });
});

describe("sessionStatusKind", () => {
  it("does not call idle sessions working", () => {
    expect(sessionStatusKind("idle")).toBe("idle");
    expect(sessionStatusKind("running")).toBe("working");
    expect(sessionStatusKind("terminated")).toBe("error");
  });
});

describe("pickHomeRuntime", () => {
  it("prefers the newest heartbeat", () => {
    const picked = pickHomeRuntime([
      { id: "old", last_heartbeat: 10 },
      { id: "new", last_heartbeat: 20 },
    ]);
    expect(picked?.id).toBe("new");
  });
});

describe("resolveHomePresence", () => {
  const now = 1_700_000_090;

  it("uses the home payload runtime over the user-scoped list", () => {
    expect(
      resolveHomePresence({
        homeRuntime: { status: "online", last_heartbeat: now - 5 },
        runtimes: [],
        nowSeconds: now,
      }),
    ).toBe("online");
  });

  it("falls back to /v1/runtimes when the home payload has no runtime", () => {
    expect(
      resolveHomePresence({
        homeRuntime: null,
        runtimes: [{ id: "rt_1", status: "online", last_heartbeat: now - 5 }],
        nowSeconds: now,
      }),
    ).toBe("online");
  });

  it("is provisioning when neither source has a machine", () => {
    expect(
      resolveHomePresence({ homeRuntime: null, runtimes: [], nowSeconds: now }),
    ).toBe("provisioning");
  });
});

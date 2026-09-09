import { describe, expect, it } from "vitest";
import {
  deriveHomeRuntimePresence,
  homeSessionMetadata,
  isHomeSessionMetadata,
} from "./home";

describe("home session metadata", () => {
  it("stamps home: true without dropping extra keys", () => {
    expect(homeSessionMetadata({ team: "ops" })).toEqual({ team: "ops", home: true });
    expect(isHomeSessionMetadata({ home: true })).toBe(true);
    expect(isHomeSessionMetadata({ home: false })).toBe(false);
    expect(isHomeSessionMetadata(null)).toBe(false);
  });
});

describe("deriveHomeRuntimePresence", () => {
  const now = 1_700_000_090;

  it("is provisioning when no runtime is paired", () => {
    expect(deriveHomeRuntimePresence(null, now)).toBe("provisioning");
  });

  it("is online when heartbeat is fresh", () => {
    expect(
      deriveHomeRuntimePresence({ status: "online", last_heartbeat: now - 10 }, now),
    ).toBe("online");
  });

  it("is offline when heartbeat is stale", () => {
    expect(
      deriveHomeRuntimePresence({ status: "online", last_heartbeat: now - 200 }, now),
    ).toBe("offline");
  });

  it("is offline when the row says offline", () => {
    expect(
      deriveHomeRuntimePresence({ status: "offline", last_heartbeat: now - 1 }, now),
    ).toBe("offline");
  });
});

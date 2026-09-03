import { describe, expect, it } from "vitest";

import type { Event } from "../../lib/events";
import {
  HEARTBEAT_EXPECTED_INTERVAL_MS,
  deriveHeartbeatView,
} from "./agent-heartbeat";

const INTERVAL = HEARTBEAT_EXPECTED_INTERVAL_MS;

function ev(type: string, extra: Record<string, unknown> = {}): Event {
  return { type, ...extra };
}

describe("deriveHeartbeatView", () => {
  it("returns an empty live=false view with no events", () => {
    const v = deriveHeartbeatView([], 1_000);
    expect(v.entries).toEqual([]);
    expect(v.latest).toBeNull();
    expect(v.live).toBe(false);
    expect(v.lagging).toBe(false);
  });

  it("collects agent.status newest-first with step progress", () => {
    const events = [
      ev("agent.status", {
        ts: "2026-09-03T18:00:00.000Z",
        state: "working",
        summary: "started",
        step: 1,
        total_steps: 5,
      }),
      ev("agent.status", {
        ts: "2026-09-03T18:01:00.000Z",
        state: "working",
        summary: "fetched data",
        step: 3,
        total_steps: 5,
      }),
    ];
    const v = deriveHeartbeatView(events, Date.parse("2026-09-03T18:01:10.000Z"));
    expect(v.live).toBe(true);
    expect(v.latest?.summary).toBe("fetched data");
    expect(v.progress).toEqual({ step: 3, total: 5 });
    expect(v.entries.map((e) => e.summary)).toEqual(["fetched data", "started"]);
    expect(v.lagging).toBe(false);
  });

  it("surfaces blocked_on as an amber waiting reason", () => {
    const events = [
      ev("agent.status", {
        ts: "2026-09-03T18:00:00.000Z",
        state: "blocked",
        summary: "Paused",
        blocked_on: "tool confirmation",
      }),
    ];
    const v = deriveHeartbeatView(events, Date.parse("2026-09-03T18:00:05.000Z"));
    expect(v.blockedOn).toBe("tool confirmation");
    expect(v.latest?.state).toBe("blocked");
  });

  it("marks a heartbeat lagged when the gap exceeds 2× the expected interval", () => {
    const t0 = "2026-09-03T18:00:00.000Z";
    const t1 = new Date(Date.parse(t0) + INTERVAL * 2 + 1_000).toISOString();
    const events = [
      ev("agent.status", { ts: t0, state: "working", summary: "a", step: 1 }),
      ev("agent.status", { ts: t1, state: "working", summary: "b", step: 2 }),
    ];
    const v = deriveHeartbeatView(events, Date.parse(t1));
    expect(v.entries[0]?.lagged).toBe(true);
    expect(v.entries[1]?.lagged).toBe(false);
  });

  it("warns when the latest live heartbeat is older than 2× the interval", () => {
    const ts = "2026-09-03T18:00:00.000Z";
    const now = Date.parse(ts) + INTERVAL * 2 + 5_000;
    const v = deriveHeartbeatView(
      [ev("agent.status", { ts, state: "working", summary: "still going", step: 1 })],
      now,
    );
    expect(v.live).toBe(true);
    expect(v.lagging).toBe(true);
    expect(v.lagMs).toBe(INTERVAL * 2 + 5_000);
  });

  it("clears live after a terminal session event", () => {
    const v = deriveHeartbeatView(
      [
        ev("agent.status", {
          ts: "2026-09-03T18:00:00.000Z",
          state: "working",
          summary: "working",
        }),
        ev("session.status_idle"),
      ],
      Date.parse("2026-09-03T19:00:00.000Z"),
    );
    expect(v.live).toBe(false);
    expect(v.lagging).toBe(false);
    expect(v.latest?.summary).toBe("working");
  });
});

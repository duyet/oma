import { describe, expect, it } from "vitest";
import type { Event } from "../../lib/events";
import type { Trajectory } from "../../lib/trajectory";
import {
  deriveOutcomeFromEvents,
  displayTrajectoryOutcome,
  humanizeTurnError,
  lastUserMessageText,
  latestLiveAgentStatus,
} from "./turn-ux";

function ev(type: string, extra: Record<string, unknown> = {}): Event {
  return { type, ...extra } as Event;
}

function user(text: string): Event {
  return ev("user.message", { content: [{ type: "text", text }] });
}

describe("deriveOutcomeFromEvents", () => {
  it("maps a failed turn that returned to idle as failure, not success", () => {
    expect(
      deriveOutcomeFromEvents([
        user("hi"),
        ev("session.status_running"),
        ev("agent.status", { state: "working", step: 1 }),
        ev("session.error", { error: "No output generated. Check the stream for errors." }),
        ev("session.status_idle"),
      ]),
    ).toBe("failure");
  });

  it("uses the latest turn: earlier success then a failed turn is failure", () => {
    expect(
      deriveOutcomeFromEvents([
        user("first"),
        ev("session.status_running"),
        ev("agent.message", { content: [{ type: "text", text: "ok" }] }),
        ev("session.status_idle"),
        user("second"),
        ev("session.status_running"),
        ev("session.error", { error: "Bad Gateway" }),
        ev("session.status_idle"),
      ]),
    ).toBe("failure");
  });

  it("uses the latest turn: earlier error then a successful retry is success", () => {
    expect(
      deriveOutcomeFromEvents([
        user("first"),
        ev("session.error", { error: "boom" }),
        ev("session.status_idle"),
        user("retry"),
        ev("session.status_running"),
        ev("agent.message", { content: [{ type: "text", text: "ok" }] }),
        ev("session.status_idle"),
      ]),
    ).toBe("success");
  });

  it("stays running while a turn is in flight", () => {
    expect(
      deriveOutcomeFromEvents([
        user("hi"),
        ev("session.status_running"),
        ev("agent.status", { state: "working", step: 1 }),
      ]),
    ).toBe("running");
  });
});

describe("displayTrajectoryOutcome", () => {
  const successTraj = { outcome: "success" } as Trajectory;

  it("overrides a stale success trajectory when live events show a failed turn", () => {
    expect(
      displayTrajectoryOutcome(successTraj, [
        user("hi"),
        ev("session.error", { error: "Bad Gateway" }),
        ev("session.status_idle"),
      ]),
    ).toBe("failure");
  });

  it("hides a prior success chip while a new turn is running", () => {
    expect(
      displayTrajectoryOutcome(successTraj, [
        user("hi"),
        ev("session.status_idle"),
        user("again"),
        ev("session.status_running"),
      ]),
    ).toBe("running");
  });
});

describe("latestLiveAgentStatus", () => {
  it("clears a working chip after session.error (even when idle follows)", () => {
    const working = ev("agent.status", { state: "working", step: 1 });
    expect(
      latestLiveAgentStatus([
        user("hi"),
        ev("session.status_running"),
        working,
        ev("session.error", { error: "No output generated." }),
        ev("session.status_idle"),
      ]),
    ).toBeUndefined();
  });

  it("clears a working chip when the turn goes idle without error", () => {
    expect(
      latestLiveAgentStatus([
        ev("agent.status", { state: "working", step: 1 }),
        ev("session.status_idle"),
      ]),
    ).toBeUndefined();
  });

  it("keeps the chip while the turn is still running", () => {
    const working = ev("agent.status", { state: "working", step: 1 });
    expect(
      latestLiveAgentStatus([ev("session.status_running"), working]),
    ).toBe(working);
  });
});

describe("lastUserMessageText", () => {
  it("returns the prompt immediately before a failed turn", () => {
    const events = [
      user("first"),
      ev("session.status_idle"),
      user("please retry this"),
      ev("session.error", { error: "Bad Gateway" }),
    ];
    expect(lastUserMessageText(events, 3)).toBe("please retry this");
  });

  it("skips schedule wakeups", () => {
    const events = [
      user("real prompt"),
      ev("user.message", {
        content: [{ type: "text", text: "wakeup" }],
        metadata: { harness: "schedule", kind: "wakeup" },
      }),
      ev("session.error"),
    ];
    expect(lastUserMessageText(events)).toBe("real prompt");
  });
});

describe("humanizeTurnError", () => {
  it("maps 502 / Bad Gateway to a provider-down line", () => {
    expect(
      humanizeTurnError(
        "No output generated. Check the stream for errors.",
        "Failed after 3 attempts. Last error: Bad Gateway.",
      ),
    ).toMatch(/provider or gateway is down/i);
  });

  it("maps 401 / missing credentials without asking for a secret", () => {
    const line = humanizeTurnError("No output generated.", "401 Unauthorized: invalid api key");
    expect(line).toMatch(/credentials/i);
    expect(line?.toLowerCase()).not.toMatch(/paste|sk-|api_key\s*=/);
  });

  it("maps generic no-output when the cause is missing", () => {
    expect(humanizeTurnError("No output generated. Check the stream for errors.")).toMatch(
      /no output/i,
    );
  });

  it("maps AnyRouter/hoian Gemini tool-combo 400 to a gateway routing line", () => {
    const line = humanizeTurnError(
      "No output generated. Check the stream for errors.",
      'Cause(anyrouter/free): Upstream provider "hoian" returned 400 — Please enable tool_config.include_server_side_tool_invocations to use Built-in tools with Function calling. [400]',
    );
    expect(line).toMatch(/gateway routed/i);
    expect(line).toMatch(/tool-capable model/i);
  });
});

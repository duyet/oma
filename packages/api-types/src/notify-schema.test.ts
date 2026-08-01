import { describe, expect, it } from "vitest";
import { notificationTargetsSchema } from "./notify-schema";

describe("notificationTargetsSchema — email target (issue #317)", () => {
  it("accepts a minimal email target", () => {
    const parsed = notificationTargetsSchema.parse([
      { type: "email", to: "ops@example.com" },
    ]);
    expect(parsed[0]).toEqual({ type: "email", to: "ops@example.com" });
  });

  it("accepts an optional subject_prefix", () => {
    const parsed = notificationTargetsSchema.parse([
      { type: "email", to: "ops@example.com", subject_prefix: "[oma]" },
    ]);
    expect(parsed[0]).toMatchObject({ subject_prefix: "[oma]" });
  });

  it("rejects a non-email `to`", () => {
    expect(
      notificationTargetsSchema.safeParse([{ type: "email", to: "not-an-email" }]).success,
    ).toBe(false);
  });

  it("rejects a missing `to`", () => {
    expect(notificationTargetsSchema.safeParse([{ type: "email" }]).success).toBe(false);
  });

  it("still accepts the pre-existing target variants", () => {
    expect(
      notificationTargetsSchema.safeParse([
        { type: "slack_message", credential_id: "cred_1", channel: "C1" },
        { type: "webhook", url: "https://hooks.example.com/x" },
      ]).success,
    ).toBe(true);
  });
});

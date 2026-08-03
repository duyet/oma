import { describe, expect, it } from "vitest";

import {
  DEFAULT_CRON_VALUE,
  buildCron,
  describeCron,
  formatClock,
  matchCron,
  type CronPresetValue,
} from "./cron-presets";

const at = (fields: Partial<CronPresetValue>): CronPresetValue => ({
  ...DEFAULT_CRON_VALUE,
  ...fields,
});

describe("buildCron", () => {
  // The cadences named in the picker, each pinned to the expression the
  // backend will actually seed next_run_at from.
  it.each([
    ["every hour", at({ preset: "hourly", minute: 0 }), "0 * * * *"],
    ["every hour at :30", at({ preset: "hourly", minute: 30 }), "30 * * * *"],
    ["daily at 6 AM", at({ preset: "daily", hour: 6, minute: 0 }), "0 6 * * *"],
    ["daily at 9 AM", at({ preset: "daily", hour: 9, minute: 0 }), "0 9 * * *"],
    ["daily at 9:30 PM", at({ preset: "daily", hour: 21, minute: 30 }), "30 21 * * *"],
    ["weekdays at 9 AM", at({ preset: "weekdays", hour: 9, minute: 0 }), "0 9 * * 1-5"],
    ["weekly on Monday", at({ preset: "weekly", hour: 9, minute: 0, weekday: 1 }), "0 9 * * 1"],
    ["weekly on Sunday", at({ preset: "weekly", hour: 7, minute: 15, weekday: 0 }), "15 7 * * 0"],
    ["monthly on the 1st", at({ preset: "monthly", hour: 9, minute: 0, day: 1 }), "0 9 1 * *"],
  ])("maps %s", (_label, value, expected) => {
    expect(buildCron(value)).toBe(expected);
  });

  it("passes a custom expression through untouched", () => {
    expect(buildCron(at({ preset: "custom", expression: "*/5 8-17 * * 1-5" }))).toBe(
      "*/5 8-17 * * 1-5",
    );
  });

  it("clamps out-of-range parameters instead of emitting an invalid cron", () => {
    expect(buildCron(at({ preset: "daily", hour: 99, minute: -4 }))).toBe("0 23 * * *");
    // Day 29-31 would skip February, so the picker never offers past 28.
    expect(buildCron(at({ preset: "monthly", day: 31, hour: 0, minute: 0 }))).toBe("0 0 28 * *");
  });
});

describe("matchCron", () => {
  it("round-trips every preset the picker can emit", () => {
    const values = [
      at({ preset: "hourly", minute: 30 }),
      at({ preset: "daily", hour: 6, minute: 0 }),
      at({ preset: "weekdays", hour: 9, minute: 0 }),
      at({ preset: "weekly", hour: 9, minute: 0, weekday: 1 }),
      at({ preset: "monthly", hour: 9, minute: 0, day: 1 }),
    ];
    for (const value of values) {
      const expression = buildCron(value);
      const matched = matchCron(expression);
      expect(matched.preset).toBe(value.preset);
      // Re-deriving from the match must land on the same expression, which
      // is what makes edit-mode prefill safe.
      expect(buildCron(matched)).toBe(expression);
    }
  });

  it("recovers the parameters, not just the preset", () => {
    expect(matchCron("15 7 * * 0")).toMatchObject({
      preset: "weekly",
      hour: 7,
      minute: 15,
      weekday: 0,
    });
    expect(matchCron("0 18 12 * *")).toMatchObject({ preset: "monthly", hour: 18, day: 12 });
  });

  it("falls back to custom for anything it can't describe, keeping the text", () => {
    for (const expr of ["*/5 * * * *", "0 9 * * MON", "0 9 1,15 * *", "0 9 * *", "@daily"]) {
      const matched = matchCron(expr);
      expect(matched.preset).toBe("custom");
      // Never rewrite a hand-authored expression on open.
      expect(buildCron(matched)).toBe(expr);
    }
  });
});

describe("describeCron", () => {
  it("describes each cadence in words", () => {
    expect(describeCron(at({ preset: "hourly", minute: 0 }))).toBe("Every hour, on the hour");
    expect(describeCron(at({ preset: "daily", hour: 6, minute: 0 }))).toBe("Every day at 6 AM");
    expect(describeCron(at({ preset: "weekdays", hour: 9, minute: 0 }))).toBe(
      "Every weekday (Mon–Fri) at 9 AM",
    );
    expect(describeCron(at({ preset: "weekly", hour: 9, minute: 0, weekday: 1 }))).toBe(
      "Every Monday at 9 AM",
    );
    expect(describeCron(at({ preset: "monthly", hour: 9, minute: 0, day: 1 }))).toBe(
      "On the 1st of each month at 9 AM",
    );
  });

  it("makes no cadence claim about a custom expression", () => {
    // Describing an arbitrary cron without a parser would risk being wrong,
    // and a wrong summary is worse than none.
    expect(describeCron(at({ preset: "custom", expression: "*/5 * * * *" }))).toBe(
      "Runs on the cron expression above",
    );
  });

  it("uses ordinals that read correctly", () => {
    expect(describeCron(at({ preset: "monthly", day: 2, hour: 0, minute: 0 }))).toContain("2nd");
    expect(describeCron(at({ preset: "monthly", day: 3, hour: 0, minute: 0 }))).toContain("3rd");
    expect(describeCron(at({ preset: "monthly", day: 11, hour: 0, minute: 0 }))).toContain("11th");
    expect(describeCron(at({ preset: "monthly", day: 21, hour: 0, minute: 0 }))).toContain("21st");
  });
});

describe("formatClock", () => {
  it("renders a 12-hour clock the summary sentence can use", () => {
    expect(formatClock(0, 0)).toBe("12 AM");
    expect(formatClock(9, 0)).toBe("9 AM");
    expect(formatClock(12, 0)).toBe("12 PM");
    expect(formatClock(13, 5)).toBe("1:05 PM");
    expect(formatClock(23, 59)).toBe("11:59 PM");
  });
});

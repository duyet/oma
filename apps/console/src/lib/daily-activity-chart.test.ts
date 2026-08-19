import { describe, expect, it } from "vitest";

import {
  DAILY_CHART_VIEW_W,
  dailyActivityBarWidth,
  dailyActivitySlot,
  dailyActivityTickIndices,
} from "./daily-activity-chart";

describe("dailyActivitySlot", () => {
  it("spreads buckets across the fixed viewBox width", () => {
    expect(dailyActivitySlot(7)).toBe(DAILY_CHART_VIEW_W / 7);
  });
});

describe("dailyActivityBarWidth", () => {
  it("clamps bar width to a readable range", () => {
    expect(dailyActivityBarWidth(4)).toBe(2);
    expect(dailyActivityBarWidth(40)).toBe(20);
    expect(dailyActivityBarWidth(100)).toBe(22);
  });
});

describe("dailyActivityTickIndices", () => {
  it("always includes first and last bucket labels without crowding", () => {
    const slot = dailyActivitySlot(30);
    const ticks = dailyActivityTickIndices(30, slot);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(29);
    expect(ticks.length).toBeGreaterThanOrEqual(2);
  });
});

import { describe, expect, it } from "vitest";
import {
  formatCompact,
  formatDuration,
  formatRelative,
  formatSandboxTime,
  formatSessionDuration,
  formatUsd,
  pickTickStep,
  shortenId,
} from "./format";

describe("formatCompact", () => {
  it("renders values under 1000 verbatim", () => {
    expect(formatCompact(0)).toBe("0");
    expect(formatCompact(999)).toBe("999");
  });
  it("suffixes thousands with K, dropping a trailing .0", () => {
    expect(formatCompact(7500)).toBe("7.5K");
    expect(formatCompact(105000)).toBe("105K");
  });
  it("suffixes millions with M", () => {
    expect(formatCompact(1_200_000)).toBe("1.2M");
  });
  it("renders null/undefined as an em-dash", () => {
    expect(formatCompact(null)).toBe("—");
    expect(formatCompact(undefined)).toBe("—");
  });
});

describe("formatDuration", () => {
  it("returns em-dash for non-finite or negative input", () => {
    expect(formatDuration(NaN)).toBe("—");
    expect(formatDuration(-1)).toBe("—");
  });
  it("clamps sub-millisecond values", () => {
    expect(formatDuration(0.4)).toBe("<1ms");
  });
  it("rounds milliseconds", () => {
    expect(formatDuration(123.6)).toBe("124ms");
  });
  it("renders seconds with two decimals", () => {
    expect(formatDuration(1_234)).toBe("1.23s");
  });
  it("renders minutes + seconds", () => {
    expect(formatDuration(2 * 60_000 + 17_000)).toBe("2m17s");
  });
});

describe("formatRelative", () => {
  it("handles negative diffs by taking magnitude", () => {
    expect(formatRelative(-15_000)).toBe("15s ago");
  });
  it("crosses minute / hour / day / month / year boundaries", () => {
    expect(formatRelative(59_000)).toBe("59s ago");
    expect(formatRelative(5 * 60_000)).toBe("5m ago");
    expect(formatRelative(3 * 3_600_000)).toBe("3h ago");
    expect(formatRelative(2 * 86_400_000)).toBe("2d ago");
    expect(formatRelative(45 * 86_400_000)).toBe("1mo ago");
    expect(formatRelative(400 * 86_400_000)).toBe("1y ago");
  });
});

describe("shortenId", () => {
  it("returns em-dash when id is missing", () => {
    expect(shortenId(undefined)).toBe("—");
  });
  it("passes through short ids unchanged", () => {
    expect(shortenId("abc")).toBe("abc");
  });
  it("truncates long ids with prefix + ellipsis + suffix", () => {
    expect(shortenId("agt_01ABCDEFGHIJKLMXYZ")).toBe("agt_01AB…XYZ");
  });
});

describe("formatSandboxTime", () => {
  it("renders em-dash for zero or undefined seconds", () => {
    expect(formatSandboxTime(0)).toBe("—");
    expect(formatSandboxTime(undefined)).toBe("—");
  });
  it("renders seconds only under a minute", () => {
    expect(formatSandboxTime(45)).toBe("45s");
  });
  it("renders minutes under an hour", () => {
    expect(formatSandboxTime(12 * 60)).toBe("12m");
  });
  it("renders hours + minutes", () => {
    expect(formatSandboxTime(4 * 3600 + 32 * 60)).toBe("4h 32m");
  });
});

describe("formatUsd", () => {
  it("renders a tiny nonzero amount as <$0.01 instead of a misleading $0.00", () => {
    expect(formatUsd(0.004)).toBe("<$0.01");
  });
  it("renders zero as $0.00", () => {
    expect(formatUsd(0)).toBe("$0.00");
  });
  it("renders normal amounts with two decimals", () => {
    expect(formatUsd(1.2)).toBe("$1.20");
    expect(formatUsd(12.345)).toBe("$12.35");
  });
});

describe("pickTickStep", () => {
  it("picks the smallest candidate above the target", () => {
    // target = totalMs / 6; first candidate >= target wins
    expect(pickTickStep(600)).toBe(100); // target 100 → 100
    expect(pickTickStep(601)).toBe(250); // target ~100.17 → 250
    expect(pickTickStep(60_000)).toBe(10_000); // target 10_000 → 10_000
  });
  it("falls back to the largest candidate when nothing fits", () => {
    expect(pickTickStep(Number.MAX_SAFE_INTEGER)).toBe(600_000);
  });
});

describe("formatSessionDuration", () => {
  it("renders sub-minute spans in seconds", () => {
    expect(formatSessionDuration(8)).toBe("8s");
    expect(formatSessionDuration(59)).toBe("59s");
  });
  it("renders minutes with a seconds remainder, dropping a zero remainder", () => {
    expect(formatSessionDuration(134)).toBe("2m 14s");
    expect(formatSessionDuration(120)).toBe("2m");
  });
  it("switches to hours past an hour rather than piling up minutes", () => {
    // The reason this exists alongside formatDuration, which would render
    // this as "72m0s" — unreadable in a table of long-running sessions.
    expect(formatSessionDuration(4320)).toBe("1h 12m");
    expect(formatSessionDuration(3600)).toBe("1h");
  });
  it("switches to days past 24h", () => {
    expect(formatSessionDuration(273_600)).toBe("3d 4h");
    expect(formatSessionDuration(259_200)).toBe("3d");
  });
  it("renders an em-dash for unknown durations, but 0s for a real fast run", () => {
    // "no data" and "finished in under a second" are different facts.
    expect(formatSessionDuration(undefined)).toBe("—");
    expect(formatSessionDuration(null)).toBe("—");
    expect(formatSessionDuration(-5)).toBe("—");
    expect(formatSessionDuration(NaN)).toBe("—");
    expect(formatSessionDuration(0)).toBe("0s");
  });
});

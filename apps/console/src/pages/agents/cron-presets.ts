// Preset ⇄ cron mapping for the schedule forms.
//
// The backend takes a raw 5-field cron (`agent_schedules.cron_expression`,
// see AGENTS.md "Agent Schedules") and seeds `next_run_at` from it. Most
// people want one of a handful of cadences, so the Console offers those by
// name and keeps the raw field as the escape hatch.
//
// Deliberately hand-rolled: the console has no cron parser on its
// dependency list and one isn't worth adding to render six sentences. These
// functions therefore only understand the shapes this picker itself emits —
// `matchCron` returns "custom" for anything else, which is exactly the
// behavior the form wants (an unrecognized expression opens in Custom mode
// with the raw text preserved).

export type CronPresetId =
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "monthly"
  | "custom";

/** Cadence parameters. Which fields matter depends on the preset. */
export interface CronPresetValue {
  preset: CronPresetId;
  /** 0–23. Ignored by `hourly`. */
  hour: number;
  /** 0–59. Used by every preset. */
  minute: number;
  /** 0 (Sunday) – 6 (Saturday). Only used by `weekly`. */
  weekday: number;
  /** 1–28. Only used by `monthly`; capped so every month actually fires. */
  day: number;
  /** Raw expression — authoritative when `preset === "custom"`. */
  expression: string;
}

export const WEEKDAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export const CRON_PRESETS: { id: CronPresetId; label: string }[] = [
  { id: "hourly", label: "Every hour" },
  { id: "daily", label: "Daily" },
  { id: "weekdays", label: "Weekdays (Mon–Fri)" },
  { id: "weekly", label: "Weekly" },
  { id: "monthly", label: "Monthly" },
  { id: "custom", label: "Custom (cron)" },
];

/** Defaults chosen so the first render is already a sane schedule: 9 AM,
 *  Monday, the 1st — the cadences the docs use as examples. */
export const DEFAULT_CRON_VALUE: CronPresetValue = {
  preset: "weekly",
  hour: 9,
  minute: 0,
  weekday: 1,
  day: 1,
  expression: "0 9 * * 1",
};

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** The cron expression a preset + its parameters produce. `custom` passes
 *  the raw expression straight through. */
export function buildCron(value: CronPresetValue): string {
  const minute = clamp(value.minute, 0, 59);
  const hour = clamp(value.hour, 0, 23);
  switch (value.preset) {
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${clamp(value.weekday, 0, 6)}`;
    case "monthly":
      return `${minute} ${hour} ${clamp(value.day, 1, 28)} * *`;
    case "custom":
      return value.expression;
  }
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** 14:05 → "2:05 PM". The summary reads as a sentence, so a 12-hour clock
 *  matches how the presets are named ("Daily at 9 AM"). */
export function formatClock(hour: number, minute: number): string {
  const h = clamp(hour, 0, 23);
  const m = clamp(minute, 0, 59);
  const suffix = h < 12 ? "AM" : "PM";
  const twelve = h % 12 === 0 ? 12 : h % 12;
  return m === 0 ? `${twelve} ${suffix}` : `${twelve}:${pad(m)} ${suffix}`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * One sentence describing when this fires, for the form's summary line.
 * Timezone is appended by the caller when known — the cadence itself is
 * timezone-agnostic. `custom` gets no cadence claim: we can't describe an
 * arbitrary expression without a parser, and a wrong description is worse
 * than none.
 */
export function describeCron(value: CronPresetValue): string {
  const at = formatClock(value.hour, value.minute);
  switch (value.preset) {
    case "hourly":
      return value.minute === 0
        ? "Every hour, on the hour"
        : `Every hour, at ${clamp(value.minute, 0, 59)} minutes past`;
    case "daily":
      return `Every day at ${at}`;
    case "weekdays":
      return `Every weekday (Mon–Fri) at ${at}`;
    case "weekly":
      return `Every ${WEEKDAY_NAMES[clamp(value.weekday, 0, 6)]} at ${at}`;
    case "monthly":
      return `On the ${ordinal(clamp(value.day, 1, 28))} of each month at ${at}`;
    case "custom":
      return "Runs on the cron expression above";
  }
}

const NUM = /^\d+$/;

/**
 * Best-effort inverse of `buildCron`, used to open an existing schedule on
 * the preset it was created from. Anything this picker didn't emit — step
 * values, lists, named days, non-5-field expressions — falls back to
 * `custom` with the expression preserved verbatim.
 */
export function matchCron(expression: string): CronPresetValue {
  const raw = expression.trim();
  const fallback: CronPresetValue = { ...DEFAULT_CRON_VALUE, preset: "custom", expression: raw };
  const parts = raw.split(/\s+/);
  if (parts.length !== 5) return fallback;

  const [min, hr, dom, mon, dow] = parts;
  if (!NUM.test(min) || mon !== "*") return fallback;
  const minute = Number(min);
  if (minute > 59) return fallback;

  // Every hour: minute fixed, everything else wild.
  if (hr === "*" && dom === "*" && dow === "*") {
    return { ...fallback, preset: "hourly", minute, expression: raw };
  }
  if (!NUM.test(hr)) return fallback;
  const hour = Number(hr);
  if (hour > 23) return fallback;
  const base = { ...fallback, minute, hour, expression: raw };

  if (dom === "*" && dow === "*") return { ...base, preset: "daily" };
  if (dom === "*" && dow === "1-5") return { ...base, preset: "weekdays" };
  if (dom === "*" && NUM.test(dow) && Number(dow) <= 6) {
    return { ...base, preset: "weekly", weekday: Number(dow) };
  }
  if (dow === "*" && NUM.test(dom) && Number(dom) >= 1 && Number(dom) <= 28) {
    return { ...base, preset: "monthly", day: Number(dom) };
  }
  return fallback;
}

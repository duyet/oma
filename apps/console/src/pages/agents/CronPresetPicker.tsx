import {
  CalendarClockIcon,
  CalendarDaysIcon,
  CalendarRangeIcon,
  ClockIcon,
  SunriseIcon,
  TerminalIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { Select, SelectOption } from "@/components/ui/form-select";
import {
  CRON_PRESETS,
  WEEKDAY_NAMES,
  buildCron,
  describeCron,
  type CronPresetId,
  type CronPresetValue,
} from "./cron-presets";

/** One icon per cadence, so the list is scannable by shape before it's read.
 *  Lives here rather than in `cron-presets.ts` to keep that module free of
 *  JSX/React imports — it's imported by pure mapping tests. */
const PRESET_ICONS: Record<CronPresetId, ComponentType<{ className?: string }>> = {
  hourly: ClockIcon,
  daily: SunriseIcon,
  weekdays: CalendarRangeIcon,
  weekly: CalendarDaysIcon,
  monthly: CalendarClockIcon,
  custom: TerminalIcon,
};

const ICON_CLS = "h-4 w-4 shrink-0 text-fg-muted";

/**
 * Cadence picker shared by the agent-schedule and deployment-trigger forms.
 * Presets cover the common cadences; "Custom (cron)" reveals the raw field,
 * prefilled from whatever preset was selected so a power user edits a
 * working expression rather than starting from a blank box.
 *
 * Controlled: the parent owns a `CronPresetValue` and derives the wire
 * value with `buildCron(value)`. The summary line describes the cadence
 * only — the next run time is computed server-side (`next_run_at` is seeded
 * from the cron + timezone at create), and duplicating that math in the
 * browser would risk disagreeing with what actually fires.
 */
interface Props {
  value: CronPresetValue;
  onChange: (next: CronPresetValue) => void;
  /** Shown in the summary line so the cadence isn't read in the wrong zone. */
  timezone?: string;
  /** Prefix for field ids so two pickers can coexist on one page. */
  idPrefix: string;
  /** Tighter type scale for the deployment dialog's nested trigger block. */
  compact?: boolean;
}

const inputCls =
  "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors";

export function CronPresetPicker({
  value,
  onChange,
  timezone,
  idPrefix,
  compact = false,
}: Props) {
  const labelCls = `${compact ? "text-xs" : "text-sm"} text-fg-muted block mb-1`;
  const showTime = value.preset !== "hourly" && value.preset !== "custom";

  // Switching preset re-derives the expression so Custom always opens on the
  // cadence the user was just looking at.
  const setPreset = (preset: CronPresetId) => {
    if (preset === "custom") {
      onChange({ ...value, preset, expression: buildCron(value) });
      return;
    }
    const next = { ...value, preset };
    onChange({ ...next, expression: buildCron(next) });
  };

  const patch = (fields: Partial<CronPresetValue>) => {
    const next = { ...value, ...fields };
    onChange({ ...next, expression: buildCron(next) });
  };

  return (
    <div className="space-y-2">
      <div>
        <span className={labelCls}>Repeats</span>
        <Select
          value={value.preset}
          onValueChange={(v) => setPreset(v as CronPresetId)}
          placeholder="Select cadence"
        >
          {CRON_PRESETS.map((p) => {
            const Icon = PRESET_ICONS[p.id];
            return (
              <SelectOption key={p.id} value={p.id}>
                <span className="flex items-center gap-2">
                  <Icon className={ICON_CLS} />
                  {p.label}
                </span>
              </SelectOption>
            );
          })}
        </Select>
      </div>

      {value.preset === "weekly" && (
        <div>
          <span className={labelCls}>Day of week</span>
          <Select
            value={String(value.weekday)}
            onValueChange={(v) => patch({ weekday: Number(v) })}
            placeholder="Select day of week"
          >
            {WEEKDAY_NAMES.map((name, i) => (
              <SelectOption key={name} value={String(i)}>
                {name}
              </SelectOption>
            ))}
          </Select>
        </div>
      )}

      {value.preset === "monthly" && (
        <div>
          <span className={labelCls}>Day of month</span>
          {/* Capped at 28 so the schedule fires in February too. */}
          <Select
            value={String(value.day)}
            onValueChange={(v) => patch({ day: Number(v) })}
            placeholder="Select day of month"
          >
            {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
              <SelectOption key={d} value={String(d)}>
                {d}
              </SelectOption>
            ))}
          </Select>
        </div>
      )}

      {value.preset === "hourly" && (
        <div>
          <label htmlFor={`${idPrefix}-minute`} className={labelCls}>
            Minutes past the hour
          </label>
          <input
            id={`${idPrefix}-minute`}
            type="number"
            min={0}
            max={59}
            value={value.minute}
            onChange={(e) => patch({ minute: Number(e.target.value) })}
            className={inputCls}
          />
        </div>
      )}

      {showTime && (
        <div>
          <label htmlFor={`${idPrefix}-time`} className={labelCls}>
            Time
          </label>
          <input
            id={`${idPrefix}-time`}
            type="time"
            value={`${String(value.hour).padStart(2, "0")}:${String(value.minute).padStart(2, "0")}`}
            onChange={(e) => {
              const [h, m] = e.target.value.split(":");
              patch({ hour: Number(h), minute: Number(m) });
            }}
            className={inputCls}
          />
        </div>
      )}

      {value.preset === "custom" && (
        <div>
          <label htmlFor={`${idPrefix}-cron`} className={labelCls}>
            Cron expression
          </label>
          <input
            id={`${idPrefix}-cron`}
            value={value.expression}
            onChange={(e) => onChange({ ...value, expression: e.target.value })}
            className={`${inputCls} font-mono`}
            placeholder="0 9 * * 1"
          />
        </div>
      )}

      <p className="text-xs text-fg-subtle" data-testid={`${idPrefix}-summary`}>
        {describeCron(value)}
        {timezone ? ` (${timezone})` : ""} ·{" "}
        <code className="font-mono text-fg-muted">{buildCron(value)}</code>
      </p>
    </div>
  );
}

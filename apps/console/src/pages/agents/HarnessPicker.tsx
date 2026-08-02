/**
 * Rich harness picker for the agent form — selectable cards instead of a bare
 * `<select>`. Writes the same `form.harness` value the old dropdown wrote (no
 * API change); the Local card delegates to the dialog's Cloud/Local control.
 */
import {
  CLOUD_HARNESS_OPTIONS,
  LOCAL_HARNESS_OPTIONS,
  type CloudHarnessId,
  type HarnessOption,
} from "./harness-options";

interface HarnessPickerProps {
  value: CloudHarnessId;
  onChange: (id: CloudHarnessId) => void;
  /** Invoked when the user picks a local/CLI runtime card. */
  onSelectLocal: () => void;
}

function HarnessCard({
  option,
  selected,
  onClick,
}: {
  option: HarnessOption;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={option.name}
      onClick={onClick}
      className={`text-left flex flex-col gap-1 rounded-md border px-3 py-2 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
        selected
          ? "border-brand bg-brand/5 text-fg"
          : "border-border text-fg-muted hover:border-border-strong"
      }`}
    >
      <span className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-fg">{option.name}</span>
        {option.recommended && (
          <span className="text-[10px] uppercase tracking-wide rounded px-1 py-0.5 border border-brand/40 text-brand">
            Recommended
          </span>
        )}
        <span className="text-[10px] rounded px-1 py-0.5 bg-bg-surface text-fg-subtle">
          {option.badge}
        </span>
      </span>
      <span className="text-xs text-fg-subtle">{option.summary}</span>
      <span className="text-xs text-fg-subtle">{option.bestFor}</span>
    </button>
  );
}

export function HarnessPicker({ value, onChange, onSelectLocal }: HarnessPickerProps) {
  return (
    <div>
      <label className="text-sm font-medium text-fg block mb-1">Harness</label>
      <p className="text-xs text-fg-subtle mb-2">
        What drives this agent's loop, and where it runs. Pick this first — it decides how the
        model field below is used.
      </p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" role="radiogroup" aria-label="Harness">
        {CLOUD_HARNESS_OPTIONS.map((o) => (
          <HarnessCard
            key={o.id}
            option={o}
            selected={value === o.id}
            onClick={() => onChange(o.id as CloudHarnessId)}
          />
        ))}
      </div>
      <div className="mt-3">
        <p className="text-xs font-medium text-fg-muted mb-1">On your own machine</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {LOCAL_HARNESS_OPTIONS.map((o) => (
            <HarnessCard key={o.id} option={o} selected={false} onClick={onSelectLocal} />
          ))}
        </div>
      </div>
    </div>
  );
}

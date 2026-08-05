/**
 * Rich harness picker for the agent form — selectable cards instead of a bare
 * `<select>`. Writes the same `form.harness` value the old dropdown wrote (no
 * API change); the Local card delegates to the dialog's Cloud/Local control.
 */
import {
  CLOUD_HARNESS_OPTIONS,
  LOCAL_HARNESS_OPTIONS,
  legacyHarnessOption,
  type CloudHarnessId,
  type HarnessOption,
} from "./harness-options";

interface HarnessPickerProps {
  value: string;
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
      disabled={option.legacy}
      className={`text-left disabled:cursor-default flex flex-col gap-1 rounded-md border px-3 py-2 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
        selected
          ? "border-brand bg-brand/5 text-fg"
          : "border-border text-fg-muted hover:border-border-strong"
      }`}
    >
      <span className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-medium text-fg">{option.name}</span>
        {option.legacy && (
          <span className="text-[10px] uppercase tracking-wide rounded px-1 py-0.5 border border-border-strong text-fg-subtle">
            Legacy
          </span>
        )}
        {option.recommended && (
          <span className="text-[10px] uppercase tracking-wide rounded px-1 py-0.5 border border-brand/40 text-brand">
            Recommended
          </span>
        )}
        {option.tag && (
          <span className="text-[10px] uppercase tracking-wide rounded px-1 py-0.5 border border-border text-fg-muted">
            {option.tag}
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
  // An agent created before the picker was narrowed keeps its harness; it is
  // shown as a read-only card so saving the form can't silently rewrite it.
  const legacy = CLOUD_HARNESS_OPTIONS.some((o) => o.id === value)
    ? undefined
    : legacyHarnessOption(value);
  const selected = harnessOptionById(value);
  return (
    <div>
      <label className="text-sm font-medium text-fg block mb-1">Harness</label>
      <p className="text-xs text-fg-subtle mb-2">
        What drives this agent&apos;s loop, and where it can run. Pick this first — it decides how
        the model field below is used and which features (MCP, providers) apply.
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
        {legacy && <HarnessCard option={legacy} selected onClick={() => {}} />}
      </div>
      {selected?.capabilities && selected.capabilities.length > 0 && (
        <ul className="mt-2 text-xs text-fg-subtle bg-bg-surface rounded-lg px-3 py-2 space-y-1 list-disc list-inside">
          {selected.capabilities.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      )}
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

function harnessOptionById(id: string): HarnessOption | undefined {
  return CLOUD_HARNESS_OPTIONS.find((o) => o.id === id) ?? legacyHarnessOption(id);
}

// Shared "How it fits together" diagram — presentational, host-agnostic.
// Used by both the Console dashboard (apps/console/src/components/StackedAssembly.tsx,
// live data + navigation + capacity-accordion collapse) and the landing page
// (apps/web/src/components/HowItFits.tsx, static demo data + click-to-describe
// dialog). Neither host's data-fetching or navigation logic lives here — only
// the layout, the card chrome, and (opt-in via `collapsible`) the
// ResizeObserver-driven column-collapse behavior moved over from Console.
//
// Styling: plain Tailwind utility classes against the `--color-*` theme
// tokens (bg-bg, text-fg, border-border, …). Both apps' Tailwind v4 `@theme`
// blocks define the same token names (see apps/console/src/index.css and
// apps/web/src/styles/global.css), so the classes below resolve to the
// correct value on either host without a mapping layer. Web's theme didn't
// define --color-success/--color-warning; added minimal entries there for
// the status dot (see apps/web/src/styles/global.css).
import { Fragment, useCallback, useRef, useState } from "react";
import { ArrowDownIcon, ArrowRightIcon, CheckIcon, ChevronsLeftIcon, ChevronsRightIcon } from "lucide-react";
import { cn } from "./cn";
import { ProviderMark } from "./ProviderMark";
import type { FitCard, FitFormulaRow, FitProviderMark, FitRow, FitStep } from "./types";

const BADGE_CAP = 3;

const DOT_CLASS: Record<NonNullable<FitCard["status"]>, string> = {
  ready: "bg-success",
  attention: "bg-warning",
  empty: "border border-border bg-transparent",
};

function StatusDot({ status, dashed }: { status?: FitCard["status"]; dashed?: boolean }) {
  // No explicit status: dashed cards read as empty, solid cards as ready.
  const resolved = status ?? (dashed ? "empty" : "ready");
  return <span className={cn("shrink-0 w-2 h-2 rounded-full", DOT_CLASS[resolved])} aria-hidden="true" />;
}

function InstanceBadges({ names }: { names: string[] }) {
  const shown = names.slice(0, BADGE_CAP);
  const rest = names.length - shown.length;
  return (
    <div className="mt-1.5 flex flex-wrap gap-1">
      {shown.map((n) => (
        <span
          key={n}
          className="inline-flex max-w-[9.5rem] truncate rounded-[4px] border border-border bg-bg-surface/60 px-1.5 py-0.5 text-[11px] leading-tight text-fg-muted"
        >
          {n}
        </span>
      ))}
      {rest > 0 && (
        <span className="inline-flex rounded-[4px] px-1 py-0.5 text-[11px] leading-tight text-fg-subtle">
          +{rest}
        </span>
      )}
    </div>
  );
}

function ProviderMarkGroup({ marks }: { marks: FitProviderMark[] }) {
  // Active marks (colored) sort ahead of inactive (gray) ones so the healthy
  // providers lead the avatar-group and the "+N" overflow drops idle ones first.
  const norm = marks
    .map((m) => (typeof m === "string" ? { id: m, active: true } : { id: m.id, active: m.active !== false }))
    .sort((a, b) => Number(b.active) - Number(a.active));
  return (
    <div className="mt-2 flex items-center -space-x-1.5">
      {norm.slice(0, 5).map((m) => (
        <span
          key={m.id}
          title={m.active ? m.id : `${m.id} (idle)`}
          className={cn(
            "flex size-6 items-center justify-center rounded-full border border-border bg-bg-surface ring-2 ring-bg",
            !m.active && "opacity-45 grayscale",
          )}
        >
          <ProviderMark id={m.id} colored={m.active} className="size-3.5 text-fg-muted" />
        </span>
      ))}
      {norm.length > 5 && (
        <span className="flex size-6 items-center justify-center rounded-full border border-border bg-bg-surface ring-2 ring-bg text-[10px] font-medium text-fg-muted">
          +{norm.length - 5}
        </span>
      )}
    </div>
  );
}

function FitCardView({ card }: { card: FitCard }) {
  const empty = card.status === "empty";
  const badges = card.badges ?? [];
  return (
    <button
      type="button"
      aria-label={
        card.description
          ? `What is ${card.title}?`
          : `${card.title} — ${empty ? "not set up yet" : badges.join(", ")}`
      }
      aria-haspopup={card.description ? "dialog" : undefined}
      onClick={card.onActivate}
      className={cn(
        "group relative w-full text-left rounded-md border px-3.5 py-3 cursor-pointer select-none",
        "active:translate-y-px transition-[color,background-color,border-color,transform,opacity] duration-[var(--dur-quick)] ease-[var(--ease-soft)]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/50",
        card.dashed || empty
          ? "border-dashed border-border bg-bg opacity-70 hover:opacity-100 hover:border-border-strong"
          : card.hero
            ? "border-brand/50 bg-brand/5 hover:border-brand"
            : "border-border bg-bg hover:border-border-strong hover:bg-bg-surface/40",
      )}
    >
      <div className="flex items-center gap-2">
        {card.icon && (
          <span className={cn("shrink-0", card.hero ? "text-brand" : "text-fg-subtle")}>
            {card.icon}
          </span>
        )}
        <span
          className={cn(
            "flex-1 min-w-0 truncate text-fg",
            card.hero ? "text-[15px] font-semibold" : "text-[13px] font-medium",
          )}
        >
          {card.title}
        </span>
        <StatusDot status={card.status} dashed={card.dashed} />
      </div>
      {card.note && <div className="mt-1 text-[11px] leading-snug text-fg-muted">{card.note}</div>}
      {!card.note && card.description && !card.badges ? (
        <div className="mt-1 text-[11px] leading-snug text-fg-muted">{card.description}</div>
      ) : empty && card.emptyCta ? (
        <div className="mt-1 text-[11px] leading-snug text-fg-muted">{card.emptyCta}</div>
      ) : badges.length > 0 ? (
        <InstanceBadges names={badges} />
      ) : null}
      {card.providerMarks && card.providerMarks.length > 0 && (
        <ProviderMarkGroup marks={card.providerMarks} />
      )}
    </button>
  );
}

/** The `agent = model + skills + mcp` composition rule, stated outright. */
export function FitFormula({ rows }: { rows: FitFormulaRow[] }) {
  return (
    <div className="mb-5 rounded-md border border-border bg-bg-surface px-3.5 py-2.5">
      <div className="flex flex-col gap-1 font-mono text-[12px] leading-relaxed">
        {rows.map((r) => (
          <div key={r.lhs} data-testid={`formula-${r.lhs}`} className="flex items-baseline gap-1.5">
            <span className="w-[3.75rem] shrink-0 font-semibold text-brand">{r.lhs}</span>
            <span className="text-fg-subtle">=</span>
            <span className="text-fg-muted">
              {r.parts.map((p, i) => (
                <Fragment key={p}>
                  {i > 0 && <span className="text-fg-subtle"> + </span>}
                  <span className="text-fg">{p}</span>
                </Fragment>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FlowPointer() {
  return (
    <div className="flex shrink-0 items-center justify-center self-center px-0.5 text-fg-subtle" aria-hidden="true">
      <ArrowRightIcon className="h-3.5 w-3.5" />
    </div>
  );
}

const rowKey = (row: FitRow) => (Array.isArray(row) ? row.map((c) => c.key).join("+") : row.key);

function StepHeader({ step, onCollapse }: { step: FitStep; onCollapse?: () => void }) {
  return (
    <div className="mb-2.5 flex items-center gap-1.5">
      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-fg-subtle">
        {step.number} · {step.name}
      </span>
      {step.optional && (
        <span className="rounded-full border border-border px-1.5 py-px text-[9px] uppercase tracking-[0.08em] text-fg-subtle">
          optional
        </span>
      )}
      {step.done && (
        <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-success/15 text-success" aria-label="complete">
          <CheckIcon className="h-2.5 w-2.5" strokeWidth={3} />
        </span>
      )}
      {onCollapse && (
        <button
          type="button"
          onClick={onCollapse}
          aria-label={`Collapse ${step.name}`}
          className="ml-auto flex h-5 w-5 items-center justify-center rounded text-fg-subtle transition-colors hover:bg-bg-surface hover:text-fg"
        >
          <ChevronsLeftIcon className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function ExpandedStepPanel({
  step,
  onCollapse,
  onHeight,
}: {
  step: FitStep;
  onCollapse?: () => void;
  /** Reports this panel's outer height so the row can lock a floor and
   *  avoid layout jump when other columns collapse to rails. */
  onHeight?: (height: number) => void;
}) {
  const heightRo = useRef<ResizeObserver | null>(null);
  const panelRef = useCallback(
    (el: HTMLDivElement | null) => {
      heightRo.current?.disconnect();
      heightRo.current = null;
      if (!el || !onHeight || typeof ResizeObserver === "undefined") return;
      const ro = new ResizeObserver((entries) => {
        const h = entries[0]?.contentRect.height ?? 0;
        if (h > 0) onHeight(h);
      });
      ro.observe(el);
      heightRo.current = ro;
      // Immediate read for the first paint (before RO fires).
      if (el.offsetHeight > 0) onHeight(el.offsetHeight);
    },
    [onHeight],
  );

  return (
    // Open panels get a solid border; only collapsed rails stay dashed.
    <div
      ref={panelRef}
      className={cn(
        "flex h-full min-w-0 flex-1 flex-col rounded-lg border border-border bg-bg-surface p-3",
        step.wide && "flex-[1.2]",
      )}
    >
      <StepHeader step={step} onCollapse={onCollapse} />
      <div className={cn("flex flex-1 flex-col justify-center", step.chain ? "gap-0" : "gap-2")}>
        {step.cards.map((row, i) => (
          <Fragment key={rowKey(row)}>
            {step.chain && i > 0 && (
              <div className="flex items-center justify-center gap-1.5 py-1 text-fg-subtle" aria-hidden="true">
                <ArrowDownIcon className="h-3.5 w-3.5" />
                {step.chainLabels?.[i - 1] && <span className="font-mono text-[10px]">{step.chainLabels[i - 1]}</span>}
              </div>
            )}
            {Array.isArray(row) ? (
              <div className="fit-rise flex flex-wrap items-stretch gap-2" style={{ animationDelay: `${i * 45}ms` }}>
                {row.map((c) => (
                  <div key={c.key} className="flex min-w-[8.5rem] flex-1">
                    <FitCardView card={c} />
                  </div>
                ))}
              </div>
            ) : (
              <div className="fit-rise" style={{ animationDelay: `${i * 45}ms` }}>
                <FitCardView card={row} />
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function StepPanel({
  step,
  collapsed,
  onToggle,
  onHeight,
}: {
  step: FitStep;
  collapsed: boolean;
  onToggle: (expand: boolean) => void;
  onHeight?: (height: number) => void;
}) {
  // The wrapper always renders and animates flex-grow/flex-basis — both
  // numeric, so the column smoothly widens/narrows between rail and panel.
  return (
    <div
      className="flex min-h-0 min-w-0 self-stretch transition-[flex-grow,flex-basis] duration-[var(--dur-slow,220ms)] ease-[var(--ease-soft,ease-out)] motion-reduce:transition-none"
      style={
        collapsed
          ? { flexGrow: 0.0001, flexBasis: "2.75rem" }
          : { flexGrow: step.wide ? 1.2 : 1, flexBasis: "0%" }
      }
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => onToggle(true)}
          aria-label={`Expand step ${step.number} — ${step.name}`}
          aria-expanded="false"
          className="fit-rise flex h-full w-full flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border/70 bg-bg-surface px-1.5 py-3 text-fg-subtle transition-colors hover:border-border-strong hover:text-fg"
        >
          <ChevronsRightIcon className="h-3.5 w-3.5" />
          <span className="font-mono text-[10px] uppercase tracking-[0.12em]" style={{ writingMode: "vertical-rl" }}>
            {step.number} · {step.name}
          </span>
          {step.done && (
            <span className="flex h-4 w-4 items-center justify-center rounded-full bg-success/15 text-success">
              <CheckIcon className="h-2.5 w-2.5" strokeWidth={3} />
            </span>
          )}
        </button>
      ) : (
        <ExpandedStepPanel step={step} onCollapse={() => onToggle(false)} onHeight={onHeight} />
      )}
    </div>
  );
}

const FIT_KEYFRAMES = `
@keyframes fit-rise { from { opacity: 0; transform: translateY(4px) } to { opacity: 1; transform: none } }
.fit-rise { animation: fit-rise var(--dur-slow, 220ms) var(--ease-soft, ease-out) both }
@media (prefers-reduced-motion: reduce) { .fit-rise { animation: none } }
`;

const MIN_COL = 250;
const RAIL = 60; // rail width + pointer

/** Capacity-accordion collapse: expanded columns need ~MIN_COL px each; when
 *  the measured row can't fit all steps, the lowest-priority columns
 *  collapse to rails. A user click is an override — expanding a rail when
 *  the row is full evicts the least-recently-wanted expanded column. */
function useCapacityAccordion(steps: FitStep[]) {
  const [rowWidth, setRowWidth] = useState<number | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const rowRef = (el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      // `|| null`: jsdom's ResizeObserver reports 0 — treat as unmeasured
      // (no auto-collapse) rather than collapsing everything to rails.
      setRowWidth(entries[0]?.contentRect.width || null);
    });
    ro.observe(el);
    roRef.current = ro;
  };
  const [intent, setIntent] = useState<string[]>([]);

  const capacity = (() => {
    if (rowWidth == null) return steps.length; // unmeasured (SSR/jsdom): no auto-collapse
    for (let open = steps.length; open >= 1; open--) {
      if (open * MIN_COL + (steps.length - open) * RAIL <= rowWidth) return open;
    }
    return 1;
  })();

  const expandedSet = (() => {
    const userExpanded = intent.filter((n) => !n.startsWith("!"));
    const userCollapsed = new Set(intent.filter((n) => n.startsWith("!")).map((n) => n.slice(1)));
    // Priority: middle steps (2, 3) first, then edges (1, 4), with
    // not-yet-done optional steps last — they still expand when there's room.
    const basePriority = [...steps]
      .sort(
        (a, b) =>
          Number(a.optional && !a.done) - Number(b.optional && !b.done) ||
          Number(a.number === "1" || a.number === "4") - Number(b.number === "1" || b.number === "4"),
      )
      .map((s) => s.number);
    const ordered = [
      ...userExpanded,
      ...basePriority.filter((n) => !userExpanded.includes(n) && !userCollapsed.has(n)),
    ];
    return new Set(ordered.slice(0, capacity));
  })();

  const toggleStep = (num: string, expand: boolean) => {
    setIntent((prev) => {
      const rest = prev.filter((n) => n !== num && n !== `!${num}`);
      return expand ? [num, ...rest] : [`!${num}`, ...rest];
    });
  };

  return { rowRef, expandedSet, toggleStep };
}

export interface FitDiagramProps {
  steps: FitStep[];
  /** Renders the `agent = model + skills + mcp` box above the flow. */
  formula?: FitFormulaRow[];
  /** Opt into the ResizeObserver-driven capacity-accordion column collapse.
   *  Both hosts pass this — without it, narrow viewports overflow since the
   *  row never stacks vertically. */
  collapsible?: boolean;
  className?: string;
}

export function FitDiagram({ steps, formula, collapsible, className }: FitDiagramProps) {
  const { rowRef, expandedSet, toggleStep } = useCapacityAccordion(steps);
  // Grow-only floor: once an expanded panel has been measured, never let the
  // row shrink below that height when columns collapse to rails. Prevents the
  // rest of the page from jumping under the diagram.
  const [rowFloor, setRowFloor] = useState(0);
  const reportHeight = useCallback((h: number) => {
    setRowFloor((prev) => (h > prev ? Math.ceil(h) : prev));
  }, []);
  // Baseline floor before first measure (and for non-collapsible hosts).
  const floorPx = Math.max(rowFloor, 320);

  return (
    <div className={className}>
      {/* Self-contained keyframes — the package ships no CSS file, so the
          rise-in animation lives here and works on any host. */}
      <style>{FIT_KEYFRAMES}</style>
      {formula && <FitFormula rows={formula} />}
      {/* Always a single horizontal row — narrow viewports collapse columns
          to rails (capacity accordion) instead of stacking to 4 rows.
          minHeight is a grow-only floor from measured expanded panels so
          collapse never reflows the page under the diagram. */}
      <div
        ref={collapsible ? rowRef : undefined}
        className="flex flex-row items-stretch"
        style={{ minHeight: floorPx }}
      >
        {steps.map((s, i) => (
          <Fragment key={s.number}>
            {i > 0 && <FlowPointer />}
            {collapsible ? (
              <StepPanel
                step={s}
                collapsed={!expandedSet.has(s.number)}
                onToggle={(expand) => toggleStep(s.number, expand)}
                onHeight={reportHeight}
              />
            ) : (
              <ExpandedStepPanel step={s} onHeight={reportHeight} />
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

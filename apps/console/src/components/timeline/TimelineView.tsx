import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { formatDuration, pickTickStep } from "../../lib/format";
import type { Event } from "../../lib/events";
import { rowActivateKeyDown } from "@/lib/utils";
import { ResponsiveRail } from "@/components/ResponsiveRail";
import { bucketIntoTurns, deriveSpans } from "./derive";
import {
  DURATION_COL_W,
  FAMILY_BAR,
  FAMILY_CHIP,
  FAMILY_DOT,
  FAMILY_LABEL,
  FAMILY_ORDER,
  LABEL_COL_W,
  STATUS_BADGE,
  TRIGGER_DOT,
  TRIGGER_LABEL,
  type Span,
  type SpanFamily,
  type TimelineSelection,
  type Turn,
  type TurnTriggerKind,
} from "./types";

// Chart-area sizing. MIN_CHART_PX keeps a very short/sparse turn from
// rendering an unreadably narrow bar strip; CHART_RIGHT_PADDING leaves
// room so the last tick label + bar don't collide with the duration
// column.
const MIN_CHART_PX = 200;
const CHART_RIGHT_PADDING = 64;

/**
 * Top-level timeline orchestrator. Buckets events into turns, renders one
 * TurnCard per turn with idle dividers between, and hosts the shared
 * right-side detail panel that any span click in any card populates.
 *
 * Each turn auto-fits its own span chart to the available width (see
 * TurnCard) — there's deliberately no per-card zoom control. A session's
 * turns rarely share a natural timescale (a 200ms tool round-trip and a
 * 1-hour scheduled wait don't belong on the same axis), so a single
 * shared zoom control would either be useless for most cards or force
 * users to keep re-zooming per card anyway. Auto-fit removes that
 * friction entirely instead of just relocating it.
 */
export function TimelineView({ events }: { events: Event[] }) {
  const turns = useMemo(() => bucketIntoTurns(events), [events]);
  // Single pass over the full event stream purely to know which span
  // families actually occur, for the legend. Cheap (linear) and doesn't
  // touch derive.ts — the per-turn chart data is still derived
  // independently inside each TurnCard from turn-relative timestamps.
  const presentFamilies = useMemo(() => {
    const { spans } = deriveSpans(events);
    const seen = new Set<SpanFamily>();
    for (const s of spans) seen.add(s.family);
    return FAMILY_ORDER.filter((f) => seen.has(f));
  }, [events]);

  const containerRef = useRef<HTMLDivElement | null>(null);
  const [selection, setSelection] = useState<TimelineSelection | null>(null);

  // Auto-scroll to the latest turn when new ones land. Skip if user has
  // scrolled up — they're inspecting an older turn and shouldn't get yanked.
  useEffect(() => {
    if (!containerRef.current) return;
    const el = containerRef.current;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 200;
    if (nearBottom) {
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    }
  }, [turns.length]);

  if (turns.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-fg-subtle">
        No timing data yet — send a message to populate the timeline.
      </div>
    );
  }

  return (
    <div className="flex-1 flex min-h-0 flex-col">
      <Legend families={presentFamilies} />
      <div className="flex-1 flex min-h-0">
        <div ref={containerRef} className="flex-1 min-w-0 overflow-y-auto px-4 sm:px-8 py-6 space-y-4">
          {turns.map((turn, i) => {
            const prev = i > 0 ? turns[i - 1] : null;
            const idleMs =
              prev && prev.endedAt && turn.triggerTs && turn.triggerTs > prev.endedAt
                ? turn.triggerTs - prev.endedAt
                : 0;
            return (
              <Fragment key={turn.id}>
                {idleMs > 0 && <IdleDivider ms={idleMs} nextKind={turn.triggerKind} />}
                <TurnCard
                  turn={turn}
                  selection={selection}
                  onSelectSpan={(span) =>
                    setSelection((cur) =>
                      cur?.spanKey === span.key
                        ? null
                        : { spanKey: span.key, spanLabel: span.label, events: span.events },
                    )
                  }
                />
              </Fragment>
            );
          })}
        </div>
        {selection && <DetailPanel selection={selection} onClose={() => setSelection(null)} />}
      </div>
    </div>
  );
}

/**
 * One-line color key for the span-kind chips used throughout every turn
 * card. Only lists families actually present in this session's events —
 * a session with no MCP or schedule activity doesn't need those entries.
 */
function Legend({ families }: { families: SpanFamily[] }) {
  if (families.length === 0) return null;
  return (
    <div className="shrink-0 flex flex-wrap items-center gap-x-4 gap-y-1.5 px-4 sm:px-8 py-2 border-b border-border/60 text-[11px] text-fg-subtle">
      {families.map((f) => (
        <span key={f} className="flex items-center gap-1.5">
          <span aria-hidden="true" className={`w-2 h-2 rounded-full shrink-0 ${FAMILY_DOT[f]}`} />
          {FAMILY_LABEL[f]}
        </span>
      ))}
    </div>
  );
}

function IdleDivider({ ms, nextKind }: { ms: number; nextKind: TurnTriggerKind }) {
  return (
    <div className="flex items-center gap-3 text-[11px] text-fg-subtle/80 font-mono py-0.5">
      <div className="flex-1 border-t border-dashed border-border/60" />
      <span>
        ↓ {formatDuration(ms)} idle
        {nextKind === "wakeup" && " · scheduled wakeup"}
      </span>
      <div className="flex-1 border-t border-dashed border-border/60" />
    </div>
  );
}

function DetailPanel({
  selection,
  onClose,
}: {
  selection: TimelineSelection;
  onClose: () => void;
}) {
  return (
    <ResponsiveRail
      open
      onClose={onClose}
      title={selection.spanLabel}
      label="Timeline detail"
      desktopClassName="shrink-0 border-l border-border bg-bg flex flex-col min-h-0 w-[420px]"
    >
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 py-3 border-b border-border flex items-center gap-3 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-fg-subtle font-mono">
            {selection.events.length === 1
              ? "source event"
              : `source events (${selection.events.length})`}
          </div>
          <div className="text-sm font-mono text-fg-muted truncate">{selection.spanLabel}</div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close detail panel"
          className="text-fg-subtle hover:text-fg-muted text-lg leading-none px-2"
          title="Close"
        >
          ×
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {selection.events.map((ev, idx) => (
          <div key={idx} className="border border-border/60 rounded">
            <div className="px-3 py-1.5 border-b border-border/60 bg-bg-surface/40 flex items-center gap-2 text-[11px] font-mono">
              <span className="text-fg-muted">{ev.type}</span>
              {typeof ev.processed_at === "string" && (
                <span className="text-fg-subtle ml-auto">
                  {new Date(ev.processed_at).toISOString().slice(11, 23)}
                </span>
              )}
            </div>
            <pre className="text-[11px] font-mono text-fg-muted px-3 py-2 overflow-x-auto whitespace-pre-wrap break-all">
              {JSON.stringify(ev, null, 2)}
            </pre>
          </div>
        ))}
      </div>
      </div>
    </ResponsiveRail>
  );
}

/**
 * One waterfall row inside a TurnCard. Encapsulates the sticky
 * label-column / chart-area / duration-column layout so callers don't
 * have to re-derive the conditional bg-class for each cell.
 *
 * Pulling this out also kills the previous bug where two of the three
 * cells had `bg-bg-surface/30` and one had a different fallback because
 * I forgot to update them in lockstep.
 */
function TimelineRow({
  isSelected,
  onClick,
  title,
  chartPx,
  leftLabel,
  rightLabel,
  children,
}: {
  isSelected: boolean;
  onClick: () => void;
  title: string;
  chartPx: number;
  leftLabel: ReactNode;
  rightLabel: ReactNode;
  children: ReactNode;
}) {
  const stickyBg = isSelected ? "bg-info-subtle/40" : "bg-bg-surface/20";
  return (
    <div style={{ width: LABEL_COL_W + chartPx + DURATION_COL_W }}>
      <div
        className={`flex items-center py-1.5 border-b border-border/20 hover:bg-bg/40 group cursor-pointer transition-colors ${isSelected ? "bg-info-subtle/40" : ""}`}
        title={title}
        onClick={onClick}
        onKeyDown={rowActivateKeyDown(onClick)}
        tabIndex={0}
        role="button"
      >
        <div
          className={`shrink-0 sticky left-0 z-20 flex items-center gap-2 px-4 group-hover:bg-bg/40 ${stickyBg}`}
          style={{ width: LABEL_COL_W }}
        >
          {leftLabel}
        </div>
        <div className="relative h-6 shrink-0" style={{ width: chartPx }}>
          {children}
        </div>
        <div
          className={`shrink-0 sticky right-0 z-20 text-right text-[11px] font-mono text-fg-subtle pr-3 group-hover:bg-bg/40 ${stickyBg}`}
          style={{ width: DURATION_COL_W }}
        >
          {rightLabel}
        </div>
      </div>
    </div>
  );
}

/**
 * Small colored kind-tag shown at the start of every span row's label
 * column (and reused nowhere else). Anchors the eye to the same
 * horizontal position on every row across every turn, so scanning down a
 * long session reads as "user, model, tool, tool, agent…" at a glance
 * instead of requiring the label text itself to be parsed each time.
 */
function FamilyChip({ family }: { family: SpanFamily }) {
  return (
    <span
      className={`shrink-0 px-1.5 py-0.5 rounded text-[9.5px] font-medium uppercase tracking-wide ${FAMILY_CHIP[family]}`}
    >
      {FAMILY_LABEL[family]}
    </span>
  );
}

function StatusPill({ status, statusLabel }: { status: keyof typeof STATUS_BADGE; statusLabel: string }) {
  return (
    <span
      className={`shrink-0 px-1.5 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wide ${STATUS_BADGE[status]}`}
    >
      {statusLabel}
    </span>
  );
}

/**
 * One turn = one card. Header summarizes the trigger (kind, prompt
 * snippet, span count, duration, token totals, status pill). Body is a
 * per-turn waterfall that auto-fits its density to the available width —
 * see the density-picker effect below for how the scale is chosen.
 */
function TurnCard({
  turn,
  selection,
  onSelectSpan,
}: {
  turn: Turn;
  selection: TimelineSelection | null;
  onSelectSpan: (span: Span) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const { spans, totalMs } = useMemo(() => deriveSpans(turn.events), [turn.events]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [pxPerMs, setPxPerMs] = useState<number | null>(null);

  // Auto-density picker: pick pxPerMs so the median consecutive event
  // gap is ~25px wide, while never going below the rate that fits the
  // turn's full duration inside the viewport (so short/sparse turns
  // never scroll horizontally, and dense turns get spread out enough to
  // stay legible instead of collapsing into an unreadable cluster).
  useEffect(() => {
    if (collapsed || !scrollRef.current || totalMs <= 0) return;
    const viewportChartPx = scrollRef.current.clientWidth - LABEL_COL_W - DURATION_COL_W - CHART_RIGHT_PADDING;
    if (viewportChartPx <= 0) return;
    const times: number[] = [];
    for (const s of spans) {
      times.push(s.startMs);
      if (s.durationMs > 0) times.push(s.startMs + s.durationMs);
    }
    times.sort((a, b) => a - b);
    const gaps: number[] = [];
    for (let i = 1; i < times.length; i++) {
      const g = times[i] - times[i - 1];
      if (g > 0) gaps.push(g);
    }
    let candidate: number;
    if (gaps.length === 0) {
      candidate = viewportChartPx / totalMs;
    } else {
      const sorted = [...gaps].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)] || 1;
      candidate = 25 / median;
    }
    const auto = Math.min(5, Math.max(candidate, viewportChartPx / totalMs));
    setPxPerMs(Math.max(auto, viewportChartPx / totalMs));
  }, [collapsed, spans, totalMs]);

  const effectivePxPerMs = pxPerMs ?? 0.05;
  const chartPx = Math.max(MIN_CHART_PX, totalMs * effectivePxPerMs);

  // Tick spacing: aim for ~120px between labels at the current density.
  // pickTickStep takes a "total span across 6 ticks" arg, so multiply
  // the desired step by 6 to get a step matching ~120px gaps.
  const desiredStepMs = 120 / effectivePxPerMs;
  const tickStep = pickTickStep(desiredStepMs * 6);
  const ticks: number[] = [];
  for (let t = 0; t <= totalMs; t += tickStep) ticks.push(t);

  // Aggregate per-turn cost / token totals from span events that carry
  // model_usage. Cheap walk — span events are already in memory.
  const tokens = useMemo(() => {
    let input = 0;
    let output = 0;
    let cacheRead = 0;
    let calls = 0;
    for (const e of turn.events) {
      if (e.type !== "span.model_request_end") continue;
      const usage =
        (e as { model_usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } }).model_usage ??
        (e.data as { model_usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number } } | undefined)?.model_usage;
      if (usage) {
        input += usage.input_tokens ?? 0;
        output += usage.output_tokens ?? 0;
        cacheRead += usage.cache_read_input_tokens ?? 0;
        calls += 1;
      }
    }
    return { input, output, cacheRead, calls };
  }, [turn.events]);

  const turnDurationMs =
    turn.endedAt && turn.triggerTs ? turn.endedAt - turn.triggerTs : totalMs;

  const triggerTitleText = (() => {
    if (!turn.trigger) return null;
    const c = (turn.trigger as { content?: Array<{ type: string; text?: string }> }).content;
    if (!Array.isArray(c)) return null;
    const t = c.find((b) => b.type === "text")?.text;
    return t ? t.slice(0, 80) : null;
  })();

  const borderClass =
    turn.status === "errored" || turn.status === "terminated"
      ? "border-danger/50"
      : "border-border";

  return (
    <div className={`border ${borderClass} rounded-xl bg-bg-surface/30 overflow-hidden`}>
      {/* Header */}
      <div className="px-4 sm:px-5 py-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <button
          onClick={() => setCollapsed((c) => !c)}
          aria-label={collapsed ? "Expand turn" : "Collapse turn"}
          className="text-fg-subtle hover:text-fg-muted font-mono w-4 text-center shrink-0"
          title={collapsed ? "Expand" : "Collapse"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <span aria-hidden="true" className={`w-1.5 h-1.5 rounded-full shrink-0 ${TRIGGER_DOT[turn.triggerKind]}`} />
        <span className="font-medium text-fg">{TRIGGER_LABEL[turn.triggerKind]}</span>
        {triggerTitleText && (
          <span className="text-fg-subtle truncate max-w-md italic">"{triggerTitleText}"</span>
        )}
        <span className="ml-auto flex items-center gap-3 font-mono text-fg-subtle">
          <span>{spans.length} spans</span>
          <span>{formatDuration(turnDurationMs)}</span>
          {tokens.calls > 0 && (
            <span title={`${tokens.calls} model call${tokens.calls === 1 ? "" : "s"}`}>
              {tokens.input}↓ {tokens.output}↑
              {tokens.cacheRead > 0 && ` ⚡${tokens.cacheRead}`}
            </span>
          )}
          <StatusPill status={turn.status} statusLabel={turn.status} />
        </span>
      </div>

      {!collapsed && spans.length > 0 && (
        <div ref={scrollRef} className="overflow-x-auto pb-3 border-t border-border/40">
          {/* Time axis */}
          <div className="pt-2 sticky top-0 bg-bg-surface/95 backdrop-blur-sm z-10" style={{ width: LABEL_COL_W + chartPx + DURATION_COL_W }}>
            <div className="flex items-center">
              <div className="shrink-0 sticky left-0 bg-bg-surface/95 z-30" style={{ width: LABEL_COL_W }} />
              <div className="relative h-5 border-b border-border/60" style={{ width: chartPx }}>
                {ticks.map((t) => (
                  <div
                    key={t}
                    className="absolute top-0 h-full flex flex-col items-start text-[10px] text-fg-subtle font-mono"
                    style={{ left: `${t * effectivePxPerMs}px` }}
                  >
                    <span className="-translate-x-1/2 px-1">{formatDuration(t)}</span>
                    <div className="w-px flex-1 bg-border/40" />
                  </div>
                ))}
              </div>
              <div className="shrink-0 sticky right-0 bg-bg-surface/95 z-30" style={{ width: DURATION_COL_W }} />
            </div>
          </div>

          {/* Rows */}
          {spans.map((s) => {
            const left = s.startMs * effectivePxPerMs;
            const width = s.durationMs > 0 ? Math.max(3, s.durationMs * effectivePxPerMs) : 0;
            const isSelected = selection?.spanKey === s.key;
            const title = s.detail
              ? `${s.label} — ${formatDuration(s.durationMs)} — ${s.detail}`
              : `${s.label} — ${formatDuration(s.durationMs)}`;
            return (
              <TimelineRow
                key={s.key}
                isSelected={isSelected}
                onClick={() => onSelectSpan(s)}
                title={title}
                chartPx={chartPx}
                leftLabel={
                  <>
                    <FamilyChip family={s.family} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] text-fg-muted">{s.label}</div>
                      {s.detail && (
                        <div className="truncate text-fg-subtle font-mono text-[10px]">{s.detail}</div>
                      )}
                    </div>
                  </>
                }
                rightLabel={s.durationMs > 0 ? formatDuration(s.durationMs) : "—"}
              >
                {width > 0 ? (
                  <>
                    <div
                      className={`absolute h-3.5 top-1/2 -translate-y-1/2 rounded-sm ${FAMILY_BAR[s.family]} group-hover:opacity-100 opacity-90 transition-opacity`}
                      style={{ left: `${left}px`, width: `${width}px` }}
                    />
                    {typeof s.ttftMs === "number" && s.durationMs > 0 && (
                      <div
                        className="absolute h-3.5 top-1/2 -translate-y-1/2 w-px bg-bg-surface"
                        style={{ left: `${left + s.ttftMs * effectivePxPerMs}px` }}
                        title={`TTFT ${formatDuration(s.ttftMs)}`}
                      />
                    )}
                  </>
                ) : (
                  <div
                    aria-hidden="true"
                    className={`absolute top-1/2 -translate-y-1/2 rounded-full ring-2 ring-bg-surface/60 group-hover:scale-125 transition-transform ${FAMILY_DOT[s.family]}`}
                    style={{ left: `${left - 3}px`, width: 6, height: 6 }}
                  />
                )}
              </TimelineRow>
            );
          })}
        </div>
      )}
    </div>
  );
}

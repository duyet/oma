/** Design-space layout for hand-rolled daily-activity SVG bar charts. ViewBox
 *  width is fixed so `preserveAspectRatio="xMidYMid meet"` scales uniformly —
 *  stretching with `none` + a tiny `n*12` viewBox made bars huge and date
 *  labels illegible (see Usage #404). */
export const DAILY_CHART_VIEW_W = 640;
const DAILY_CHART_MIN_LABEL_SLOT = 48;

export function dailyActivitySlot(n: number, viewW = DAILY_CHART_VIEW_W): number {
  return viewW / Math.max(n, 1);
}

export function dailyActivityBarWidth(slot: number): number {
  return Math.min(Math.max(slot * 0.5, 2), 22);
}

export function dailyActivityLabelStep(n: number, slot: number): number {
  const maxLabels = Math.max(2, Math.floor((n * slot) / DAILY_CHART_MIN_LABEL_SLOT));
  return Math.max(1, Math.ceil(n / Math.min(maxLabels, n)));
}

export function dailyActivityTickIndices(n: number, slot: number): number[] {
  if (n <= 0) return [];
  const step = dailyActivityLabelStep(n, slot);
  const ticks: number[] = [];
  for (let i = 0; i < n; i += step) ticks.push(i);
  const last = n - 1;
  if (ticks[ticks.length - 1] !== last) ticks.push(last);
  if (ticks.length >= 2) {
    const gap = ticks[ticks.length - 1]! - ticks[ticks.length - 2]!;
    if (gap * slot < DAILY_CHART_MIN_LABEL_SLOT) ticks.splice(ticks.length - 2, 1);
  }
  return ticks;
}

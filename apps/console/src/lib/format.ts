/**
 * Format a millisecond duration as a short human label:
 * `<1ms`, `123ms`, `1.23s`, `2m17s`. Used in timeline bars + tooltips
 * + turn headers — anywhere we want a compact "took X" indicator.
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1) return "<1ms";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

/**
 * Format a cumulative sandbox-seconds total as a short human duration for
 * dashboard metric cards: `4h 32m`, `12m`, `45s`. Zero/undefined seconds
 * render as "—" so a tenant with no sandbox usage yet reads as an
 * intentional empty state rather than a broken "0h 0m".
 */
export function formatSandboxTime(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(seconds)}s`;
}

/**
 * Format a session's wall-clock span (seconds) at session scale:
 * `8s`, `2m 14s`, `1h 12m`, `3d 4h`. Distinct from `formatDuration`, which
 * targets sub-second tool spans and degrades to `125m30s` for anything
 * over an hour — unusable for a sessions table where multi-hour and
 * multi-day rows are normal.
 *
 * `null`/`undefined`/negative render as an em-dash: a session that has
 * never reported a duration is unknown, not zero.  A real sub-second
 * span floors to `0s` rather than "—" so "ran, and was fast" stays
 * distinguishable from "no data".
 */
export function formatSessionDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return rem > 0 ? `${m}m ${rem}s` : `${m}m`;
  }
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
}

/**
 * Humanize a count into a compact label: `999`, `7.5K`, `105K`, `1.2M`.
 * Values under 1000 render verbatim; the `.0` fraction is dropped so
 * `105000` reads `105K` rather than `105.0K`. `null`/`undefined` render
 * as an em-dash so an absent metric looks intentional. Used by the
 * Observability tab's token / session counters and the per-agent
 * sessions table's Tokens column.
 */
export function formatCompact(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(n);
}

/**
 * Format a USD amount for a stat tile: `$1.23`, `<$0.01` for tiny nonzero
 * amounts (avoids a misleading "$0.00" for real-but-small spend). Shared by
 * the per-agent Observability tab and the tenant-wide Usage page.
 */
export function formatUsd(n: number): string {
  if (n > 0 && n < 0.01) return "<$0.01";
  return `$${n.toFixed(2)}`;
}

/**
 * "12s ago" / "5m ago" / "3d ago" / "8mo ago" — coarse relative time
 * suitable for header chips. Prefer absolute timestamps in tooltips
 * when an exact value matters.
 */
export function formatRelative(diffMs: number): string {
  if (diffMs < 0) diffMs = -diffMs;
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  const mo = Math.floor(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

/**
 * Truncate a long ID like `agt_01ABCDEF...XYZ` to a few-char prefix +
 * ellipsis + suffix, used as a fallback label when the resource's
 * display name hasn't loaded yet. Better than rendering 30 chars of
 * opaque hex in a badge.
 */
export function shortenId(id: string | undefined): string {
  if (!id) return "—";
  if (id.length <= 12) return id;
  return id.slice(0, 8) + "…" + id.slice(-3);
}

/**
 * Snap a time-axis tick step to a friendly unit. Caller passes the
 * total span the chart covers; helper picks the smallest candidate
 * that still keeps tick count near 6. Used by the Timeline waterfall.
 */
export function pickTickStep(totalMs: number): number {
  const target = totalMs / 6;
  const candidates = [10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10_000, 30_000, 60_000, 120_000, 300_000, 600_000];
  for (const c of candidates) if (c >= target) return c;
  return candidates[candidates.length - 1];
}

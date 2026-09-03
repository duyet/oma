import { formatCompact } from "../../lib/format";
import type { TokenMixKind, TokenMixRow } from "../../lib/analytics-snapshot";

const MIX_META: Record<TokenMixKind, { label: string; color: string }> = {
  input: { label: "Input", color: "var(--color-brand)" },
  output: { label: "Output", color: "var(--color-success)" },
  cache_read: { label: "Cache read", color: "var(--color-info)" },
  cache_write: { label: "Cache write", color: "var(--color-chart-4)" },
  reasoning: { label: "Reasoning", color: "var(--color-fg-subtle)" },
};

export function TokenMixBar({ rows }: { rows: TokenMixRow[] }) {
  const total = rows.reduce((n, r) => n + r.tokens, 0);
  if (total === 0) {
    return <p className="text-sm text-muted-foreground">No token usage recorded.</p>;
  }

  return (
    <div className="space-y-2">
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label="Token mix">
        {rows.map((row) => {
          if (row.tokens <= 0) return null;
          const meta = MIX_META[row.kind];
          return (
            <div
              key={row.kind}
              className="h-full"
              style={{
                width: `${row.pct * 100}%`,
                backgroundColor: meta.color,
              }}
              title={`${meta.label}: ${formatCompact(row.tokens)} (${(row.pct * 100).toFixed(0)}%)`}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
        {rows.map((row) => {
          const meta = MIX_META[row.kind];
          return (
            <span key={row.kind} className="inline-flex items-center gap-1.5">
              <span className="size-2 rounded-sm" style={{ backgroundColor: meta.color }} />
              {meta.label} {formatCompact(row.tokens)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

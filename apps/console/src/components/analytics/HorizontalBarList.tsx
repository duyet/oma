import { formatUsd } from "../../lib/format";
import type { CostByAgent } from "../../lib/analytics-snapshot";

export function HorizontalBarList({ cost }: { cost: CostByAgent }) {
  const rows = cost.others ? [...cost.rows, cost.others] : cost.rows;
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">No per-agent spend in this period.</p>;
  }

  return (
    <ul className="space-y-2.5">
      {rows.map((row) => (
        <li key={row.agentId ?? row.label} className="flex items-center gap-3">
          <div className="w-32 shrink-0 truncate text-sm text-foreground" title={row.label}>
            {row.label}
          </div>
          <div className="flex-1 min-w-0 h-2 rounded-full bg-muted">
            <div
              className="h-2 rounded-full bg-brand"
              style={{
                width: `${row.pctOfSpend > 0 ? Math.max(row.pctOfSpend * 100, 0.5) : 0}%`,
              }}
            />
          </div>
          <div className="w-16 shrink-0 text-right text-sm tabular-nums text-foreground">
            {formatUsd(row.estUsd)}
          </div>
        </li>
      ))}
    </ul>
  );
}

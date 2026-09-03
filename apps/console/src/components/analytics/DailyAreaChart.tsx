import {
  DAILY_CHART_VIEW_W,
  dailyActivitySlot,
  dailyActivityTickIndices,
} from "../../lib/daily-activity-chart";
import { areaPath, linePath, type DailyBucket } from "../../lib/analytics-snapshot";
import { formatSandboxTime } from "../../lib/format";

function pointX(i: number, n: number, width: number): number {
  if (n === 1) return width / 2;
  return i * (width / (n - 1));
}

export function DailyAreaChart({ data }: { data: DailyBucket[] }) {
  const n = data.length;
  if (n === 0) return <p className="text-sm text-muted-foreground">No data.</p>;

  const viewW = DAILY_CHART_VIEW_W;
  const slot = dailyActivitySlot(n, viewW);
  const tickSet = new Set(dailyActivityTickIndices(n, slot));
  const rotate = slot < 28;
  const chartTop = 8;
  const chartH = 100;
  const baseline = chartTop + chartH;
  const labelH = rotate ? 36 : 22;
  const viewH = baseline + labelH;
  const seconds = data.map((d) => d.active_seconds);
  const fill = areaPath(seconds, viewW, chartH);
  const stroke = linePath(seconds, viewW, chartH);
  const max = Math.max(1, ...seconds);

  const fmtDate = (iso: string) => {
    const d = new Date(iso);
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
  };

  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${viewW} ${viewH}`}
        width="100%"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label="Daily sandbox activity"
      >
        <line
          x1={0}
          y1={baseline}
          x2={viewW}
          y2={baseline}
          stroke="var(--color-border)"
          strokeWidth={1}
        />
        {fill !== "" && (
          <g transform={`translate(0,${chartTop})`}>
            <path d={fill} fill="var(--color-brand)" opacity={0.28} />
            <path d={stroke} fill="none" stroke="var(--color-brand)" strokeWidth={1.5} />
          </g>
        )}
        {data.map((bucket, i) => {
          const cx = pointX(i, n, viewW);
          const cy = baseline - (bucket.active_seconds / max) * chartH;
          const labelY = baseline + 14;
          return (
            <g key={bucket.date}>
              <circle cx={cx} cy={cy} r={3} fill="var(--color-brand)">
                <title>
                  {`${fmtDate(bucket.date)}: ${formatSandboxTime(bucket.active_seconds)} · ${bucket.runs} run${bucket.runs === 1 ? "" : "s"}`}
                </title>
              </circle>
              {tickSet.has(i) && (
                <text
                  x={cx}
                  y={labelY}
                  textAnchor={rotate ? "end" : "middle"}
                  fontSize={10}
                  fill="var(--color-fg-subtle)"
                  transform={rotate ? `rotate(-40 ${cx} ${labelY})` : undefined}
                >
                  {fmtDate(bucket.date)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

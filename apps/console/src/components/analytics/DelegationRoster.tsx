import { useIsMobile } from "../../hooks/use-mobile";
import type { DelegationEdge } from "../../lib/analytics-snapshot";

const GRAPH_W = 280;
const GRAPH_H = 96;
const NODE_R = 5;

function uniqueNodes(edges: DelegationEdge[]): Array<{ id: string; name: string; side: "from" | "to" }> {
  const from = new Map<string, string>();
  const to = new Map<string, string>();
  for (const e of edges) {
    from.set(e.fromId, e.fromName);
    if (!from.has(e.toId)) to.set(e.toId, e.toName);
  }
  const left = [...from.entries()].map(([id, name]) => ({ id, name, side: "from" as const }));
  const right = [...to.entries()].map(([id, name]) => ({ id, name, side: "to" as const }));
  return [...left, ...right];
}

function CompactLinkGraph({ edges }: { edges: DelegationEdge[] }) {
  const nodes = uniqueNodes(edges);
  const left = nodes.filter((n) => n.side === "from");
  const right = nodes.filter((n) => n.side === "to");
  const pos = new Map<string, { x: number; y: number }>();
  const yAt = (i: number, count: number) =>
    count === 1 ? GRAPH_H / 2 : 20 + (i * (GRAPH_H - 40)) / Math.max(count - 1, 1);

  left.forEach((n, i) => pos.set(n.id, { x: 56, y: yAt(i, left.length) }));
  right.forEach((n, i) => pos.set(n.id, { x: GRAPH_W - 56, y: yAt(i, right.length) }));

  return (
    <svg
      viewBox={`0 0 ${GRAPH_W} ${GRAPH_H}`}
      width="100%"
      className="max-w-xs"
      role="img"
      aria-label="Declared delegation graph"
    >
      {edges.map((e) => {
        const a = pos.get(e.fromId);
        const b = pos.get(e.toId);
        if (!a || !b) return null;
        return (
          <line
            key={`${e.fromId}->${e.toId}`}
            x1={a.x + NODE_R}
            y1={a.y}
            x2={b.x - NODE_R}
            y2={b.y}
            stroke="var(--color-border)"
            strokeWidth={1.5}
          />
        );
      })}
      {nodes.map((n) => {
        const p = pos.get(n.id);
        if (!p) return null;
        return (
          <g key={`${n.side}:${n.id}`}>
            <circle cx={p.x} cy={p.y} r={NODE_R} fill="var(--color-brand)" />
            <text
              x={p.x}
              y={p.y - 10}
              textAnchor="middle"
              fontSize={10}
              fill="var(--color-fg)"
            >
              {n.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function DelegationRoster({ edges }: { edges: DelegationEdge[] }) {
  const isMobile = useIsMobile();

  if (edges.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No callable sub-agents configured. Call-count graphs need event-log aggregation
        (follow-up).
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <ul className="space-y-1.5">
        {edges.map((e) => (
          <li key={`${e.fromId}->${e.toId}`} className="text-sm text-foreground">
            {e.fromName} → {e.toName}
          </li>
        ))}
      </ul>
      {!isMobile && <CompactLinkGraph edges={edges} />}
    </div>
  );
}

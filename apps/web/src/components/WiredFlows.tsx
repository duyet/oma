// "One agent, wired to your stack" — tabbed use-case diagrams. Each tab is
// one real agent template drawn as a pipeline of nodes: input(s) → the agent
// (with its sandbox / skills / memory / MCP layers visible) → optionally a
// delegation fan-out to child agent thread(s) → outputs.
// Brand marks (GitHub, Slack, Linear, Sentry, Kubernetes) are simple-icons
// paths rendered in official brand colors; the rest are stroke glyphs tinted
// per function so every node reads at a glance.
import { useState } from "react";
import type { ReactNode } from "react";

/* ── Icons ──────────────────────────────────────────────────────────── */

// Single-color brand marks (simple-icons 24-grid, filled).
const BRAND_PATHS: Record<string, { d: string; color?: string }> = {
  github: {
    d: "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
  },
  linear: {
    d: "M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z",
    color: "#5E6AD2",
  },
  sentry: {
    d: "M13.91 2.505c-.873-1.448-2.972-1.448-3.844 0L6.904 7.92a15.478 15.478 0 0 1 8.53 12.811h-2.221A13.301 13.301 0 0 0 5.784 9.814l-2.926 5.06a7.65 7.65 0 0 1 4.435 5.848H2.194a.365.365 0 0 1-.298-.534l1.413-2.402a5.16 5.16 0 0 0-1.614-.913L.296 19.275a2.182 2.182 0 0 0 .812 2.999 2.24 2.24 0 0 0 1.086.288h6.983a9.322 9.322 0 0 0-3.845-8.318l1.11-1.922a11.47 11.47 0 0 1 4.95 10.24h5.915a17.242 17.242 0 0 0-7.885-15.28l2.244-3.845a.37.37 0 0 1 .504-.13c.255.14 9.75 16.708 9.928 16.9a.365.365 0 0 1-.327.543h-2.287c.029.612.029 1.223 0 1.831h2.297a2.206 2.206 0 0 0 1.922-3.31z",
    color: "#6C5FC7",
  },
  kubernetes: {
    d: "M10.204 14.35l.007.01-.999 2.413a5.171 5.171 0 0 1-2.075-2.597l2.578-.437.004.005a.44.44 0 0 1 .484.606zm-.833-2.129a.44.44 0 0 0 .173-.756l.002-.011L7.585 9.7a5.143 5.143 0 0 0-.73 3.255l2.514-.725.002-.009zm1.145-1.98a.44.44 0 0 0 .699-.337l.01-.005.15-2.62a5.144 5.144 0 0 0-3.01 1.442l2.147 1.523.004-.002zm.76 2.75l.723.349.722-.347.18-.78-.5-.623h-.804l-.5.623.179.779zm1.5-3.095a.44.44 0 0 0 .7.336l.008.003 2.134-1.513a5.188 5.188 0 0 0-2.992-1.442l.148 2.615.002.001zm10.876 5.97l-5.773 7.181a1.6 1.6 0 0 1-1.248.594l-9.261.003a1.6 1.6 0 0 1-1.247-.596l-5.776-7.18a1.583 1.583 0 0 1-.307-1.34L2.1 5.573c.108-.47.425-.864.863-1.073L11.305.513a1.606 1.606 0 0 1 1.385 0l8.345 3.985c.438.209.755.604.863 1.073l2.062 8.955c.108.47-.005.963-.308 1.34zm-3.289-2.057c-.042-.01-.103-.026-.145-.034-.174-.033-.315-.025-.479-.038-.35-.037-.638-.067-.895-.148-.105-.04-.18-.165-.216-.216l-.201-.059a6.45 6.45 0 0 0-.105-2.332 6.465 6.465 0 0 0-.936-2.163c.052-.047.15-.133.177-.159.008-.09.001-.183.094-.282.197-.185.444-.338.743-.522.142-.084.273-.137.415-.242.032-.024.076-.062.11-.089.24-.191.295-.52.123-.736-.172-.216-.506-.236-.745-.045-.034.027-.08.062-.111.088-.134.116-.217.23-.33.35-.246.25-.45.458-.673.609-.097.056-.239.037-.303.033l-.19.135a6.545 6.545 0 0 0-4.146-2.003l-.012-.223c-.065-.062-.143-.115-.163-.25-.022-.268.015-.557.057-.905.023-.163.061-.298.068-.475.001-.04-.001-.099-.001-.142 0-.306-.224-.555-.5-.555-.275 0-.499.249-.499.555l.001.014c0 .041-.002.092 0 .128.006.177.044.312.067.475.042.348.078.637.056.906a.545.545 0 0 1-.162.258l-.012.211a6.424 6.424 0 0 0-4.166 2.003 8.373 8.373 0 0 1-.18-.128c-.09.012-.18.04-.297-.029-.223-.15-.427-.358-.673-.608-.113-.12-.195-.234-.329-.349-.03-.026-.077-.062-.111-.088a.594.594 0 0 0-.348-.132.481.481 0 0 0-.398.176c-.172.216-.117.546.123.737l.007.005.104.083c.142.105.272.159.414.242.299.185.546.338.743.522.076.082.09.226.1.288l.16.143a6.462 6.462 0 0 0-1.02 4.506l-.208.06c-.055.072-.133.184-.215.217-.257.081-.546.11-.895.147-.164.014-.305.006-.48.039-.037.007-.09.02-.133.03l-.004.002-.007.002c-.295.071-.484.342-.423.608.061.267.349.429.645.365l.007-.001.01-.003.129-.029c.17-.046.294-.113.448-.172.33-.118.604-.217.87-.256.112-.009.23.069.288.101l.217-.037a6.5 6.5 0 0 0 2.88 3.596l-.09.218c.033.084.069.199.044.282-.097.252-.263.517-.452.813-.091.136-.185.242-.268.399-.02.037-.045.095-.064.134-.128.275-.034.591.213.71.248.12.556-.007.69-.282v-.002c.02-.039.046-.09.062-.127.07-.162.094-.301.144-.458.132-.332.205-.68.387-.897.05-.06.13-.082.215-.105l.113-.205a6.453 6.453 0 0 0 4.609.012l.106.192c.086.028.18.042.256.155.136.232.229.507.342.84.05.156.074.295.145.457.016.037.043.09.062.129.133.276.442.402.69.282.247-.118.341-.435.213-.71-.02-.039-.045-.096-.065-.134-.083-.156-.177-.261-.268-.398-.19-.296-.346-.541-.443-.793-.04-.13.007-.21.038-.294-.018-.022-.059-.144-.083-.202a6.499 6.499 0 0 0 2.88-3.622c.064.01.176.03.213.038.075-.05.144-.114.28-.104.266.039.54.138.87.256.154.06.277.128.448.173.036.01.088.019.13.028l.009.003.007.001c.297.064.584-.098.645-.365.06-.266-.128-.537-.423-.608zM16.4 9.701l-1.95 1.746v.005a.44.44 0 0 0 .173.757l.003.01 2.526.728a5.199 5.199 0 0 0-.108-1.674A5.208 5.208 0 0 0 16.4 9.7zm-4.013 5.325a.437.437 0 0 0-.404-.232.44.44 0 0 0-.372.233h-.002l-1.268 2.292a5.164 5.164 0 0 0 3.326.003l-1.27-2.296h-.01zm1.888-1.293a.44.44 0 0 0-.27.036.44.44 0 0 0-.214.572l-.003.004 1.01 2.438a5.15 5.15 0 0 0 2.081-2.615l-2.6-.44-.004.005z",
    color: "#326CE5",
  },
};

// Slack's mark in its four official brand colors — the simple-icons path
// split at each piece boundary (official SVG path order is preserved).
const SLACK_PIECES: { d: string; color: string }[] = [
  {
    d: "M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z",
    color: "#E01E5A",
  },
  {
    d: "M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z",
    color: "#36C5F0",
  },
  {
    d: "M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312z",
    color: "#2EB67D",
  },
  {
    d: "M15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z",
    color: "#ECB22E",
  },
];

/** Hand-drawn stroke glyphs (16×16, stroke=currentColor). */
const STROKE_GLYPHS: Record<string, ReactNode> = {
  file: (
    <>
      <path d="M4 1.5h5.5L13 5v9.5H4z" />
      <path d="M9.5 1.5V5H13" />
    </>
  ),
  chart: (
    <>
      <path d="M2 14h12" />
      <path d="M4 14V9M8 14V4M12 14v-7" />
    </>
  ),
  doc: (
    <>
      <path d="M3.5 1.5h9v13h-9z" />
      <path d="M5.5 5h5M5.5 8h5M5.5 11h3" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="6.2" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  laptop: (
    <>
      <path d="M3 3.5h10V11H3z" />
      <path d="M1.5 13.5h13" />
    </>
  ),
  browser: (
    <>
      <path d="M1.5 3.5h13v9.5h-13z" />
      <path d="M1.5 6h13" />
      <path d="M4 4.75h2.2" />
    </>
  ),
  cluster: (
    <>
      <path d="M8 1.5 13.8 5v6L8 14.5 2.2 11V5z" />
      <circle cx="8" cy="8" r="2" />
    </>
  ),
  pr: (
    <>
      <circle cx="4" cy="3.5" r="1.8" />
      <circle cx="4" cy="12.5" r="1.8" />
      <circle cx="12" cy="12.5" r="1.8" />
      <path d="M4 5.3v5.4M12 10.7V7a3 3 0 0 0-3-3H7.5" />
    </>
  ),
  check: <path d="M3 8.5 6.5 12 13 4.5" />,
  terminal: (
    <>
      <path d="M1.5 2.5h13v11h-13z" />
      <path d="M4 6l2.5 2L4 10M8 10.5h4" />
    </>
  ),
};

// Functional tints for the stroke glyphs so layer chips and generic nodes
// carry color too (mid-tones that read on both light and dark surfaces).
const GLYPH_COLORS: Record<string, string> = {
  terminal: "#8b5cf6",
  doc: "#3b82f6",
  file: "#f59e0b",
  chart: "#f97316",
  clock: "#0ea5e9",
  cluster: "#326CE5",
  pr: "#22c55e",
  check: "#22c55e",
  laptop: "#64748b",
  browser: "#14b8a6",
};

function Icon({ name, size = 14 }: { name: string; size?: number }) {
  if (name === "slack") {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flex: "none" }}>
        {SLACK_PIECES.map((p) => (
          <path key={p.color} d={p.d} fill={p.color} />
        ))}
      </svg>
    );
  }
  if (BRAND_PATHS[name]) {
    const { d, color } = BRAND_PATHS[name];
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill={color ?? "currentColor"} aria-hidden="true" style={{ flex: "none" }}>
        <path d={d} />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke={GLYPH_COLORS[name] ?? "currentColor"}
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flex: "none" }}
    >
      {STROKE_GLYPHS[name]}
    </svg>
  );
}

/* ── Flow data ──────────────────────────────────────────────────────── */

interface DiagramNode {
  icon: string;
  label: string;
  /** smaller second line, e.g. a filename or a status */
  sub?: string;
}

/** A child agent thread spawned via call_agent_* / call_agents_parallel. Rendered
 * with the same diamond marker as the parent "agent" box (no icon) so it reads
 * as "also an agent", not a data node. */
interface SubAgentCall {
  label: string;
  /** smaller second line, e.g. the task slice this call was given */
  sub?: string;
}

/** A delegation stage: the generated tool name plus the child thread(s) it
 * spawns. Renders as its own fan-out column between the agent box and
 * outputs — a single call_agent_* delegate is just a column of one. */
interface Delegation {
  tool: string;
  /** small annotation under the tool name, e.g. the concurrency cap */
  note?: string;
  agents: SubAgentCall[];
}

interface Flow {
  name: string;
  every?: string;
  inputs: DiagramNode[];
  /** layer chips shown inside the agent box */
  layers: { icon: string; label: string }[];
  /** child agent thread(s) this flow delegates to */
  delegates?: Delegation;
  outputs: DiagramNode[];
  /** one-line caption under the diagram */
  note?: string;
  /** extra: terminal line rendered inside the laptop input (local relay) */
  laptopCmd?: string;
}

const FLOWS: Flow[] = [
  {
    name: "Support",
    inputs: [{ icon: "slack", label: "Slack", sub: "customer asks" }],
    layers: [
      { icon: "terminal", label: "sandbox" },
      { icon: "doc", label: "skills: docs-lookup" },
      { icon: "file", label: "memory" },
    ],
    outputs: [{ icon: "slack", label: "reply in-thread" }],
    note: "Customer threads open sessions; answers are drafted from your docs.",
  },
  {
    name: "Incident response",
    inputs: [{ icon: "sentry", label: "Sentry", sub: "alert webhook" }],
    layers: [
      { icon: "terminal", label: "sandbox: triage" },
      { icon: "linear", label: "mcp: linear" },
    ],
    outputs: [
      { icon: "linear", label: "Linear ticket" },
      { icon: "slack", label: "war room" },
    ],
    note: "Alert fires the deployment webhook; the session triages and escalates.",
  },
  {
    name: "Sprint retro",
    every: "weekly",
    inputs: [{ icon: "clock", label: "schedule", sub: "Fri 17:00" }],
    layers: [
      { icon: "linear", label: "mcp: linear" },
      { icon: "file", label: "memory: past retros" },
      { icon: "doc", label: "skills: writing" },
    ],
    outputs: [{ icon: "doc", label: "retro doc" }],
    note: "A cron schedule opens a fresh session every Friday.",
  },
  {
    name: "Bug triage",
    inputs: [{ icon: "github", label: "GitHub issue", sub: "@agent mentioned" }],
    layers: [
      { icon: "terminal", label: "sandbox: repro" },
      { icon: "doc", label: "skills: debugging" },
      { icon: "file", label: "memory" },
    ],
    outputs: [
      { icon: "pr", label: "branch + PR", sub: "fix committed" },
      { icon: "github", label: "issue comment" },
    ],
    note: "The agent reproduces in its sandbox, commits the fix, and opens a PR.",
  },
  {
    name: "Data analysis",
    inputs: [{ icon: "file", label: "dataset upload", sub: "sales.csv" }],
    layers: [
      { icon: "terminal", label: "sandbox: python" },
      { icon: "chart", label: "skills: charts" },
      { icon: "doc", label: "skills: report" },
    ],
    outputs: [
      { icon: "chart", label: "charts" },
      { icon: "doc", label: "HTML report", sub: "/workspace/out" },
    ],
    note: "pandas + matplotlib run in the sandbox; outputs land in /workspace.",
  },
  {
    name: "Local relay",
    inputs: [
      {
        icon: "laptop",
        label: "your laptop",
        sub: "daemon connected",
      },
      { icon: "github", label: "GitHub ticket", sub: "assigned to agent" },
    ],
    laptopCmd: "npx @getoma/cli bridge setup",
    layers: [
      { icon: "terminal", label: "tools exec on your machine" },
      { icon: "doc", label: "outbound-only WebSocket" },
    ],
    outputs: [
      { icon: "pr", label: "PR auto-created" },
      { icon: "check", label: "ticket marked done" },
    ],
    note: "Assign a ticket in the cloud — the agent runs on your machine and opens the PR.",
  },
  {
    name: "K8s sandbox",
    inputs: [{ icon: "kubernetes", label: "your cluster", sub: "helm install" }],
    layers: [
      { icon: "terminal", label: "pod-per-session sandbox" },
      { icon: "doc", label: "image + network policy from env" },
    ],
    outputs: [{ icon: "check", label: "isolated runs" }],
    note: "Each session provisions a pod in your cluster via the k8s bridge.",
  },
  {
    name: "Browser sandbox",
    inputs: [{ icon: "browser", label: "browser tab", sub: "pairs as a runtime" }],
    layers: [
      { icon: "terminal", label: "sandbox: browser tab (v86)" },
      { icon: "doc", label: "ops relayed over WebSocket" },
    ],
    outputs: [{ icon: "check", label: "isolated runs" }],
    note: "Open the sandbox tab — a v86 Linux VM boots in-browser; files stay local, no server cost.",
  },
  {
    name: "Parallel research",
    inputs: [{ icon: "doc", label: "research task", sub: "3 sub-topics" }],
    layers: [{ icon: "doc", label: "skills: synthesis" }],
    delegates: {
      tool: "call_agents_parallel",
      note: "≤5 concurrent · ceiling 10",
      agents: [
        { label: "researcher", sub: "topic A" },
        { label: "researcher", sub: "topic B" },
        { label: "writer", sub: "outline topic C" },
      ],
    },
    outputs: [{ icon: "doc", label: "synthesized report" }],
    note: "Each child returns its own success + response — one failure doesn't lose the batch.",
  },
  {
    name: "Lead + specialist",
    inputs: [{ icon: "github", label: "GitHub issue", sub: "needs research" }],
    layers: [{ icon: "terminal", label: "sandbox" }],
    delegates: {
      tool: "call_agent_researcher",
      note: "one at a time, blocks until idle",
      agents: [{ label: "researcher", sub: "own thread" }],
    },
    outputs: [{ icon: "github", label: "issue comment" }],
    note: "Runs as a child thread in the same session — shares /workspace, own message history.",
  },
];

/* ── Diagram pieces ─────────────────────────────────────────────────── */

const nodeStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.5rem",
  border: "1px solid var(--color-border)",
  background: "var(--color-card)",
  boxShadow: "0 1px 2px rgba(24, 24, 27, 0.05)",
  borderRadius: "0.5rem",
  padding: "0.5rem 0.7rem",
  fontFamily: "var(--font-mono)",
  fontSize: "0.68rem",
  lineHeight: 1.25,
  color: "var(--color-fg)",
};

function Node({ node }: { node: DiagramNode }) {
  return (
    <div style={nodeStyle}>
      <Icon name={node.icon} size={16} />
      <span style={{ minWidth: 0 }}>
        <span style={{ display: "block", whiteSpace: "nowrap" }}>{node.label}</span>
        {node.sub && (
          <span style={{ display: "block", color: "var(--color-fg-subtle)", fontSize: "0.6rem", whiteSpace: "nowrap" }}>
            {node.sub}
          </span>
        )}
      </span>
    </div>
  );
}

// A child agent chip — a smaller echo of the "agent" box's own diamond
// marker (not a data icon) so a delegation column reads as "these are also
// agents", distinct from the plain data nodes in the input/output columns.
const subAgentStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
  border: "1px solid color-mix(in srgb, var(--color-brand) 30%, var(--color-border))",
  background: "color-mix(in srgb, var(--color-brand) 4%, var(--color-card))",
  borderRadius: "0.5rem",
  padding: "0.4rem 0.6rem",
  fontFamily: "var(--font-mono)",
  fontSize: "0.64rem",
  lineHeight: 1.25,
  color: "var(--color-fg)",
};

function DelegateGroup({ delegation }: { delegation: Delegation }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: "0.4rem" }}>
      <div className="font-mono" style={{ fontSize: "0.6rem", textAlign: "center", lineHeight: 1.3 }}>
        <span style={{ color: "var(--color-brand)" }}>{delegation.tool}</span>
        {delegation.note && <span style={{ display: "block", color: "var(--color-fg-subtle)" }}>{delegation.note}</span>}
      </div>
      <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: "0.4rem" }}>
        {delegation.agents.map((a, i) => (
          <div key={`${a.label}-${i}`} style={subAgentStyle}>
            <span
              aria-hidden="true"
              style={{
                width: "0.32rem",
                height: "0.32rem",
                borderRadius: "1px",
                background: "var(--color-brand)",
                transform: "rotate(45deg)",
                flex: "none",
              }}
            ></span>
            <span style={{ minWidth: 0 }}>
              <span style={{ display: "block", whiteSpace: "nowrap" }}>{a.label}</span>
              {a.sub && (
                <span style={{ display: "block", color: "var(--color-fg-subtle)", fontSize: "0.58rem", whiteSpace: "nowrap" }}>
                  {a.sub}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function Arrow() {
  // Blueprint-style connector: a static rail + arrowhead, an animated dashed
  // edge that streams toward the arrowhead, and a packet dot that travels the
  // length — the AnyRouter / Cloudflare "gateway" flow motion. Reduced-motion
  // users get the static rail only (see the keyframes gate in the style block).
  return (
    <svg
      className="wf-arrow"
      width="30"
      height="10"
      viewBox="0 0 30 10"
      aria-hidden="true"
      style={{ flex: "none", alignSelf: "center", overflow: "visible" }}
    >
      <path
        d="M0 5h25M22 1.5 26.5 5 22 8.5"
        fill="none"
        stroke="var(--color-border-strong)"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <line
        className="wf-edge"
        x1="0"
        y1="5"
        x2="25"
        y2="5"
        stroke="var(--color-brand)"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
      <circle className="wf-packet" cx="0" cy="5" r="2" fill="var(--color-brand)" />
    </svg>
  );
}

/* ── Component ──────────────────────────────────────────────────────── */

export default function WiredFlows() {
  const [active, setActive] = useState(0);
  const flow = FLOWS[active];

  return (
    <div style={{ width: "100%", padding: "0.25rem 0.25rem 0" }}>
      <style>{`
        .wf-flow {
          display: flex;
          align-items: center;
          justify-content: center;
          flex-wrap: wrap;
          gap: 0.6rem 0.5rem;
          padding: 1.25rem 1rem;
          border: 1px solid var(--color-border);
          border-radius: 0.75rem;
        }
        @media (max-width: 639px) {
          .wf-flow { flex-direction: column; }
          .wf-arrow { transform: rotate(90deg); margin: 0.1rem 0; }
        }
        .wf-edge { stroke-dasharray: 5 4; opacity: 0.85; }
        .wf-packet { opacity: 0; }
        @media (prefers-reduced-motion: no-preference) {
          .wf-edge { animation: wf-dash 1.1s linear infinite; }
          .wf-packet { animation: wf-packet 1.7s linear infinite; }
        }
        @keyframes wf-dash { to { stroke-dashoffset: -9; } }
        @keyframes wf-packet {
          0% { transform: translateX(0); opacity: 0; }
          15% { opacity: 1; }
          85% { opacity: 1; }
          100% { transform: translateX(25px); opacity: 0; }
        }
      `}</style>
      <p
        className="font-mono"
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: "0.5rem 0.75rem",
          margin: "0 0 0.75rem",
          fontSize: "0.72rem",
          fontWeight: 600,
          color: "var(--color-fg)",
        }}
      >
        <span>One agent, wired to your stack</span>
        <span style={{ fontWeight: 400, color: "var(--color-fg-subtle)" }} aria-hidden="true">
          input → agent → result
        </span>
      </p>

      {/* Tab rail */}
      <div
        role="tablist"
        aria-label="Use cases"
        style={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: "0.35rem", margin: "0 0 1.1rem" }}
      >
        {FLOWS.map((f, i) => (
          <button
            key={f.name}
            role="tab"
            aria-selected={i === active}
            onClick={() => setActive(i)}
            className="font-mono"
            style={{
              fontSize: "11px",
              padding: "0.3rem 0.65rem",
              borderRadius: "0.5rem",
              cursor: "pointer",
              border: `1px solid ${i === active ? "var(--color-brand)" : "var(--color-border)"}`,
              background: i === active ? "color-mix(in srgb, var(--color-brand) 10%, transparent)" : "transparent",
              color: i === active ? "var(--color-brand)" : "var(--color-fg-muted)",
              transition: "color .15s ease, border-color .15s ease, background-color .15s ease",
            }}
          >
            {f.name}
          </button>
        ))}
      </div>

      {/* Diagram: inputs → agent (layers) → outputs, centered */}
      <div className="wf-flow">
        {/* Inputs */}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: "0.5rem" }}>
          {flow.inputs.map((n, i) => (
            <div key={n.label}>
              <Node node={n} />
              {/* Local relay: the paired-CLI terminal line lives inside the laptop input */}
              {i === 0 && flow.laptopCmd && (
                <div
                  className="font-mono"
                  style={{
                    marginTop: "0.35rem",
                    padding: "0.35rem 0.55rem",
                    borderRadius: "0.4rem",
                    border: "1px solid var(--color-border)",
                    background: "var(--color-bg)",
                    fontSize: "0.58rem",
                    color: "var(--color-fg-muted)",
                    whiteSpace: "nowrap",
                  }}
                >
                  <span style={{ color: "var(--color-fg-subtle)" }}>$ </span>
                  {flow.laptopCmd}
                  <span style={{ display: "block", color: "var(--color-success, #22c55e)" }}>✓ connected</span>
                </div>
              )}
            </div>
          ))}
        </div>

        <Arrow />

        {/* Agent box with its layers */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "0.45rem",
            padding: "0.7rem 0.8rem",
            borderRadius: "0.75rem",
            border: "1px solid color-mix(in srgb, var(--color-brand) 40%, transparent)",
            background: "color-mix(in srgb, var(--color-brand) 6%, var(--color-bg))",
            minWidth: "11rem",
          }}
        >
          <div
            className="font-mono"
            style={{ display: "flex", alignItems: "center", gap: "0.4rem", fontSize: "0.7rem", fontWeight: 600, color: "var(--color-brand)" }}
          >
            <span
              aria-hidden="true"
              style={{ width: "0.42rem", height: "0.42rem", borderRadius: "1px", background: "var(--color-brand)", transform: "rotate(45deg)" }}
            ></span>
            agent
            {flow.every && (
              <span style={{ fontWeight: 500, fontSize: "0.6rem", color: "var(--color-fg-subtle)", marginLeft: "auto" }}>↻ {flow.every}</span>
            )}
          </div>
          {flow.layers.map((l) => (
            <div
              key={l.label}
              className="font-mono"
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.45rem",
                padding: "0.35rem 0.5rem",
                borderRadius: "0.4rem",
                border: "1px solid var(--color-border)",
                background: "var(--color-bg)",
                fontSize: "0.62rem",
                color: "var(--color-fg-muted)",
                whiteSpace: "nowrap",
              }}
            >
              <Icon name={l.icon} size={12} />
              {l.label}
            </div>
          ))}
        </div>

        {/* Delegation: fan-out to child agent thread(s) via call_agent_* /
            call_agents_parallel — its own stage, not folded into the layers
            list, so a delegation flow visibly branches instead of reading
            as just another linear pipeline. */}
        {flow.delegates && (
          <>
            <Arrow />
            <DelegateGroup delegation={flow.delegates} />
          </>
        )}

        <Arrow />

        {/* Outputs */}
        <div style={{ display: "flex", flexDirection: "column", justifyContent: "center", gap: "0.5rem" }}>
          {flow.outputs.map((n) => (
            <Node key={n.label} node={n} />
          ))}
        </div>
      </div>

      {flow.note && (
        <p style={{ margin: "0.7rem 0 0", fontSize: "0.74rem", lineHeight: 1.5, textAlign: "center", color: "var(--color-fg-muted)" }}>
          {flow.note}
        </p>
      )}
    </div>
  );
}

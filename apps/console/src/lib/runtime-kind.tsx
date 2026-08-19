/**
 * The three runtime kinds an agent can run under, and one label + icon
 * scheme for all of them.
 *
 * Every surface that mentions "where does this agent run" renders from this
 * map — the create/edit picker, the agent detail page, the agents table, the
 * session inspector — so the wording and glyph can never drift between them.
 *
 *   Cloud   — the loop runs on OMA (harness `claude-agent-sdk`).
 *   Local   — the loop runs on a paired machine (harness `acp-proxy`).
 *   Browser — the loop stays cloud; the *sandbox* runs in a browser tab
 *             (`browser-vm` provider). See docs/browser-vm-sandbox.md.
 */
import { Cloud, Globe, Terminal } from "lucide-react";
import type { LucideIcon } from "lucide-react";

export type RuntimeKind = "cloud" | "local" | "browser";

/** Agent metadata key recording an explicitly chosen runtime kind. Only
 *  Browser needs it — Cloud and Local are derivable from the harness /
 *  runtime binding, but "which sandbox provider" is a property of the
 *  environment, which a bare agent row doesn't carry. */
export const RUNTIME_KIND_METADATA_KEY = "runtime_kind";

export interface RuntimeKindInfo {
  id: RuntimeKind;
  label: string;
  /** One line for pickers and tooltips. */
  description: string;
  Icon: LucideIcon;
}

export const RUNTIME_KINDS: Record<RuntimeKind, RuntimeKindInfo> = {
  cloud: {
    id: "cloud",
    label: "Cloud",
    description: "Runs on OMA (Standard loop or Claude Agent SDK harness)",
    Icon: Cloud,
  },
  local: {
    id: "local",
    label: "Local",
    description: "ACP Runtime on a machine you've paired",
    Icon: Terminal,
  },
  browser: {
    id: "browser",
    label: "Browser",
    description: "Sandbox runs in a WASM VM in a browser tab",
    Icon: Globe,
  },
};

/** Minimal shape every caller already has — the agents list row, the detail
 *  page's record, and the session inspector's agent snapshot all satisfy it. */
export interface RuntimeKindSource {
  runtime_binding?: { runtime_id?: string; acp_agent_id?: string } | null;
  metadata?: Record<string, unknown> | null;
  _oma?: {
    runtime_binding?: { runtime_id?: string; acp_agent_id?: string } | null;
  } | null;
}

function hasLocalRuntimeBinding(
  binding: { runtime_id?: string; acp_agent_id?: string } | null | undefined,
): boolean {
  return !!(binding?.runtime_id || binding?.acp_agent_id);
}

export function agentRuntimeKind(agent: RuntimeKindSource | null | undefined): RuntimeKind {
  if (!agent) return "cloud";
  // A runtime binding always wins: it IS the local loop, whatever else the
  // config says.
  if (
    hasLocalRuntimeBinding(agent.runtime_binding) ||
    hasLocalRuntimeBinding(agent._oma?.runtime_binding)
  ) {
    return "local";
  }
  if (agent.metadata?.[RUNTIME_KIND_METADATA_KEY] === "browser") return "browser";
  return "cloud";
}

export function runtimeKindInfo(kind: RuntimeKind): RuntimeKindInfo {
  return RUNTIME_KINDS[kind];
}

/**
 * Compact badge used in tables and headers. `showLabel={false}` renders the
 * icon alone (still labelled for assistive tech via the title).
 */
export function RuntimeKindBadge({
  kind,
  detail,
  showLabel = true,
  className = "",
}: {
  kind: RuntimeKind;
  /** Extra context for the tooltip, e.g. the bound machine id. */
  detail?: string;
  showLabel?: boolean;
  className?: string;
}) {
  const info = RUNTIME_KINDS[kind];
  const title = detail ? `${info.label} — ${detail}` : `${info.label} — ${info.description}`;
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs text-fg-muted ${className}`}
      title={title}
    >
      <info.Icon className="size-3.5 shrink-0 text-fg-subtle" aria-hidden="true" />
      {showLabel ? info.label : <span className="sr-only">{info.label}</span>}
    </span>
  );
}

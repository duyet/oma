import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  NavLink,
  Outlet,
  useNavigate,
  useOutletContext,
  useParams,
} from "react-router";

import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/hooks/useConfirm";
import { NewSessionDialog } from "../components/NewSessionDialog";
import { AgentEditDialog } from "./agents/AgentEditDialog";
import { AgentHealthStrip } from "./agents/AgentHealthStrip";
import type { AppOutletContext } from "../components/AppShell";
import type { AgentRecord as Agent } from "../types/agent";

/**
 * Context handed to the agent-hub tab routes via `<Outlet context>`.
 * Extends AppShell's `pageHeaderSlot` contract (so DataTable/PageHeader
 * children portal their toolbar below the tab strip) with the agent
 * record + its version history — the data every tab shares — plus
 * refetchers the header's Edit dialog fires after a save.
 */
export interface AgentHubContext extends AppOutletContext {
  agent: Agent;
  /** All versions, ascending. Empty while loading / on error. */
  versions: Agent[];
  refetchAgent: () => void;
  refetchVersions: () => void;
}

export function useAgentHub(): AgentHubContext {
  return useOutletContext<AgentHubContext>();
}

const TABS: { label: string; to: string; end?: boolean }[] = [
  { label: "Agent", to: ".", end: true },
  { label: "Sessions", to: "sessions" },
  { label: "Deployments", to: "deployments" },
  { label: "Schedules", to: "schedules" },
  { label: "Monitor", to: "monitor" },
  { label: "Observability", to: "observability" },
  { label: "Publishing", to: "publishing" },
];

/**
 * AgentDetail — the tabbed agent hub layout (matches the official Claude
 * Console agent page). Loads the agent + its versions, renders a header
 * (name, status, id, description, actions) and a tab strip of nested-route
 * `NavLink`s, and hands each tab the shared context via `<Outlet>`.
 *
 * The header + tabs portal into AppShell's frozen `pageHeaderSlot` (same
 * mechanism as `HubLayout`), and a sub-slot below the tab strip is handed
 * to children so their PageHeader (search / filters / frozen table header)
 * lands under the tabs. When no frozen slot exists (unit tests without
 * AppShell) the header renders inline so the hub still works standalone.
 */
export function AgentDetail() {
  const { id } = useParams();
  const { api } = useApi();
  const nav = useNavigate();

  const parentCtx = useOutletContext<AppOutletContext | undefined>();
  const slot = parentCtx?.pageHeaderSlot ?? null;
  const [subSlot, setSubSlot] = useState<HTMLDivElement | null>(null);

  const enabled = !!id;
  const {
    data: agent,
    error: agentError,
    refetch: refetchAgent,
  } = useApiQuery<Agent>(id ? `/v1/agents/${id}` : null, undefined, { enabled });
  const { data: versionsRes, refetch: refetchVersions } = useApiQuery<{ data: Agent[] }>(
    id ? `/v1/agents/${id}/versions` : null,
    undefined,
    { enabled },
  );
  const versions = versionsRes?.data ?? [];

  const [editing, setEditing] = useState(false);
  const [newSessionOpen, setNewSessionOpen] = useState(false);

  const isLocalRuntime = !!agent?.runtime_binding;

  const childContext = useMemo<AgentHubContext | null>(
    () =>
      agent
        ? {
            pageHeaderSlot: subSlot,
            agent,
            versions,
            refetchAgent,
            refetchVersions,
          }
        : null,
    [subSlot, agent, versions, refetchAgent, refetchVersions],
  );

  const confirm = useConfirm();

  const archive = async () => {
    if (
      !(await confirm({
        title: "Archive this agent?",
        confirmLabel: "Archive",
        destructive: true,
      }))
    )
      return;
    await api(`/v1/agents/${id}/archive`, { method: "POST", body: "{}" });
    nav("/agents");
  };

  const del = async () => {
    if (
      !(await confirm({
        title: "Delete this agent?",
        description: "This cannot be undone.",
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return;
    await api(`/v1/agents/${id}`, { method: "DELETE" });
    nav("/agents");
  };

  const error =
    agentError instanceof Error ? agentError.message : agentError ? String(agentError) : "";
  if (error) return <div className="p-10 text-danger">Error: {error}</div>;
  if (!agent || !childContext) return <div className="p-10 text-fg-subtle">Loading...</div>;

  const archived = !!agent.archived_at;

  const header = (
    <div className="bg-bg">
      <div className="flex items-start gap-4 pt-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1 className="text-xl font-semibold tracking-tight truncate">{agent.name}</h1>
            <span
              className={cn(
                "inline-flex items-center text-[11px] px-2 py-0.5 rounded-full shrink-0",
                archived ? "bg-bg-surface text-fg-muted" : "bg-success-subtle text-success",
              )}
            >
              {archived ? "Archived" : "Active"}
            </span>
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-sm text-fg-muted">
            <span className="font-mono text-xs">{agent.id}</span>
            {agent.description && (
              <>
                <span className="text-fg-subtle">·</span>
                <span className="truncate">{agent.description}</span>
              </>
            )}
          </div>
          <AgentHealthStrip agentId={agent.id} />
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button variant="default" size="sm" onClick={() => setNewSessionOpen(true)}>
            + New Session
          </Button>
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
          <Button variant="outline" size="sm" onClick={archive}>
            Archive
          </Button>
          <Button variant="destructive" size="sm" onClick={del}>
            Delete
          </Button>
        </div>
      </div>

      <nav
        aria-label="Agent sections"
        className="mt-3 inline-flex h-8 w-fit items-center gap-1 overflow-x-auto rounded-lg bg-muted p-[3px] text-muted-foreground"
      >
        {TABS.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                "relative inline-flex h-[calc(100%-1px)] items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2.5 text-sm font-medium transition-all",
                isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "text-foreground/60 hover:text-foreground",
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      {/* Sub-slot for child PageHeaders — sits below the tab strip. */}
      <div ref={setSubSlot} />
    </div>
  );

  return (
    <>
      {slot ? createPortal(header, slot) : header}
      <Outlet context={childContext} />

      <AgentEditDialog
        open={editing}
        onClose={() => setEditing(false)}
        agent={agent}
        onSaved={() => {
          refetchAgent();
          refetchVersions();
        }}
      />

      <NewSessionDialog
        open={newSessionOpen}
        onClose={() => setNewSessionOpen(false)}
        agentId={id!}
        isLocalRuntime={isLocalRuntime}
        agentMetadata={agent?.metadata}
        onCreated={(sessionId) => {
          setNewSessionOpen(false);
          nav(`/sessions/${sessionId}`);
        }}
      />
    </>
  );
}

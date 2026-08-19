import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import {
  ArchiveIcon,
  BookOpenIcon,
  CoinsIcon,
  CopyIcon,
  MessageSquareIcon,
  PencilIcon,
  PlugZapIcon,
  RocketIcon,
  ListIcon,
  TrashIcon,
  WrenchIcon,
} from "lucide-react";

import { useApi } from "../lib/api";
import { useInfiniteApiQuery } from "../lib/useApiQuery";
import { DataTable, ExpandedDetail, type ColumnDef } from "../components/DataTable";
import { FilterBar } from "../components/FilterBar";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { Badge } from "../components/Badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/hooks/useConfirm";
import { formatCompact, formatRelative } from "../lib/format";
import { RuntimeKindBadge, agentRuntimeKind } from "../lib/runtime-kind";
import { ModelName } from "../lib/model-provider";
import { useAgentQuickStats } from "../lib/useAgentQuickStats";
import type { ModelCard } from "@duyet/oma-api-types";
import type { AgentRecord as Agent } from "../types/agent";
import { AgentFormDialog } from "./agents/AgentFormDialog";
import { AgentEditDialog } from "./agents/AgentEditDialog";
import { PublishAgentDialog } from "./agents/PublishAgentDialog";

type Runtime = {
  id: string;
  hostname: string;
  status: string;
  agents: Array<{ id: string }>;
  /** Skills daemon detected locally on the user's machine, keyed by acp
   *  agent id. Source for the blocklist multi-select that appears when
   *  the user picks an acp agent. */
  local_skills?: Record<
    string,
    Array<{
      id: string;
      name?: string;
      description?: string;
      source?: string;
      source_label?: string;
    }>
  >;
};

type StatusValue = "any" | "active" | "archived";

const STATUS_OPTIONS: { value: StatusValue; label: string }[] = [
  { value: "any", label: "All" },
  { value: "active", label: "Active" },
  { value: "archived", label: "Archived" },
];

export function AgentsList() {
  const { api } = useApi();
  const nav = useNavigate();
  const [allAgents, setAllAgents] = useState<Agent[]>([]);
  const [customSkills, setCustomSkills] = useState<
    Array<{ id: string; name: string; description: string }>
  >([]);
  const [modelCards, setModelCards] = useState<ModelCard[]>([]);
  const [runtimes, setRuntimes] = useState<Runtime[]>([]);
  const [, setAuxLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [editAgent, setEditAgent] = useState<Agent | null>(null);
  const [publishAgent, setPublishAgent] = useState<Agent | null>(null);
  const confirm = useConfirm();

  // Server-driven filter state. Each piece flows into agentsParams below
  // → useInfiniteApiQuery resets to page 1 on params change → the list
  // reflects exactly what the server returned (no client-side faking).
  const [status, setStatus] = useState<StatusValue>("active");
  const [created, setCreated] = useState<{ after?: number; before?: number }>({});
  const [search, setSearch] = useState("");

  // Main agents table — paginated. Any change to these params resets to
  // page 0 automatically (paramsKey is part of the query key).
  const agentsParams = useMemo(
    () => ({
      status,
      ...(created.after !== undefined
        ? { created_after: new Date(created.after).toISOString() }
        : {}),
      ...(created.before !== undefined
        ? { created_before: new Date(created.before).toISOString() }
        : {}),
      ...(search ? { q: search } : {}),
    }),
    [status, created.after, created.before, search],
  );
  const {
    items: agents,
    isLoading: loading,
    error,
    hasMore,
    isLoadingMore,
    loadMore,
    refresh: refreshAgents,
  } = useInfiniteApiQuery<Agent>("/v1/agents", { limit: 20, params: agentsParams });

  // Aux fetches that aren't paginated UI surfaces — refreshed on mount and
  // after agent CRUD. Pull all agents (for the callable-agents dropdown)
  // separately so it isn't constrained by the main list's page size.
  //
  // Failures of the secondary fetches (skills / model cards / runtimes) are
  // tolerated and logged: missing data degrades a dropdown but shouldn't
  // block agent CRUD. Failures of the primary `/v1/agents` call surface
  // via the toast that `useApi` raises automatically; setting `auxLoading`
  // back to false in `finally` keeps the spinner from getting stuck.
  const loadAux = async () => {
    setAuxLoading(true);
    try {
      const all = await api<{ data: Agent[] }>("/v1/agents?limit=200&status=any");
      setAllAgents(all.data);
      await Promise.allSettled([
        (async () => {
          const sk = await api<{
            data: Array<{ id: string; name: string; description: string }>;
          }>("/v1/skills");
          setCustomSkills(sk.data);
        })().catch((e) => console.warn("[AgentsList] /v1/skills aux fetch failed", e)),
        (async () => {
          const mc = await api<{ data: ModelCard[] }>("/v1/model_cards?limit=200");
          setModelCards(mc.data);
        })().catch((e) => console.warn("[AgentsList] /v1/model_cards aux fetch failed", e)),
        (async () => {
          const rt = await api<{ runtimes: Runtime[] }>("/v1/runtimes");
          setRuntimes(rt.runtimes);
        })().catch((e) => console.warn("[AgentsList] /v1/runtimes aux fetch failed", e)),
      ]);
    } finally {
      setAuxLoading(false);
    }
  };

  useEffect(() => {
    loadAux();
  }, []);

  // Refresh aux data (agents, skills, model cards, runtimes) when the tab
  // regains focus — e.g. the user opened Model Cards / Runtimes in a new
  // tab to add one while the New Agent dialog was open. Without this the
  // dialog's pickers stay stale until it's closed and reopened.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") loadAux();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const modelStr = (m: Agent["model"]) => (typeof m === "string" ? m : m?.id || "");

  // One aggregate call for the whole page — see useAgentQuickStats.
  const quickStats = useAgentQuickStats();

  const duplicateAgent = async (a: Agent) => {
    try {
      const created = await api<Agent>("/v1/agents", {
        method: "POST",
        body: JSON.stringify({
          name: `${a.name} (copy)`,
          model: a.model,
          system: a.system ?? "",
          description: a.description,
          tools: a.tools,
          mcp_servers: a.mcp_servers,
          skills: a.skills,
          multiagent: a.multiagent,
        }),
      });
      toast.success(`Duplicated as "${created.name}"`);
      refreshAgents();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to duplicate agent");
    }
  };

  // TanStack column defs. Order, filtering, and search all flow through
  // server params now — no per-column sort/filter UI. Required columns
  // (id, name) opt out of the Columns hide menu so the user can't end
  // up with a table that has nothing identifying.
  const columns = useMemo<ColumnDef<Agent>[]>(
    () => [
      {
        id: "id",
        accessorKey: "id",
        header: "ID",
        cell: ({ row }) => (
          <span title={row.original.id} className="font-mono text-xs text-fg-muted">
            {row.original.id}
          </span>
        ),
        enableHiding: false,
      },
      {
        id: "name",
        accessorKey: "name",
        header: "Name",
        cell: ({ row }) => <span className="font-medium text-fg">{row.original.name}</span>,
        enableHiding: false,
      },
      {
        id: "model",
        accessorFn: (a) => modelStr(a.model),
        header: "Model",
        cell: ({ row }) => (
          <ModelName model={modelStr(row.original.model)} className="text-fg-muted" />
        ),
      },
      {
        id: "version",
        accessorFn: (a) => a.version,
        header: "Version",
        cell: ({ row }) => <span className="text-fg-muted">v{row.original.version}</span>,
      },
      {
        id: "runtime",
        accessorFn: (a) => agentRuntimeKind(a),
        header: "Runtime",
        cell: ({ row }) => {
          const rb = row.original.runtime_binding;
          return (
            <RuntimeKindBadge
              kind={agentRuntimeKind(row.original)}
              detail={
                rb ? `machine ${rb.runtime_id} · ACP agent ${rb.acp_agent_id}` : undefined
              }
            />
          );
        },
      },
      {
        id: "activity",
        accessorFn: (a) => quickStats.statsFor(a.id)?.sessions ?? 0,
        header: "Activity",
        cell: ({ row }) => {
          const s = quickStats.statsFor(row.original.id);
          if (!s) {
            return <span className="inline-block h-3 w-16 rounded bg-bg-surface animate-pulse" />;
          }
          return (
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  nav(`/agents/${row.original.id}/sessions`);
                }}
                className="rounded hover:text-fg transition-colors duration-[var(--dur-quick)]"
              >
                <Badge
                  icon={<MessageSquareIcon className="size-3" />}
                  label={s.sessions}
                  title={`${s.sessions} session${s.sessions === 1 ? "" : "s"} in the last 30 days — view them`}
                />
              </button>
              {s.tokens > 0 && (
                <Badge
                  icon={<CoinsIcon className="size-3" />}
                  label={formatCompact(s.tokens)}
                  title={`${s.tokens.toLocaleString()} tokens in the last 30 days`}
                />
              )}
            </div>
          );
        },
      },
      {
        id: "resources",
        accessorFn: (a) =>
          (a.tools?.length ?? 0) + (a.skills?.length ?? 0) + (a.mcp_servers?.length ?? 0),
        header: "Resources",
        cell: ({ row }) => {
          const a = row.original;
          const toolsCount = a.tools?.length ?? 0;
          const skillsCount = a.skills?.length ?? 0;
          const mcpCount = a.mcp_servers?.length ?? 0;
          return (
            <div className="flex items-center gap-2.5">
              <Badge
                icon={<WrenchIcon className="size-3" />}
                label={toolsCount}
                title={`${toolsCount} tool${toolsCount === 1 ? "" : "s"}`}
              />
              {skillsCount > 0 && (
                <Badge
                  icon={<BookOpenIcon className="size-3" />}
                  label={skillsCount}
                  title={`${skillsCount} skill${skillsCount === 1 ? "" : "s"}`}
                />
              )}
              {mcpCount > 0 && (
                <Badge
                  icon={<PlugZapIcon className="size-3" />}
                  label={mcpCount}
                  title={`${mcpCount} MCP server${mcpCount === 1 ? "" : "s"}`}
                />
              )}
            </div>
          );
        },
      },
      {
        id: "status",
        accessorFn: (a) => (a.archived_at ? "archived" : "active"),
        header: "Status",
        cell: ({ row }) => (
          <span
            className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full ${
              row.original.archived_at
                ? "bg-bg-surface text-fg-subtle"
                : "bg-success-subtle text-success"
            }`}
          >
            {row.original.archived_at ? "archived" : "active"}
          </span>
        ),
      },
      {
        id: "created",
        accessorFn: (a) => a.created_at,
        header: "Created",
        cell: ({ row }) => (
          <span className="text-fg-muted">
            {new Date(row.original.created_at).toLocaleDateString()}
          </span>
        ),
      },
      {
        id: "updated",
        accessorFn: (a) => a.updated_at || a.created_at,
        header: "Updated",
        cell: ({ row }) => {
          const ts = row.original.updated_at || row.original.created_at;
          return (
            <span className="text-fg-muted" title={new Date(ts).toLocaleString()}>
              {formatRelative(Date.now() - new Date(ts).getTime())}
            </span>
          );
        },
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const a = row.original;
          const archived = !!a.archived_at;
          return (
            <RowActionsMenu
              label={`Actions for ${a.name}`}
              actions={[
                {
                  label: "Open chat",
                  icon: <MessageSquareIcon className="size-4" />,
                  onSelect: () => nav(`/publish/${a.id}`),
                },
                {
                  label: "View sessions",
                  icon: <ListIcon className="size-4" />,
                  onSelect: () => nav(`/agents/${a.id}/sessions`),
                },
                {
                  label: "Edit",
                  icon: <PencilIcon className="size-4" />,
                  onSelect: () => setEditAgent(a),
                },
                {
                  label: "Duplicate",
                  icon: <CopyIcon className="size-4" />,
                  onSelect: () => duplicateAgent(a),
                },
                {
                  label: "Copy agent ID",
                  icon: <CopyIcon className="size-4" />,
                  onSelect: () => {
                    navigator.clipboard.writeText(a.id);
                    toast.success("Copied agent ID");
                  },
                },
                {
                  label: "Publish…",
                  icon: <RocketIcon className="size-4" />,
                  onSelect: () => setPublishAgent(a),
                },
                {
                  label: archived ? "Unarchive" : "Archive",
                  icon: <ArchiveIcon className="size-4" />,
                  disabled: archived,
                  destructive: true,
                  onSelect: async () => {
                    if (
                      !(await confirm({
                        title: `Archive ${a.name}?`,
                        description: "The agent will be hidden from active lists. Existing sessions keep working.",
                        confirmLabel: "Archive",
                        destructive: true,
                      }))
                    )
                      return;
                    try {
                      await api(`/v1/agents/${a.id}/archive`, {
                        method: "POST",
                        body: "{}",
                      });
                      refreshAgents();
                    } catch {}
                  },
                },
                {
                  label: "Delete",
                  icon: <TrashIcon className="size-4" />,
                  destructive: true,
                  onSelect: async () => {
                    if (
                      !(await confirm({
                        title: `Delete ${a.name}?`,
                        description: "This can't be undone.",
                        confirmLabel: "Delete",
                        destructive: true,
                      }))
                    )
                      return;
                    try {
                      await api(`/v1/agents/${a.id}`, { method: "DELETE" });
                      refreshAgents();
                    } catch {}
                  },
                },
              ]}
            />
          );
        },
        enableHiding: false,
        enableResizing: false,
        size: 56,
      },
    ],
    [api, refreshAgents, confirm, nav, duplicateAgent, quickStats],
  );

  const renderExpandedRow = useCallback(
    (a: Agent) => (
      <ExpandedDetail
        rows={[
          { label: "ID", value: <span className="font-mono text-xs">{a.id}</span> },
          { label: "Model", value: modelStr(a.model) },
          { label: "Harness", value: a._oma?.harness ?? "default" },
          { label: "Tools", value: String(a.tools?.length ?? 0) },
          { label: "Version", value: `v${a.version}` },
          {
            label: "Created",
            value: new Date(a.created_at).toLocaleString(),
          },
        ]}
      />
    ),
    [],
  );

  const filters = (
    <FilterBar
      status={{
        value: status,
        onChange: (v) => setStatus(v as StatusValue),
        options: STATUS_OPTIONS,
      }}
      created={{ value: created, onChange: setCreated }}
    />
  );

  return (
    <DataTable<Agent>
      subtitle="An agent is a versioned config — model, system prompt, tools, skills, and MCP servers — that sessions run."
      createLabel="+ New agent"
      onCreate={() => setShowCreate(true)}
      searchPlaceholder="Search agents..."
      searchValue={search}
      onSearchChange={setSearch}
      filters={filters}
      data={agents}
      loading={loading}
      error={error}
      onRetry={refreshAgents}
      errorTitle="Couldn't load agents"
      getRowId={(a) => a.id}
      onRowClick={(a) => nav(`/agents/${a.id}`)}
      hasMore={hasMore}
      loadingMore={isLoadingMore}
      onLoadMore={loadMore}
      emptyTitle={search ? "No matching agents" : "No agents yet"}
      emptyKind="agent"
      emptyAction={
        !search && <Button onClick={() => setShowCreate(true)}>+ New agent</Button>
      }
      emptySubtitle={
        search ? (
          "Try a different search term."
        ) : (
          <>
            <p>
              An agent is an AI assistant with its own instructions and tools. Create your
              first one to get started.
            </p>
            <button
              onClick={() => nav("/")}
              className="inline-flex items-center min-h-11 sm:min-h-0 mt-3 text-sm text-brand hover:underline"
            >
              Get started with the quickstart guide →
            </button>
          </>
        )
      }
      columns={columns}
      renderExpandedRow={renderExpandedRow}
    >
      <AgentFormDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={refreshAgents}
        allAgents={allAgents}
        customSkills={customSkills}
        modelCards={modelCards}
        runtimes={runtimes}
      />
      {editAgent && (
        <AgentEditDialog
          open={!!editAgent}
          onClose={() => setEditAgent(null)}
          agent={editAgent}
          onSaved={() => {
            setEditAgent(null);
            refreshAgents();
          }}
        />
      )}
      {publishAgent && (
        <PublishAgentDialog
          open={!!publishAgent}
          onClose={() => setPublishAgent(null)}
          agent={publishAgent}
          onPublished={() => setPublishAgent(null)}
        />
      )}
    </DataTable>
  );
}

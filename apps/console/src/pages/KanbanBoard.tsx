import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQueries, useQueryClient } from "@tanstack/react-query";
import { RepeatIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useApi } from "../lib/api";
import { useApiQuery, useApiMutation, buildUrl } from "../lib/useApiQuery";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { GitHubIssuesBoard } from "../components/GitHubIssuesBoard";
import { FilterBar, FacetChip } from "../components/FilterBar";
import { Select, SelectOption } from "../components/Select";
import { formatRelative, shortenId } from "../lib/format";
import {
  canMoveItem,
  collectFacets,
  COLUMN_TRUNCATE_AT,
  describeCron,
  EMPTY_FILTERS,
  filterKanbanItems,
  formatCountdown,
  groupByColumn,
  isDraggable,
  isScheduleEnabled,
  KANBAN_COLUMNS,
  KANBAN_SORTS,
  sortKanbanItems,
  toScheduleItem,
  toSessionItem,
  truncateColumn,
  type BoardLookups,
  type KanbanColumn,
  type KanbanFilters,
  type KanbanItem,
  type KanbanScheduleItem,
  type KanbanSort,
  type LastEventForKanban,
  type ScheduleRecord,
} from "../lib/kanban";
import type { SessionRecord } from "../types/session";

type KanbanTab = "sessions" | "github";

// No board-wide SSE endpoint exists — SessionDetail's live stream
// (lib/sse.ts streamSse / useApi().streamEvents) is scoped to a single
// session, and opening one connection per visible card doesn't scale.
// A poll is the same auto-refresh mechanism RuntimesList uses for its
// 15s heartbeat — see apps/console/src/pages/RuntimesList.tsx.
const POLL_MS = 15_000;

// Practical cap for a board view — a Kanban board is meant to be
// glanceable, not paginated. If a tenant runs more than this many
// concurrent/recent sessions, only the most recent ones show up here;
// the full list at /sessions still supports proper pagination.
const BOARD_LIMIT = "100";

/** Collapse state of the Done column, remembered per browser. */
const DONE_COLLAPSED_KEY = "oma.kanban.doneCollapsed";

/** Wire shape of one row from GET /:id/events — the wrapper carries
 *  seq/type/ts; the actual event (stop_reason etc.) lives under `data`.
 *  See lib/kanban.ts's LastEventForKanban doc comment. */
interface EventRow {
  type: string;
  data: LastEventForKanban;
}

interface LastEventsResponse {
  data: EventRow[];
}

interface AgentLite {
  id: string;
  name?: string;
  model?: string | { id?: string };
}

interface EnvironmentLite {
  id: string;
  config?: { sandbox_provider?: string; type?: string };
}

export function KanbanBoard() {
  const [tab, setTab] = useState<KanbanTab>("sessions");

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b border-border" role="tablist" aria-label="Kanban views">
        <BoardTab
          label="Agent Session Board"
          active={tab === "sessions"}
          onClick={() => setTab("sessions")}
        />
        <BoardTab
          label="GitHub Issues"
          active={tab === "github"}
          onClick={() => setTab("github")}
        />
      </div>

      {tab === "sessions" ? <AgentSessionBoard /> : <GitHubIssuesBoard />}
    </div>
  );
}

function BoardTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      role="tab"
      aria-selected={active}
      tabIndex={active ? 0 : -1}
      className={`inline-flex items-center justify-center px-3 py-2 -mb-px border-b-2 text-sm transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
        active
          ? "border-brand text-brand font-semibold"
          : "border-transparent text-fg-subtle hover:text-fg-muted"
      }`}
    >
      {label}
    </button>
  );
}

/** Ticking clock for the schedule countdowns. Only runs while at least one
 *  schedule card is on the board, so a board of pure sessions re-renders on
 *  the poll alone. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function AgentSessionBoard() {
  const nav = useNavigate();
  const { api } = useApi();
  const queryClient = useQueryClient();

  const { data: sessionsRes, isLoading } = useApiQuery<{ data: SessionRecord[] }>(
    "/v1/sessions",
    { limit: BOARD_LIMIT },
    { refetchInterval: POLL_MS },
  );
  const sessions = useMemo(() => sessionsRes?.data ?? [], [sessionsRes]);

  // Tenant-wide schedule list (GET /v1/schedules) — one request for every
  // agent's schedules rather than fanning out per agent.
  const { data: schedulesRes } = useApiQuery<{ data: ScheduleRecord[] }>(
    "/v1/schedules",
    { limit: BOARD_LIMIT },
    { refetchInterval: POLL_MS },
  );
  const schedules = useMemo(() => schedulesRes?.data ?? [], [schedulesRes]);

  // Agents + environments only exist to resolve display names and the
  // Model / Sandbox facets — the session and schedule rows carry ids only.
  const { data: agentsRes } = useApiQuery<{ data: AgentLite[] }>("/v1/agents", { limit: "200" });
  const { data: envsRes } = useApiQuery<{ data: EnvironmentLite[] }>("/v1/environments", {
    limit: "200",
  });

  const lookups = useMemo<BoardLookups>(() => {
    const agents: NonNullable<BoardLookups["agents"]> = {};
    for (const a of agentsRes?.data ?? []) {
      const model = typeof a.model === "string" ? a.model : a.model?.id;
      agents[a.id] = { name: a.name, model };
    }
    const providers: NonNullable<BoardLookups["providers"]> = {};
    for (const e of envsRes?.data ?? []) {
      // Same precedence RuntimeInfo uses: explicit provider, legacy `type`,
      // then the Cloudflare Containers default.
      providers[e.id] = e.config?.sandbox_provider ?? e.config?.type ?? "cloud";
    }
    return { agents, providers };
  }, [agentsRes, envsRes]);

  // "running" and "terminated" are unambiguous from `status` alone.
  // "idle" is not — it covers both "never started" (queued) and
  // "finished a turn" (blocked or done), so we fetch each idle
  // session's last event to disambiguate. See deriveKanbanColumn.
  const idleSessionIds = useMemo(
    () => sessions.filter((s) => (s.status ?? "idle") === "idle").map((s) => s.id),
    [sessions],
  );

  const lastEventQueries = useQueries({
    queries: idleSessionIds.map((id) => ({
      queryKey: ["kanban-last-event", id],
      queryFn: () =>
        api<LastEventsResponse>(
          buildUrl(`/v1/sessions/${id}/events`, { order: "desc", limit: "1" }),
        ),
      refetchInterval: POLL_MS,
      staleTime: POLL_MS,
    })),
  });

  const lastEventBySessionId = useMemo(() => {
    const map = new Map<string, LastEventForKanban | null | undefined>();
    idleSessionIds.forEach((id, i) => {
      const query = lastEventQueries[i];
      if (query?.data === undefined) {
        // Fetch hasn't resolved yet — deriveKanbanColumn treats this the
        // same as "no events" (renders queued optimistically).
        map.set(id, undefined);
        return;
      }
      // Resolved: `data.data` is the events array; empty means the
      // session genuinely has zero events yet (null, not undefined).
      const row = query.data.data[0];
      map.set(id, row ? row.data : null);
    });
    return map;
  }, [idleSessionIds, lastEventQueries]);

  // ── Board items: sessions + schedules, merged into one model ───────────
  const allItems = useMemo<KanbanItem[]>(() => {
    const items: KanbanItem[] = sessions.map((s) =>
      toSessionItem(s, lastEventBySessionId.get(s.id), lookups),
    );
    for (const sch of schedules) items.push(toScheduleItem(sch, lookups));
    return items;
  }, [sessions, schedules, lastEventBySessionId, lookups]);

  // ── Filters + sort ─────────────────────────────────────────────────────
  const [filters, setFilters] = useState<KanbanFilters>(EMPTY_FILTERS);
  const [sort, setSort] = useState<KanbanSort>("recent");
  const facets = useMemo(() => collectFacets(allItems), [allItems]);

  const columns = useMemo(
    () => groupByColumn(sortKanbanItems(filterKanbanItems(allItems, filters), sort)),
    [allItems, filters, sort],
  );

  // ── Done column: collapsible + truncated ───────────────────────────────
  const [doneCollapsed, setDoneCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(DONE_COLLAPSED_KEY) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(DONE_COLLAPSED_KEY, doneCollapsed ? "1" : "0");
    } catch {
      // Private-mode / blocked storage — collapse still works for the session.
    }
  }, [doneCollapsed]);
  const [expandedColumns, setExpandedColumns] = useState<Record<string, boolean>>({});

  // ── Drag & drop ────────────────────────────────────────────────────────
  const [dragItem, setDragItem] = useState<KanbanItem | null>(null);
  const [dragOver, setDragOver] = useState<KanbanColumn | null>(null);
  const toggleMutation = useApiMutation();

  const applyMove = useCallback(
    async (item: KanbanItem, to: KanbanColumn) => {
      const verdict = canMoveItem(item, to);
      if (!verdict.allowed || verdict.enabled === undefined || item.kind !== "schedule") return;
      await toggleMutation.mutateAsync({
        path: `/v1/agents/${item.agentId}/schedules/${item.id}`,
        method: "PATCH",
        body: { enabled: verdict.enabled },
      });
      await queryClient.invalidateQueries({ queryKey: ["/v1/schedules"] });
    },
    [toggleMutation, queryClient],
  );

  const hasSchedules = schedules.length > 0;
  const now = useNow(hasSchedules);

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
        {KANBAN_COLUMNS.map((c) => (
          <div key={c.id} className="space-y-2">
            <Skeleton className="h-5 w-24" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        ))}
      </div>
    );
  }

  if (allItems.length === 0) {
    return (
      <EmptyState
        title="No sessions yet"
        body="Sessions will appear here once created through the API. Agent schedules show up as recurring cards."
        kind="session"
        size="lg"
      />
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Toolbar: facets + sort ─────────────────────────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1" data-testid="kanban-filters">
          <FilterBar
            agent={{
              value: filters.agent,
              onChange: (v) => setFilters((f) => ({ ...f, agent: v })),
              options: facets.agents,
            }}
          >
            {facets.kinds.length > 1 && (
              <FacetChip
                defaultLabel="Type"
                facet={{
                  value: filters.kind,
                  onChange: (v) => setFilters((f) => ({ ...f, kind: v })),
                  options: facets.kinds,
                }}
              />
            )}
            {facets.models.length > 0 && (
              <FacetChip
                defaultLabel="Model"
                facet={{
                  value: filters.model,
                  onChange: (v) => setFilters((f) => ({ ...f, model: v })),
                  options: facets.models,
                }}
              />
            )}
            {facets.providers.length > 0 && (
              <FacetChip
                defaultLabel="Sandbox"
                facet={{
                  value: filters.provider,
                  onChange: (v) => setFilters((f) => ({ ...f, provider: v })),
                  options: facets.providers,
                }}
              />
            )}
          </FilterBar>
        </div>

        <label className="flex items-center gap-2 text-xs text-fg-subtle">
          Sort
          <Select value={sort} onValueChange={(v) => setSort(v as KanbanSort)}>
            {KANBAN_SORTS.map((s) => (
              <SelectOption key={s.id} value={s.id}>
                {s.label}
              </SelectOption>
            ))}
          </Select>
        </label>
      </div>

      <div
        className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4"
        data-testid="kanban-board"
      >
        {KANBAN_COLUMNS.map((col) => {
          const items = columns[col.id];
          const collapsed = col.id === "done" && doneCollapsed;
          const dropVerdict = dragItem ? canMoveItem(dragItem, col.id) : null;
          const { visible, hiddenCount } = truncateColumn(
            items,
            COLUMN_TRUNCATE_AT,
            !!expandedColumns[col.id],
          );

          return (
            <div
              key={col.id}
              className={`flex flex-col gap-2 min-w-0 rounded-lg transition-colors duration-[var(--dur-quick)] ${
                dragOver === col.id && dropVerdict?.allowed
                  ? "ring-1 ring-brand bg-brand-subtle/30"
                  : ""
              }`}
              data-testid={`kanban-column-${col.id}`}
              onDragOver={(e) => {
                if (!dropVerdict?.allowed) return;
                e.preventDefault();
                setDragOver(col.id);
              }}
              onDragLeave={() => setDragOver((c) => (c === col.id ? null : c))}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const item = dragItem;
                setDragItem(null);
                if (item) void applyMove(item, col.id);
              }}
            >
              <div className="flex items-center justify-between px-1">
                {col.id === "done" ? (
                  <button
                    type="button"
                    onClick={() => setDoneCollapsed((v) => !v)}
                    aria-expanded={!collapsed}
                    className="inline-flex items-center gap-1 text-sm font-medium text-fg hover:text-brand"
                  >
                    {collapsed ? (
                      <ChevronRightIcon className="size-3.5" />
                    ) : (
                      <ChevronDownIcon className="size-3.5" />
                    )}
                    {col.label}
                  </button>
                ) : (
                  <h2 className="text-sm font-medium text-fg">{col.label}</h2>
                )}
                <span className="text-xs text-fg-subtle tabular-nums">{items.length}</span>
              </div>

              {collapsed ? null : (
                <div className="flex flex-col gap-2">
                  {items.length === 0 ? (
                    <div className="text-xs text-fg-subtle border border-dashed border-border rounded-lg px-3 py-4 text-center">
                      Empty
                    </div>
                  ) : (
                    <>
                      {visible.map((item) => (
                        <BoardCard
                          key={item.id}
                          item={item}
                          now={now}
                          onOpen={() => {
                            if (item.kind === "session") nav(`/sessions/${item.id}`);
                            else nav(`/agents/${item.agentId}`);
                          }}
                          onDragStart={() => setDragItem(item)}
                          onDragEnd={() => {
                            setDragItem(null);
                            setDragOver(null);
                          }}
                        />
                      ))}
                      {hiddenCount > 0 && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedColumns((s) => ({ ...s, [col.id]: true }))
                          }
                          className="text-xs text-fg-muted hover:text-brand border border-dashed border-border rounded-lg px-3 py-2"
                        >
                          Show {hiddenCount} more
                        </button>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function BoardCard({
  item,
  now,
  onOpen,
  onDragStart,
  onDragEnd,
}: {
  item: KanbanItem;
  now: number;
  onOpen: () => void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const draggable = isDraggable(item);
  // A refused drag explains itself on hover rather than silently doing
  // nothing — "paused" is the only column any of this can persist.
  const title = draggable ? undefined : canMoveItem(item, "paused").reason;

  return (
    <div
      draggable={draggable}
      title={title}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      data-testid={item.kind === "schedule" ? "kanban-schedule-card" : "kanban-session-card"}
      className={`text-left border border-border rounded-lg bg-bg-surface/40 hover:border-border-strong hover:bg-bg-surface px-3 py-2.5 transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
        draggable ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"
      }`}
    >
      <div className="flex items-start gap-1.5">
        {item.kind === "schedule" && (
          <RepeatIcon className="size-3.5 mt-0.5 shrink-0 text-brand" aria-label="Recurring" />
        )}
        <div className="text-sm font-medium text-fg truncate">{item.title}</div>
      </div>

      {item.kind === "schedule" ? (
        <ScheduleMeta item={item} now={now} />
      ) : (
        <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-fg-subtle font-mono">
          <span className="truncate">{item.agentName || shortenId(item.agentId)}</span>
          <span className="shrink-0">
            {formatRelative(Date.now() - new Date(item.createdAt).getTime())}
          </span>
        </div>
      )}
    </div>
  );
}

function ScheduleMeta({ item, now }: { item: KanbanScheduleItem; now: number }) {
  const sch = item.schedule;
  const enabled = isScheduleEnabled(sch);
  const nextMs = sch.next_run_at ? Date.parse(sch.next_run_at) : NaN;
  const countdown = enabled
    ? formatCountdown(Number.isNaN(nextMs) ? null : nextMs - now)
    : "paused";

  return (
    <>
      <div className="mt-1 flex flex-wrap items-center gap-1.5">
        <span className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[10px] text-fg-muted">
          {describeCron(sch.cron_expression)}
          {sch.timezone && sch.timezone !== "UTC" ? ` · ${sch.timezone}` : ""}
        </span>
        <span
          className={`text-[10px] tabular-nums ${enabled ? "text-brand" : "text-fg-subtle"}`}
          data-testid="kanban-schedule-countdown"
        >
          {countdown}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-fg-subtle font-mono">
        <span className="truncate">{item.agentName || shortenId(item.agentId)}</span>
        {sch.last_session_id ? (
          // Links the schedule to the session its last firing created — that
          // session is itself a card on this board.
          <a
            href={`/sessions/${sch.last_session_id}`}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 hover:text-brand"
          >
            last run {shortenId(sch.last_session_id)}
          </a>
        ) : (
          <span className="shrink-0">never run</span>
        )}
      </div>
    </>
  );
}

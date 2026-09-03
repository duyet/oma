import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { HistoryIcon, PencilIcon, PlayIcon, TrashIcon } from "lucide-react";
import { toast } from "sonner";

import { useApi } from "../../lib/api";
import { useApiQuery } from "../../lib/useApiQuery";
import { DataTable, ExpandedDetail, type ColumnDef } from "../../components/DataTable";
import { RowActionsMenu } from "../../components/RowActionsMenu";
import { StatusPill } from "../../components/StatusPill";
import { FormDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/hooks/useConfirm";
import { formatRelative } from "../../lib/format";
import { useAgentHub } from "../AgentDetail";
import { CreateScheduleDialog } from "./CreateScheduleDialog";
import { scheduleStatusTone } from "./schedule-status";
import type { AgentSchedule, ScheduleRun } from "./schedule-types";

/**
 * Tab — cron schedules scoped to this agent (see AGENTS.md "Agent
 * Schedules"). Supports create, edit (PATCH — widened in WP1 to accept
 * cron/input/environment/timezone/max_sessions/enabled), run now, delete,
 * and viewing per-schedule run history (WP3's
 * `GET /v1/agents/:id/schedules/:id/runs`).
 */
export function AgentSchedulesTab() {
  const { agent } = useAgentHub();
  const { api } = useApi();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<AgentSchedule | null>(null);
  const [viewingRuns, setViewingRuns] = useState<AgentSchedule | null>(null);
  const confirm = useConfirm();

  const {
    data,
    isLoading,
    refetch,
  } = useApiQuery<{ data: AgentSchedule[] }>(`/v1/agents/${agent.id}/schedules`);
  const items = data?.data ?? [];

  const runNow = async (s: AgentSchedule) => {
    try {
      await api(`/v1/agents/${agent.id}/schedules/${s.id}/run`, { method: "POST" });
      toast.success("Queued — will fire on the next cron tick");
      refetch();
    } catch {
      // api() toasts the error.
    }
  };

  const del = async (s: AgentSchedule) => {
    if (
      !(await confirm({
        title: "Delete schedule?",
        description: `Cron "${s.cron_expression}" will stop firing. This can't be undone.`,
        confirmLabel: "Delete",
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/v1/agents/${agent.id}/schedules/${s.id}`, { method: "DELETE" });
      refetch();
    } catch {
      // api() toasts the error.
    }
  };

  const columns = useMemo<ColumnDef<AgentSchedule>[]>(
    () => [
      {
        id: "cron",
        header: "Cron",
        cell: ({ row }) => (
          <span className="font-mono text-sm text-fg">{row.original.cron_expression}</span>
        ),
        enableHiding: false,
      },
      {
        id: "timezone",
        header: "Timezone",
        cell: ({ row }) => <span className="text-xs text-fg-muted">{row.original.timezone}</span>,
      },
      {
        id: "enabled",
        header: "Enabled",
        cell: ({ row }) => (
          <span
            className={
              "inline-flex items-center text-[11px] px-1.5 py-0.5 rounded " +
              (row.original.enabled
                ? "bg-success-subtle text-success"
                : "bg-bg-surface text-fg-muted")
            }
          >
            {row.original.enabled ? "Enabled" : "Disabled"}
          </span>
        ),
      },
      {
        id: "next_run",
        header: "Next run",
        cell: ({ row }) => {
          const t = row.original.next_run_at;
          if (!t) return <span className="text-fg-subtle text-xs">Never</span>;
          return (
            <span className="text-xs text-fg-muted">
              {formatRelative(new Date(t).getTime() - Date.now())}
            </span>
          );
        },
      },
      {
        id: "last_run",
        header: "Last run",
        cell: ({ row }) => {
          const s = row.original;
          if (!s.last_run_at) return <span className="text-fg-subtle text-xs">Never</span>;
          const rel = formatRelative(Date.now() - new Date(s.last_run_at).getTime());
          const label = (
            <span className="inline-flex items-center gap-1.5 text-xs">
              <StatusPill
                status={scheduleStatusTone(s.last_run_status)}
                label={s.last_run_status ?? "—"}
              />
              <span className="text-fg-muted">{rel}</span>
            </span>
          );
          return s.last_session_id ? (
            <Link
              to={`/sessions/${s.last_session_id}`}
              onClick={(e) => e.stopPropagation()}
              className="hover:underline"
            >
              {label}
            </Link>
          ) : (
            label
          );
        },
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const s = row.original;
          return (
            <RowActionsMenu
              label={`Actions for schedule ${s.id}`}
              actions={[
                {
                  label: "Run now",
                  icon: <PlayIcon className="size-4" />,
                  onSelect: () => runNow(s),
                },
                {
                  label: "Edit",
                  icon: <PencilIcon className="size-4" />,
                  onSelect: () => setEditing(s),
                },
                {
                  label: "Run history",
                  icon: <HistoryIcon className="size-4" />,
                  onSelect: () => setViewingRuns(s),
                },
                {
                  label: "Delete",
                  icon: <TrashIcon className="size-4" />,
                  destructive: true,
                  onSelect: () => del(s),
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, agent.id],
  );

  return (
    <>
      <DataTable<AgentSchedule>
        createLabel="+ Create schedule"
        onCreate={() => setShowCreate(true)}
        data={items}
        loading={isLoading}
        getRowId={(s) => s.id}
        hasMore={false}
        loadingMore={false}
        onLoadMore={() => {}}
        emptyTitle="No schedules"
        emptySubtitle="Run this agent on a cron cadence — recurring maintenance, digests, or polling jobs."
        emptyAction={<Button onClick={() => setShowCreate(true)}>+ Create schedule</Button>}
        columns={columns}
        renderExpandedRow={(s) => <ExpandedScheduleDetail agentId={agent.id} schedule={s} />}
      />

      <CreateScheduleDialog
        open={showCreate}
        onClose={() => setShowCreate(false)}
        agent={agent}
        onCreated={() => {
          refetch();
        }}
      />

      <CreateScheduleDialog
        open={!!editing}
        onClose={() => setEditing(null)}
        agent={agent}
        schedule={editing}
        onCreated={() => {
          refetch();
        }}
      />

      <ScheduleRunsDialog
        open={!!viewingRuns}
        onClose={() => setViewingRuns(null)}
        agent={agent}
        schedule={viewingRuns}
      />
    </>
  );
}

interface RunsResponse {
  data: ScheduleRun[];
  next_cursor?: string;
}

function ExpandedScheduleDetail({
  agentId,
  schedule,
}: {
  agentId: string;
  schedule: AgentSchedule;
}) {
  const { data, isLoading } = useApiQuery<{ data: ScheduleRun[] }>(
    `/v1/agents/${agentId}/schedules/${schedule.id}/runs`,
    { limit: "20" },
    { refetchInterval: 15000 },
  );
  const runs = data?.data ?? [];

  return (
    <div className="space-y-4">
      <ExpandedDetail
        rows={[
          { label: "ID", value: <span className="font-mono text-xs">{schedule.id}</span> },
          { label: "Cron", value: schedule.cron_expression },
          { label: "Timezone", value: schedule.timezone },
          { label: "Environment", value: schedule.environment_id },
          { label: "Enabled", value: schedule.enabled ? "Yes" : "No" },
          {
            label: "Next run",
            value: schedule.next_run_at ? new Date(schedule.next_run_at).toLocaleString() : "Never",
          },
        ]}
      />
      <div>
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-medium mb-2">
          Recent runs
        </div>
        {isLoading && runs.length === 0 ? (
          <p className="text-xs text-fg-subtle">Loading…</p>
        ) : runs.length === 0 ? (
          <p className="text-xs text-fg-subtle">No runs yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {runs.map((r) => {
              const ts = r.started_at ?? r.created_at;
              return (
                <li key={r.id} className="flex items-center gap-2 text-xs min-w-0">
                  <span className="text-fg-subtle tabular-nums whitespace-nowrap">
                    {formatRelative(Date.now() - new Date(ts).getTime())}
                  </span>
                  <StatusPill status={scheduleStatusTone(r.status)} label={r.status} />
                  {r.session_id ? (
                    <Link
                      to={`/sessions/${r.session_id}`}
                      className="hover:underline font-mono truncate"
                    >
                      {r.session_id}
                    </Link>
                  ) : (
                    <span className="text-fg-subtle">—</span>
                  )}
                  {r.error && <span className="text-danger truncate">{r.error}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Modal listing a schedule's firing history (WP3's `GET
 * /v1/agents/:agentId/schedules/:scheduleId/runs`, cursor-paginated).
 * Fetches on open; "Load more" appends the next page via the cursor.
 */
function ScheduleRunsDialog({
  open,
  onClose,
  agent,
  schedule,
}: {
  open: boolean;
  onClose: () => void;
  agent: { id: string };
  schedule: AgentSchedule | null;
}) {
  const { api } = useApi();
  const [runs, setRuns] = useState<ScheduleRun[]>([]);
  const [cursor, setCursor] = useState<string | undefined>(undefined);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = async (scheduleId: string, after?: string) => {
    setLoading(true);
    try {
      const qs = after ? `?cursor=${encodeURIComponent(after)}` : "";
      const res = await api<RunsResponse>(
        `/v1/agents/${agent.id}/schedules/${scheduleId}/runs${qs}`,
      );
      setRuns((prev) => (after ? [...prev, ...res.data] : res.data));
      setCursor(res.next_cursor);
      setHasMore(!!res.next_cursor);
    } catch {
      // api() toasts the error.
    } finally {
      setLoading(false);
    }
  };

  // Fetch the first page whenever the dialog opens for a (new) schedule.
  const scheduleId = schedule?.id;
  useEffect(() => {
    if (!open || !scheduleId) return;
    setRuns([]);
    setCursor(undefined);
    setHasMore(false);
    void load(scheduleId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, scheduleId]);

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Run history"
      subtitle={schedule ? `Firings of cron "${schedule.cron_expression}"` : undefined}
      maxWidth="max-w-xl"
    >
      {loading && runs.length === 0 ? (
        <p className="text-sm text-fg-subtle">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-fg-subtle">No runs yet.</p>
      ) : (
        <div className="space-y-2">
          {runs.map((r) => (
            <div
              key={r.id}
              className="border border-border rounded-md px-3 py-2 flex flex-col gap-1"
            >
              <div className="flex items-center justify-between gap-2">
                <StatusPill status={scheduleStatusTone(r.status)} label={r.status} />
                <span className="text-xs text-fg-subtle">
                  {r.started_at
                    ? formatRelative(Date.now() - new Date(r.started_at).getTime())
                    : formatRelative(Date.now() - new Date(r.created_at).getTime())}
                </span>
              </div>
              {r.summary && <p className="text-xs text-fg-muted">{r.summary}</p>}
              {r.error && <p className="text-xs text-danger">{r.error}</p>}
              {r.session_id && (
                <Link to={`/sessions/${r.session_id}`} className="text-xs hover:underline">
                  View session →
                </Link>
              )}
            </div>
          ))}
          {hasMore && (
            <div className="flex justify-center pt-1">
              <Button
                variant="outline"
                size="sm"
                loading={loading}
                onClick={() => schedule && load(schedule.id, cursor)}
              >
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </FormDialog>
  );
}

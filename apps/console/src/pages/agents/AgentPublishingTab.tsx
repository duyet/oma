import { useMemo, useState } from "react";
import { Link } from "react-router";
import { CopyIcon, ExternalLinkIcon, PauseIcon, PencilIcon, PlayIcon, TrashIcon } from "lucide-react";
import { toast } from "sonner";

import { useApi } from "../../lib/api";
import { useApiQuery, formatQueryError } from "../../lib/useApiQuery";
import { DataTable, type ColumnDef } from "../../components/DataTable";
import { RowActionsMenu } from "../../components/RowActionsMenu";
import { StatusPill } from "../../components/Badge";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/hooks/useConfirm";
import { useAgentHub } from "../AgentDetail";
import { PublishAgentDialog } from "./PublishAgentDialog";
import { EditPublicationDialog } from "./EditPublicationDialog";
import type { Publication } from "./publication-types";

// Publication.status → StatusPill tone. Mirrors MyBots.tsx.
const STATUS_TONE: Record<Publication["status"], string> = {
  live: "completed",
  draft: "idle",
  paused: "errored",
};

/** Public URL for a slug — same origin as the API worker (`/p/*`). */
function publicUrl(slug: string): string {
  return `${window.location.origin}/p/${slug}`;
}

/**
 * Tab 5 — publish this agent as a public bot (issue #179). Empty state
 * opens `PublishAgentDialog` (`POST /v1/agents/:id/publications`); once
 * published, lists this agent's publication(s) — an agent can be
 * published more than once under different slugs — with status,
 * visibility, and pause/resume/unpublish/copy-link/open-chat row actions.
 * "My Bots →" links out to the tenant-wide dashboard for the QR code +
 * embed snippet (ShareModal) rather than duplicating that here. "Open test
 * chat →" opens `/publish/:agent_id` (issue #227) — a lightweight,
 * unpublished-safe chat page for smoke-testing the agent directly, distinct
 * from a row's "Open chat" (which opens that publication's live public URL).
 */
export function AgentPublishingTab() {
  const { agent } = useAgentHub();
  const { api } = useApi();
  const [showPublish, setShowPublish] = useState(false);
  const [editing, setEditing] = useState<Publication | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const confirm = useConfirm();

  const {
    data,
    isLoading,
    error: queryError,
    refetch,
  } = useApiQuery<{ data: Publication[] }>(`/v1/agents/${agent.id}/publications`);
  const pubs = useMemo(() => data?.data ?? [], [data]);
  const error = formatQueryError(queryError);

  const setStatus = async (pub: Publication, status: Publication["status"]) => {
    setBusyId(pub.id);
    try {
      await api(`/v1/agents/${agent.id}/publications/${pub.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      toast.success(status === "paused" ? "Bot paused" : "Bot live");
      refetch();
    } catch {
      // api() already toasted.
    }
    setBusyId(null);
  };

  const unpublish = async (pub: Publication) => {
    if (
      !(await confirm({
        title: `Unpublish "${pub.title}"?`,
        description: "Its public link will stop working.",
        confirmLabel: "Unpublish",
        destructive: true,
      }))
    )
      return;
    setBusyId(pub.id);
    try {
      await api(`/v1/agents/${agent.id}/publications/${pub.id}`, { method: "DELETE" });
      toast.success("Unpublished");
      refetch();
    } catch {
      // api() already toasted.
    }
    setBusyId(null);
  };

  const copyLink = (slug: string) => {
    void navigator.clipboard.writeText(publicUrl(slug)).then(
      () => toast.success("Public link copied"),
      () => toast.error("Could not copy link"),
    );
  };

  const columns = useMemo<ColumnDef<Publication>[]>(
    () => [
      {
        id: "title",
        accessorKey: "title",
        header: "Bot",
        cell: ({ row }) => (
          <div>
            <div className="font-medium text-fg">{row.original.title}</div>
            <a
              href={publicUrl(row.original.slug)}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="text-xs text-brand hover:underline"
            >
              /p/{row.original.slug}
            </a>
          </div>
        ),
        enableHiding: false,
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => (
          <StatusPill status={STATUS_TONE[row.original.status]} label={row.original.status} />
        ),
      },
      {
        id: "visibility",
        header: "Visibility",
        cell: ({ row }) => (
          <span className="text-fg-muted capitalize">{row.original.visibility}</span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => {
          const pub = row.original;
          const busy = busyId === pub.id;
          return (
            <RowActionsMenu
              label={`Actions for ${pub.title}`}
              actions={[
                {
                  label: "Open chat",
                  icon: <ExternalLinkIcon className="size-4" />,
                  onSelect: () => window.open(publicUrl(pub.slug), "_blank", "noreferrer"),
                },
                {
                  label: "Copy link",
                  icon: <CopyIcon className="size-4" />,
                  onSelect: () => copyLink(pub.slug),
                },
                {
                  label: "Edit",
                  icon: <PencilIcon className="size-4" />,
                  onSelect: () => setEditing(pub),
                },
                {
                  label: pub.status === "paused" ? "Resume" : "Pause",
                  icon:
                    pub.status === "paused" ? (
                      <PlayIcon className="size-4" />
                    ) : (
                      <PauseIcon className="size-4" />
                    ),
                  disabled: busy,
                  onSelect: () => setStatus(pub, pub.status === "paused" ? "live" : "paused"),
                },
                {
                  label: "Unpublish",
                  icon: <TrashIcon className="size-4" />,
                  destructive: true,
                  disabled: busy,
                  onSelect: () => unpublish(pub),
                },
              ]}
            />
          );
        },
        enableHiding: false,
        size: 56,
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [api, busyId, agent.id],
  );

  return (
    <>
      <DataTable<Publication>
        createLabel="+ Publish as bot"
        onCreate={() => setShowPublish(true)}
        headerActions={
          <div className="flex items-center gap-4">
            <Link
              to={`/publish/${agent.id}`}
              target="_blank"
              rel="noreferrer"
              className="text-sm text-brand hover:underline whitespace-nowrap"
            >
              Open test chat →
            </Link>
            <Link to="/my-bots" className="text-sm text-brand hover:underline whitespace-nowrap">
              My Bots →
            </Link>
          </div>
        }
        data={pubs}
        loading={isLoading}
        error={error}
        onRetry={refetch}
        errorTitle="Couldn't load publications"
        getRowId={(p) => p.id}
        emptyTitle="Not published"
        emptySubtitle="Publish this agent to share a public chat page, embed widget, or QR code."
        emptyAction={<Button onClick={() => setShowPublish(true)}>+ Publish as bot</Button>}
        columns={columns}
      />

      <PublishAgentDialog
        open={showPublish}
        onClose={() => setShowPublish(false)}
        agent={agent}
        onPublished={() => refetch()}
      />

      {editing && (
        <EditPublicationDialog
          open
          onClose={() => setEditing(null)}
          agentId={agent.id}
          publication={editing}
          onUpdated={() => {
            setEditing(null);
            refetch();
          }}
        />
      )}
    </>
  );
}

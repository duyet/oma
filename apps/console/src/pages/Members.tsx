import { useEffect, useMemo, useState } from "react";
import { XCircleIcon } from "lucide-react";
import { useApi } from "../lib/api";
import { useAsyncAction } from "../hooks/useAsyncAction";
import { Modal } from "../components/Modal";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/hooks/useConfirm";
import { DataTable, type ColumnDef } from "../components/DataTable";
import { RowActionsMenu } from "../components/RowActionsMenu";

// Workspace members + pending teammate invites (issue #175). Owners/admins
// invite by email + role; the invitee accepts via /invites/:token (matched to
// their signed-in email) which joins them to this workspace.

interface Member {
  user_id: string;
  email: string | null;
  name: string | null;
  role: string;
  created_at: number;
}

interface Invite {
  id: string;
  email: string;
  role: string;
  status: string;
  created_at: number;
  expires_at: number;
}

const ROLES = ["member", "admin"] as const;

export function Members() {
  const { api } = useApi();
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [showInvite, setShowInvite] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<(typeof ROLES)[number]>("member");
  const [error, setError] = useState("");
  const confirm = useConfirm();

  const load = async () => {
    setLoading(true);
    setListError(null);
    try {
      const [m, i] = await Promise.all([
        api<{ data: Member[] }>("/v1/tenant/members"),
        api<{ data: Invite[] }>("/v1/tenant/invites"),
      ]);
      setMembers(m.data);
      setInvites(i.data);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Failed to load members");
    }
    setLoading(false);
  };

  useEffect(() => {
    load();
  }, []);

  const invite = useAsyncAction(async () => {
    setError("");
    try {
      await api("/v1/tenant/invites", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), role }),
      });
      setShowInvite(false);
      setEmail("");
      setRole("member");
      load();
    } catch (e: any) {
      setError(e?.message || "Failed to send invite");
    }
  });

  const revoke = async (id: string, forEmail: string) => {
    if (
      !(await confirm({
        title: "Revoke this invite?",
        description: `${forEmail} will no longer be able to join with this link.`,
        confirmLabel: "Revoke",
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/v1/tenant/invites/${id}`, { method: "DELETE" });
      load();
    } catch {}
  };

  const closeDialog = () => {
    setShowInvite(false);
    setEmail("");
    setRole("member");
    setError("");
  };

  const inputCls =
    "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";

  const memberColumns = useMemo<ColumnDef<Member>[]>(
    () => [
      {
        id: "email",
        accessorKey: "email",
        header: "Member",
        cell: ({ row }) => (
          <>
            <div className="font-medium text-fg">{row.original.email || row.original.user_id}</div>
            {row.original.name ? (
              <div className="text-xs text-fg-subtle">{row.original.name}</div>
            ) : null}
          </>
        ),
        enableHiding: false,
      },
      {
        id: "role",
        accessorKey: "role",
        header: "Role",
        cell: ({ row }) => <span className="text-fg-muted text-sm capitalize">{row.original.role}</span>,
      },
    ],
    [],
  );

  const inviteColumns = useMemo<ColumnDef<Invite>[]>(
    () => [
      {
        id: "email",
        accessorKey: "email",
        header: "Invited",
        cell: ({ row }) => <span className="font-medium text-fg">{row.original.email}</span>,
        enableHiding: false,
      },
      {
        id: "role",
        accessorKey: "role",
        header: "Role",
        cell: ({ row }) => <span className="text-fg-muted text-sm capitalize">{row.original.role}</span>,
      },
      {
        id: "expires",
        accessorKey: "expires_at",
        header: "Expires",
        cell: ({ row }) => (
          <span className="text-fg-muted text-xs">
            {new Date(row.original.expires_at).toLocaleDateString()}
          </span>
        ),
      },
      {
        id: "actions",
        header: "",
        cell: ({ row }) => (
          <RowActionsMenu
            label={`Actions for ${row.original.email}`}
            actions={[
              {
                label: "Revoke",
                icon: <XCircleIcon className="size-4" />,
                destructive: true,
                onSelect: () => {
                  void revoke(row.original.id, row.original.email);
                },
              },
            ]}
          />
        ),
        enableHiding: false,
        size: 56,
      },
    ],
    [],
  );

  return (
    <>
      <DataTable<Member>
        subtitle="People with access to this workspace. Invite a teammate by email to collaborate."
        createLabel="+ Invite teammate"
        onCreate={() => setShowInvite(true)}
        data={members}
        loading={loading}
        error={listError}
        onRetry={load}
        errorTitle="Couldn't load members"
        getRowId={(m) => m.user_id}
        emptyTitle="No members yet"
        emptySubtitle="Invite a teammate by email to start collaborating in this workspace."
        columns={memberColumns}
      >
        {invites.length > 0 && (
          <div className="mt-8">
            <h2 className="text-sm font-medium text-fg mb-2">Pending invites</h2>
            <DataTable<Invite>
              data={invites}
              loading={false}
              getRowId={(i) => i.id}
              emptyTitle="No pending invites"
              columns={inviteColumns}
            />
          </div>
        )}
        <Modal
          open={showInvite}
          onClose={closeDialog}
          title="Invite a teammate"
          footer={
            <>
              <Button variant="ghost" onClick={closeDialog} disabled={invite.loading}>
                Cancel
              </Button>
              <Button onClick={invite.run} loading={invite.loading} loadingLabel="Sending…">
                Send invite
              </Button>
            </>
          }
        >
          <div className="space-y-3">
            {error && (
              <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
                {error}
              </div>
            )}
            <div>
              <label htmlFor="invite-email" className="text-sm text-fg-muted block mb-1">
                Email address
              </label>
              <input
                id="invite-email"
                type="email"
                className={inputCls}
                placeholder="teammate@example.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoFocus
              />
            </div>
            <div>
              <label htmlFor="invite-role" className="text-sm text-fg-muted block mb-1">
                Role
              </label>
              <select
                id="invite-role"
                className={inputCls}
                value={role}
                onChange={(e) => setRole(e.target.value as (typeof ROLES)[number])}
              >
                <option value="member">Member — can use the workspace</option>
                <option value="admin">Admin — can also manage members</option>
              </select>
            </div>
            <p className="text-xs text-fg-subtle">
              They'll get a link to accept. It must be accepted while signed in with this exact
              email address, and expires in 7 days.
            </p>
          </div>
        </Modal>
      </DataTable>
    </>
  );
}

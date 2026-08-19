import { useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { CopyIcon, ExternalLinkIcon, PauseIcon, PlayIcon, PencilIcon, QrCodeIcon } from "lucide-react";

import { useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { useQueryClient } from "@tanstack/react-query";
import { StatusPill } from "@/components/StatusPill";
import { FormDialog } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { encodeQrToMatrix, qrMatrixToSvg } from "../lib/qrcode";
import { EditPublicationDialog } from "./agents/EditPublicationDialog";
import type { Publication } from "./agents/publication-types";

/**
 * "My Bots" — creator dashboard listing this tenant's agent publications
 * (issue #75). Each row surfaces status/visibility, the public link, a
 * conversation count (issue #237), and pause/resume, edit, copy-link, and a
 * Share panel (public URL + QR code + embed snippet).
 */

// Publication.status → StatusPill tone.
const STATUS_TONE: Record<Publication["status"], string> = {
  live: "completed",
  draft: "idle",
  paused: "errored",
};

/** Public URL for a slug. The Console is served from the same origin as the
 *  API worker (`/p/*` lives on that worker), so window.origin is correct. */
function publicUrl(slug: string): string {
  return `${window.location.origin}/p/${slug}`;
}

export function MyBots() {
  const { api } = useApi();
  const nav = useNavigate();
  const qc = useQueryClient();
  const [shareOf, setShareOf] = useState<Publication | null>(null);
  const [editing, setEditing] = useState<Publication | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const { data, isLoading } = useApiQuery<{ data: Publication[] }>("/v1/publications", {
    limit: "100",
  });
  const pubs = useMemo(() => data?.data ?? [], [data]);

  const copyLink = (slug: string) => {
    void navigator.clipboard.writeText(publicUrl(slug)).then(
      () => toast.success("Public link copied"),
      () => toast.error("Could not copy link"),
    );
  };

  const setStatus = async (pub: Publication, status: Publication["status"]) => {
    setBusyId(pub.id);
    try {
      await api(`/v1/agents/${pub.agent_id}/publications/${pub.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      await qc.invalidateQueries({ queryKey: ["/v1/publications"] });
      toast.success(status === "paused" ? "Bot paused" : "Bot live");
    } catch {
      // error toasted by api()
    }
    setBusyId(null);
  };

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-5xl mx-auto px-4 py-8">
        <header className="mb-6">
          <h1 className="font-display text-2xl font-semibold text-fg">My Bots</h1>
          <p className="text-sm text-fg-muted mt-1">
            Published agents. Share the public link, embed the chat widget, or pause a bot.
          </p>
        </header>

        {isLoading ? (
          <p className="text-sm text-fg-subtle">Loading…</p>
        ) : pubs.length === 0 ? (
          <div className="border border-border rounded-lg p-10 text-center">
            <p className="text-sm text-fg-muted">No published bots yet.</p>
            <p className="text-xs text-fg-subtle mt-1">
              Open an agent, then use its Publishing tab to share a public chat page, embed
              widget, or QR code.
            </p>
            <Button className="mt-4" onClick={() => nav("/agents")}>
              Go to Agents
            </Button>
          </div>
        ) : (
          <div className="border border-border rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border text-left text-fg-muted">
                  <th className="font-medium px-4 py-2.5">Bot</th>
                  <th className="font-medium px-4 py-2.5">Status</th>
                  <th className="font-medium px-4 py-2.5">Visibility</th>
                  <th className="font-medium px-4 py-2.5">Conversations</th>
                  <th className="font-medium px-4 py-2.5 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {pubs.map((pub) => (
                  <tr key={pub.id} className="border-b border-border last:border-0">
                    <td className="px-4 py-3">
                      <div className="font-medium text-fg">{pub.title}</div>
                      <a
                        href={publicUrl(pub.slug)}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-brand hover:underline"
                      >
                        /p/{pub.slug}
                      </a>
                    </td>
                    <td className="px-4 py-3">
                      <StatusPill status={STATUS_TONE[pub.status]} label={pub.status} />
                    </td>
                    <td className="px-4 py-3 text-fg-muted capitalize">{pub.visibility}</td>
                    <td className="px-4 py-3 text-fg-muted">
                      <ConversationsCell publicationId={pub.id} />
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <IconBtn title="Share" onClick={() => setShareOf(pub)}>
                          <QrCodeIcon className="w-4 h-4" />
                        </IconBtn>
                        <IconBtn title="Copy public link" onClick={() => copyLink(pub.slug)}>
                          <CopyIcon className="w-4 h-4" />
                        </IconBtn>
                        <IconBtn
                          title="Open chat"
                          onClick={() => window.open(publicUrl(pub.slug), "_blank", "noreferrer")}
                        >
                          <ExternalLinkIcon className="w-4 h-4" />
                        </IconBtn>
                        <IconBtn title="Edit publication" onClick={() => setEditing(pub)}>
                          <PencilIcon className="w-4 h-4" />
                        </IconBtn>
                        {pub.status === "paused" ? (
                          <IconBtn
                            title="Resume"
                            disabled={busyId === pub.id}
                            onClick={() => setStatus(pub, "live")}
                          >
                            <PlayIcon className="w-4 h-4" />
                          </IconBtn>
                        ) : (
                          <IconBtn
                            title="Pause"
                            disabled={busyId === pub.id}
                            onClick={() => setStatus(pub, "paused")}
                          >
                            <PauseIcon className="w-4 h-4" />
                          </IconBtn>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {shareOf && (
        <ShareModal pub={shareOf} onClose={() => setShareOf(null)} />
      )}

      {editing && (
        <EditPublicationDialog
          open
          onClose={() => setEditing(null)}
          agentId={editing.agent_id}
          publication={editing}
          onUpdated={() => {
            void qc.invalidateQueries({ queryKey: ["/v1/publications"] });
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

/**
 * Per-row conversation count (issue #237). `GET /v1/publications` has no
 * cheap aggregate, so this fetches `GET /v1/publications/:id/users` lazily
 * per row (existing useApiQuery pattern) and sums each user's
 * `conversation_count`. Note: that endpoint caps at limit=100, so a bot
 * with more than 100 distinct chatters will undercount here — acceptable
 * for a dashboard glance; revisit if a real aggregate endpoint lands.
 */
function ConversationsCell({ publicationId }: { publicationId: string }) {
  const { data, isLoading, isError } = useApiQuery<{
    data: Array<{ conversation_count: number }>;
  }>(`/v1/publications/${publicationId}/users`, { limit: "100" });

  if (isLoading) return <Skeleton className="h-4 w-6" />;
  if (isError || !data) return <span className="text-fg-subtle">—</span>;
  const total = data.data.reduce((sum, u) => sum + (u.conversation_count || 0), 0);
  return <span>{total}</span>;
}

function IconBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      className="p-1.5 rounded-md text-fg-muted hover:text-fg hover:bg-bg-surface disabled:opacity-40 transition-colors"
    >
      {children}
    </button>
  );
}

function ShareModal({ pub, onClose }: { pub: Publication; onClose: () => void }) {
  const url = publicUrl(pub.slug);
  const embed = `<script src="${window.location.origin}/p/${pub.slug}/widget.js" async></script>`;
  const qrSvg = useMemo(
    () => qrMatrixToSvg(encodeQrToMatrix(url), { size: 176 }),
    [url],
  );

  const copy = (text: string, label: string) => {
    void navigator.clipboard.writeText(text).then(
      () => toast.success(`${label} copied`),
      () => toast.error("Could not copy"),
    );
  };

  return (
    <FormDialog open onClose={onClose} title={`Share ${pub.title}`} subtitle="Public link, QR code, and embed snippet">
      <div className="px-6 py-5 space-y-5">
        <div className="flex justify-center">
          <div
            className="rounded-lg border border-border p-2 bg-white"
            // Inline SVG is generated locally from the URL — no external request.
            dangerouslySetInnerHTML={{ __html: qrSvg }}
          />
        </div>

        <Field label="Public link">
          <div className="flex gap-2">
            <input
              readOnly
              value={url}
              className="flex-1 border border-border rounded-md px-3 py-2 text-sm bg-bg-surface text-fg font-mono"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button variant="outline" onClick={() => copy(url, "Link")}>
              Copy
            </Button>
          </div>
        </Field>

        <Field label="Embed on your website">
          <div className="flex gap-2">
            <textarea
              readOnly
              value={embed}
              rows={2}
              className="flex-1 border border-border rounded-md px-3 py-2 text-xs bg-bg-surface text-fg font-mono resize-none"
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button variant="outline" onClick={() => copy(embed, "Snippet")}>
              Copy
            </Button>
          </div>
          <p className="text-xs text-fg-subtle mt-1.5">
            Paste before <code>&lt;/body&gt;</code> to add a chat launcher to any page.
          </p>
        </Field>
      </div>
    </FormDialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-xs text-fg-muted block mb-1.5">{label}</label>
      {children}
    </div>
  );
}

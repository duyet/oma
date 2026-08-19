import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useApi, ApiError } from "../../lib/api";
import { FormDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectOption } from "@/components/ui/form-select";
import type { Publication } from "./publication-types";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Owning agent id — the edit PATCH is agent-scoped
   *  (/v1/agents/:id/publications/:pid); there's no bare /v1/publications/:id
   *  write route. */
  agentId: string;
  publication: Publication;
  /** Fired after a successful save so the caller can refresh its list. */
  onUpdated: (publication: Publication) => void;
}

const inputCls =
  "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

/** Mirrors PublishAgentDialog's slugify (and the server's urlSafeSlug) so
 *  the live preview matches exactly what a slug change will be stored as. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Edit dialog for an already-published bot (issue #237). Reuses
 * PublishAgentDialog's form pieces (slug/title/description/greeting/
 * visibility) but PATCHes the existing publication instead of creating a
 * new one. Pricing and environment aren't exposed here — pricing has its
 * own dedicated surface (PUT /v1/publications/:id/pricing) and environment
 * rarely changes post-publish; this dialog covers exactly the fields
 * issue #237 asked for, plus slug since PATCH already supports it.
 *
 * Reachable from both My Bots' pencil icon and the agent's Publishing tab.
 */
export function EditPublicationDialog({ open, onClose, agentId, publication, onUpdated }: Props) {
  const { api } = useApi();

  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [greeting, setGreeting] = useState("");
  const [visibility, setVisibility] = useState<Publication["visibility"]>("public");
  const [slugError, setSlugError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Re-hydrate from the publication every time the dialog (re)opens.
  useEffect(() => {
    if (!open) return;
    setSlug(publication.slug);
    setTitle(publication.title);
    setDescription(publication.description ?? "");
    setGreeting(publication.greeting ?? "");
    setVisibility(publication.visibility);
    setSlugError(null);
    setSaving(false);
  }, [open, publication]);

  const normalizedSlug = slugify(slug);
  const canSubmit = normalizedSlug.length > 0 && title.trim().length > 0;

  const save = async () => {
    if (!canSubmit) return;
    setSaving(true);
    setSlugError(null);
    try {
      const updated = await api<Publication>(
        `/v1/agents/${agentId}/publications/${publication.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            slug: normalizedSlug,
            title: title.trim(),
            description: description.trim() || null,
            greeting: greeting.trim() || null,
            visibility,
          }),
        },
      );
      toast.success("Publication updated");
      onUpdated(updated);
      onClose();
    } catch (err) {
      // A slug conflict (409) gets an inline field error, same as
      // PublishAgentDialog's create flow — every other failure is
      // toast-only (api() already toasted it).
      if (err instanceof ApiError && err.status === 409) {
        setSlugError(err.message);
      }
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={`Edit ${publication.title}`}
      subtitle="Update how this bot appears on its public chat page."
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!canSubmit || saving} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="edit-pub-slug" className="text-sm text-fg-muted block mb-1">
            Slug
          </label>
          <input
            id="edit-pub-slug"
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value);
              setSlugError(null);
            }}
            className={inputCls}
            placeholder="my-bot"
            autoComplete="off"
          />
          <p className="text-xs text-fg-subtle mt-1 font-mono">
            {window.location.origin}/p/{normalizedSlug || "…"}
          </p>
          {slugError && <p className="text-xs text-danger mt-1">{slugError}</p>}
        </div>

        <div>
          <label htmlFor="edit-pub-title" className="text-sm text-fg-muted block mb-1">
            Title
          </label>
          <input
            id="edit-pub-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={inputCls}
            placeholder="My Bot"
            autoComplete="off"
          />
        </div>

        <div>
          <label htmlFor="edit-pub-desc" className="text-sm text-fg-muted block mb-1">
            Description <span className="text-fg-subtle">(optional)</span>
          </label>
          <textarea
            id="edit-pub-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className={inputCls}
            placeholder="What does this bot help with?"
          />
        </div>

        <div>
          <label htmlFor="edit-pub-greeting" className="text-sm text-fg-muted block mb-1">
            Greeting <span className="text-fg-subtle">(optional)</span>
          </label>
          <input
            id="edit-pub-greeting"
            value={greeting}
            onChange={(e) => setGreeting(e.target.value)}
            className={inputCls}
            placeholder="Hi! Ask me anything about…"
          />
        </div>

        <div>
          <label className="text-sm text-fg-muted block mb-1">Visibility</label>
          <Select
            value={visibility}
            onValueChange={(v) => setVisibility(v as Publication["visibility"])}
          >
            <SelectOption value="public">Public — listed, reachable by anyone with the link</SelectOption>
            <SelectOption value="unlisted">Unlisted — reachable only by direct link</SelectOption>
            <SelectOption value="private">Private — not reachable yet</SelectOption>
          </Select>
        </div>
      </div>
    </FormDialog>
  );
}

import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useApi, ApiError } from "../../lib/api";
import { FormDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select, SelectOption } from "@/components/ui/form-select";
import { EnvironmentPicker } from "../../components/ResourcePicker";
import type { AgentRecord as Agent } from "../../types/agent";
import type { Publication, PricingMode } from "./publication-types";

interface Props {
  open: boolean;
  onClose: () => void;
  agent: Agent;
  /** Fired after a successful publish so the tab can refresh its list. */
  onPublished: (publication: Publication) => void;
}

const inputCls =
  "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

/** Mirrors the server's `urlSafeSlug` (packages/publications-store/src/
 *  service.ts) so the live preview matches exactly what the API will
 *  store — lowercased, non-url-safe runs collapsed to `-`, trimmed,
 *  capped at 64 chars. */
function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * "Publish as public bot" dialog (issue #179). Creates a `live`
 * publication via `POST /v1/agents/:id/publications` — clicking Publish
 * means live, not a `draft` limbo the public routes 404 on. When a paid
 * pricing mode is chosen, follows up with `PUT /v1/publications/:id/pricing`
 * (issue #163's write surface); `free` needs no call since that's already
 * the API's default for a publication with no pricing row.
 *
 * Form + Modal conventions mirror CreateDeploymentDialog.tsx.
 */
export function PublishAgentDialog({ open, onClose, agent, onPublished }: Props) {
  const { api } = useApi();

  const [slug, setSlug] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [greeting, setGreeting] = useState("");
  const [visibility, setVisibility] = useState<Publication["visibility"]>("public");
  const [environmentId, setEnvironmentId] = useState("");
  const [pricingMode, setPricingMode] = useState<PricingMode>("free");
  const [priceAmount, setPriceAmount] = useState("10");
  const [slugError, setSlugError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset + prefill from the agent every time the dialog (re)opens.
  useEffect(() => {
    if (!open) return;
    setSlug(slugify(agent.name));
    setTitle(agent.name);
    setDescription("");
    setGreeting("");
    setVisibility("public");
    setEnvironmentId("");
    setPricingMode("free");
    setPriceAmount("10");
    setSlugError(null);
    setSubmitting(false);
  }, [open, agent.name]);

  const normalizedSlug = slugify(slug);
  const canSubmit = normalizedSlug.length > 0 && title.trim().length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setSlugError(null);
    try {
      const created = await api<Publication>(`/v1/agents/${agent.id}/publications`, {
        method: "POST",
        body: JSON.stringify({
          slug: normalizedSlug,
          title: title.trim(),
          description: description.trim() || null,
          greeting: greeting.trim() || null,
          visibility,
          environment_id: environmentId || null,
          status: "live",
        }),
      });

      // Best-effort pricing follow-up — only for non-free modes. A fresh
      // publication has no pricing row yet and GET already defaults to
      // `free`, so there's nothing to write for that case.
      if (pricingMode !== "free") {
        try {
          await api(`/v1/publications/${created.id}/pricing`, {
            method: "PUT",
            body: JSON.stringify({
              mode: pricingMode,
              price_amount: Math.max(0, Math.round(Number(priceAmount)) || 0),
            }),
          });
        } catch {
          // api() already toasted the pricing-specific failure; the
          // publication itself still succeeded, so don't roll it back.
          toast.warning("Published, but pricing couldn't be saved — set it later from My Bots.");
        }
      }

      toast.success("Agent published");
      onPublished(created);
      onClose();
    } catch (err) {
      // A slug conflict (409) gets an inline field error in addition to
      // api()'s toast — every other failure is toast-only, same as
      // CreateDeploymentDialog.
      if (err instanceof ApiError && err.status === 409) {
        setSlugError(err.message);
      }
      setSubmitting(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Publish as public bot"
      subtitle="Creates a hosted chat page anyone with the link can use."
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit || submitting} loading={submitting}>
            Publish
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="pub-slug" className="text-sm text-fg-muted block mb-1">
            Slug
          </label>
          <input
            id="pub-slug"
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
          <label htmlFor="pub-title" className="text-sm text-fg-muted block mb-1">
            Title
          </label>
          <input
            id="pub-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className={inputCls}
            placeholder="My Bot"
            autoComplete="off"
          />
        </div>

        <div>
          <label htmlFor="pub-desc" className="text-sm text-fg-muted block mb-1">
            Description <span className="text-fg-subtle">(optional)</span>
          </label>
          <textarea
            id="pub-desc"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className={inputCls}
            placeholder="What does this bot help with?"
          />
        </div>

        <div>
          <label htmlFor="pub-greeting" className="text-sm text-fg-muted block mb-1">
            Greeting <span className="text-fg-subtle">(optional)</span>
          </label>
          <input
            id="pub-greeting"
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

        {/* Optional (issue #225) — a cloud agent published with no
            environment_id 409s on its first public message with a clear
            error rather than silently failing; local-runtime agents don't
            need one at all. */}
        <EnvironmentPicker
          value={environmentId}
          onChange={setEnvironmentId}
          optional
          placeholder="No environment — required for cloud agents to chat"
        />

        <div>
          <label className="text-sm text-fg-muted block mb-1">Pricing</label>
          <Select value={pricingMode} onValueChange={(v) => setPricingMode(v as PricingMode)}>
            <SelectOption value="free">Free</SelectOption>
            <SelectOption value="per_message">Per message</SelectOption>
            <SelectOption value="per_1k_tokens">Per 1,000 tokens</SelectOption>
          </Select>
          {pricingMode !== "free" && (
            <div className="mt-2">
              <label htmlFor="pub-price" className="text-xs text-fg-muted block mb-0.5">
                Credits {pricingMode === "per_message" ? "per message" : "per 1,000 tokens"}
              </label>
              <input
                id="pub-price"
                type="number"
                min={0}
                step={1}
                value={priceAmount}
                onChange={(e) => setPriceAmount(e.target.value)}
                className={`${inputCls} max-w-32`}
              />
            </div>
          )}
        </div>
      </div>
    </FormDialog>
  );
}

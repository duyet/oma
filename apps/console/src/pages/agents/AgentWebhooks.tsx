import { useState } from "react";
import { useApi } from "../../lib/api";
import { useQueryClient } from "../../lib/useApiQuery";
import { Field } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useConfirm } from "@/hooks/useConfirm";
import type { AgentRecord as Agent } from "../../types/agent";

type NotifyTarget = NonNullable<NonNullable<Agent["_oma"]>["notify"]>[number];

/** Wire shape for `agent.notify[].type === "webhook"` — mirrors
 *  `webhookTarget` in packages/api-types/src/notify-schema.ts. Other
 *  notify target types (github_comment / slack_message / matrix_message)
 *  are passed through untouched by this editor. Extends `NotifyTarget`
 *  (which carries an index signature to stay loose over all four target
 *  shapes) so a `NotifyTarget[]` narrows to `WebhookTarget[]` cleanly. */
interface WebhookTarget extends NotifyTarget {
  type: "webhook";
  url: string;
}

const ALL_EVENTS: Array<"idle" | "error" | "terminated"> = ["idle", "error", "terminated"];

const EMPTY_FORM = { url: "", secret_ref: "", events: [] as Array<"idle" | "error" | "terminated"> };

/**
 * Integrations → Webhooks editor, embedded on the agent detail page.
 * `notify` has no dedicated CRUD resource (see AGENTS.md "Notify
 * Targets") — it's just a field on the Agent config, so this edits it
 * by re-PUTting `_oma.notify` with the full target array (webhook
 * entries touched by this form, every other target type passed through
 * unchanged).
 *
 * Delivery status isn't tracked anywhere yet — `notify-dispatch.ts` is
 * fire-and-forget by design (never blocks the session), so there's no
 * delivery log to surface here.
 */
export function AgentWebhooks({ agent }: { agent: Agent }) {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const path = `/v1/agents/${agent.id}`;
  const notify: NotifyTarget[] = agent._oma?.notify ?? [];
  const webhooks = notify.filter((t): t is WebhookTarget => t.type === "webhook");

  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const confirm = useConfirm();

  const openAdd = () => {
    setForm({ ...EMPTY_FORM });
    setEditingIndex(webhooks.length);
    setError("");
  };
  const openEdit = (i: number) => {
    const t = webhooks[i];
    setForm({ url: t.url, secret_ref: t.secret_ref ?? "", events: t.events ?? [] });
    setEditingIndex(i);
    setError("");
  };
  const cancel = () => {
    setEditingIndex(null);
    setError("");
  };

  const toggleEvent = (ev: "idle" | "error" | "terminated") => {
    setForm((f) => ({
      ...f,
      events: f.events.includes(ev) ? f.events.filter((e) => e !== ev) : [...f.events, ev],
    }));
  };

  const saveNotify = async (nextWebhooks: WebhookTarget[]) => {
    const nextNotify = [...notify.filter((t) => t.type !== "webhook"), ...nextWebhooks];
    setSaving(true);
    try {
      await api(path, {
        method: "PUT",
        body: JSON.stringify({ _oma: { notify: nextNotify } }),
      });
      await queryClient.invalidateQueries({ queryKey: [path] });
    } finally {
      setSaving(false);
    }
  };

  const save = async () => {
    setError("");
    if (!form.url.trim()) {
      setError("URL is required");
      return;
    }
    try {
      new URL(form.url);
    } catch {
      setError("Must be a valid URL");
      return;
    }
    const target: WebhookTarget = {
      type: "webhook",
      url: form.url.trim(),
      ...(form.secret_ref.trim() ? { secret_ref: form.secret_ref.trim() } : {}),
      ...(form.events.length > 0 ? { events: form.events } : {}),
    };
    const next = [...webhooks];
    if (editingIndex !== null && editingIndex < webhooks.length) {
      next[editingIndex] = target;
    } else {
      next.push(target);
    }
    try {
      await saveNotify(next);
      setEditingIndex(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save webhook");
    }
  };

  const remove = async (i: number) => {
    if (
      !(await confirm({
        title: "Remove this webhook target?",
        confirmLabel: "Remove",
        destructive: true,
      }))
    )
      return;
    await saveNotify(webhooks.filter((_, j) => j !== i));
  };

  return (
    <div className="mt-8 max-w-2xl">
      <div className="flex items-center justify-between mb-2">
        <h2 className="font-display text-base font-semibold">Webhooks</h2>
        {editingIndex === null && (
          <Button variant="outline" size="sm" onClick={openAdd}>
            + Add Webhook
          </Button>
        )}
      </div>
      <p className="text-xs text-fg-subtle mb-3">
        Signed HTTP POSTs sent to your URL when this agent's sessions go idle, error, or
        terminate. See <span className="font-mono">AGENTS.md</span> "Notify Targets" for the
        envelope shape and HMAC verification. Delivery is fire-and-forget — failed deliveries
        are logged server-side but not tracked here yet.
      </p>

      {webhooks.length === 0 && editingIndex === null && (
        <div className="border border-border rounded-lg bg-bg-surface/30 px-4 py-6 text-center text-sm text-fg-subtle">
          No webhook targets configured.
        </div>
      )}

      {webhooks.length > 0 && (
        <div className="border border-border rounded-lg divide-y divide-border">
          {webhooks.map((t, i) => (
            <div key={i} className="px-4 py-3 flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-mono truncate">{t.url}</div>
                <div className="mt-1 flex flex-wrap gap-1.5 items-center text-xs text-fg-subtle">
                  <span>{(t.events && t.events.length > 0 ? t.events : ALL_EVENTS).join(", ")}</span>
                  {t.secret_ref ? (
                    <span className="px-1.5 py-0.5 rounded bg-success-subtle text-success">
                      signed
                    </span>
                  ) : (
                    <span className="px-1.5 py-0.5 rounded bg-warning-subtle text-warning">
                      unsigned
                    </span>
                  )}
                </div>
              </div>
              <div className="flex gap-2 shrink-0">
                <Button variant="ghost" size="sm" onClick={() => openEdit(i)}>
                  Edit
                </Button>
                <Button variant="ghost" size="sm" onClick={() => remove(i)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editingIndex !== null && (
        <div className="mt-3 border border-border rounded-lg p-4 space-y-3">
          {error && (
            <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
              {error}
            </div>
          )}
          <Field label="URL" hint="Destination endpoint. Must be publicly reachable from this deployment.">
            <Input
              value={form.url}
              onChange={(e) => setForm({ ...form, url: e.target.value })}
              placeholder="https://hooks.example.com/agent"
            />
          </Field>
          <Field
            label="Secret credential (optional)"
            hint="A vault credential id whose token is used as the HMAC-SHA256 signing secret. Leave blank to send unsigned."
          >
            <Input
              value={form.secret_ref}
              onChange={(e) => setForm({ ...form, secret_ref: e.target.value })}
              placeholder="cred_xxx"
            />
          </Field>
          <div>
            <span className="block text-[13px] font-medium text-fg mb-1.5">
              Events <span className="text-fg-subtle font-normal">(none selected = all)</span>
            </span>
            <div className="flex gap-4">
              {ALL_EVENTS.map((ev) => (
                <label key={ev} className="flex items-center gap-1.5 text-sm cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.events.includes(ev)}
                    onChange={() => toggleEvent(ev)}
                    className="accent-brand"
                  />
                  {ev}
                </label>
              ))}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" size="sm" onClick={cancel} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={save} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

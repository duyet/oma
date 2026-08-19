import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useApi, ApiError } from "../../lib/api";
import { FormDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

/**
 * Session-scoped model + reasoning-effort switcher, opened from the prompt
 * input toolbar.
 *
 * Backed by `PATCH /v1/sessions/:id/runtime`, which writes the session's
 * own override slots — the same ones the create-time `model` /
 * `reasoning_effort` body fields seed. Deliberately session-scoped: the
 * agent record is shared by every other session, so switching models for
 * "this conversation" must never write back to it.
 *
 * Two failure modes are surfaced explicitly rather than swallowed:
 *   • 409 — a turn is in flight. Swapping providers mid-turn would split
 *     one turn across two models, so the server refuses.
 *   • 501 — the self-host Node runtime has no per-session state store for
 *     overrides yet, so it cannot honour a switch.
 */

/** OpenAI/Codex convention, passed through verbatim to whatever the agent
 *  advertises. There is no OMA-canonical effort set — see AGENTS.md on
 *  `session/set_config_option`, where an unsupported value is a silent
 *  no-op rather than an error. */
const REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const;

interface ModelCard {
  id: string;
  name?: string;
  model_id?: string;
  provider?: string;
}

export function RuntimeSettingsDialog({
  open,
  onClose,
  sessionId,
  currentModel,
  currentEffort,
  sessionRunning,
  onApplied,
}: {
  open: boolean;
  onClose: () => void;
  sessionId: string;
  /** Model the session is actually running — the override if one is set,
   *  otherwise the agent's configured model. Used as the field's initial
   *  value so "save without editing" is a no-op rather than a surprise. */
  currentModel?: string;
  currentEffort?: string;
  sessionRunning: boolean;
  onApplied: (next: { model?: string; reasoningEffort?: string }) => void;
}) {
  const { api } = useApi();
  const [model, setModel] = useState(currentModel ?? "");
  const [effort, setEffort] = useState(currentEffort ?? "");
  const [cards, setCards] = useState<ModelCard[]>([]);
  const [saving, setSaving] = useState(false);

  // Re-seed on open so a dialog reopened after an external change (or a
  // first model call landing) shows the live value, not a stale one.
  useEffect(() => {
    if (!open) return;
    setModel(currentModel ?? "");
    setEffort(currentEffort ?? "");
  }, [open, currentModel, currentEffort]);

  useEffect(() => {
    if (!open) return;
    api<{ data?: ModelCard[] }>("/v1/model_cards")
      .then((d) => setCards(d.data ?? []))
      // Model cards are suggestions only — the field accepts any model
      // handle, so a failed list must not block the dialog.
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = async () => {
    setSaving(true);
    try {
      await api(`/v1/sessions/${sessionId}/runtime`, {
        method: "PATCH",
        body: JSON.stringify({
          // Empty string means "clear the override and fall back to the
          // agent's own model" — distinct from omitting the key.
          model: model.trim() === "" ? null : model.trim(),
          reasoning_effort: effort === "" ? null : effort,
        }),
      });
      onApplied({
        model: model.trim() === "" ? undefined : model.trim(),
        reasoningEffort: effort === "" ? undefined : effort,
      });
      toast.success("Applied from the next turn");
      onClose();
    } catch (e) {
      const status = e instanceof ApiError ? e.status : undefined;
      toast.error(
        status === 409
          ? "Wait for the current turn to finish, then switch."
          : status === 501
            ? "This deployment can't change the model mid-session."
            : e instanceof Error
              ? e.message
              : "Failed to update",
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title="Session model"
      subtitle="Applies to this session only, starting with the next turn. The agent's own configuration is untouched."
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={saving || sessionRunning}>
            {saving ? "Applying…" : "Apply"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {sessionRunning && (
          <p className="text-xs text-warning">
            A turn is in flight. Stop it or wait for it to finish — switching mid-turn would
            split one turn across two models.
          </p>
        )}

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-fg-muted">Model</span>
          <input
            value={model}
            onChange={(e) => setModel(e.currentTarget.value)}
            list="oma-session-model-options"
            placeholder="claude-sonnet-4-6 — leave empty to use the agent's model"
            className="w-full rounded-md bg-bg-surface px-3 py-2 text-sm font-mono text-fg placeholder:text-fg-subtle"
          />
          <datalist id="oma-session-model-options">
            {cards.map((c) => (
              <option key={c.id} value={c.model_id ?? c.id}>
                {c.name ?? c.provider ?? c.id}
              </option>
            ))}
          </datalist>
          <span className="block text-[11px] text-fg-subtle">
            Any model handle your deployment can resolve — a model-card id, or a provider
            model id like <code className="font-mono">anthropic/claude-sonnet-4-6</code>.
          </span>
        </label>

        <label className="block space-y-1.5">
          <span className="text-xs font-medium text-fg-muted">Reasoning effort</span>
          <select
            value={effort}
            onChange={(e) => setEffort(e.currentTarget.value)}
            className="w-full rounded-md bg-bg-surface px-3 py-2 text-sm text-fg"
          >
            <option value="">default (agent's setting)</option>
            {REASONING_EFFORTS.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <span className="block text-[11px] text-fg-subtle">
            Passed through verbatim. Agents that don't advertise a matching option ignore it
            silently and keep their own default.
          </span>
        </label>
      </div>
    </FormDialog>
  );
}

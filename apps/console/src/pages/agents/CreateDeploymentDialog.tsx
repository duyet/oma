import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useApi } from "../../lib/api";
import { Modal } from "../../components/Modal";
import { Button } from "@/components/ui/button";
import { Select, SelectOption } from "../../components/Select";
import {
  EnvironmentPicker,
  MemoryStoresPicker,
  VaultsPicker,
} from "../../components/ResourcePicker";
import type { AgentRecord as Agent } from "../../types/agent";
import type { Deployment, TriggerType } from "./deployment-types";
import { CronPresetPicker } from "./CronPresetPicker";
import { DEFAULT_CRON_VALUE, buildCron, type CronPresetValue } from "./cron-presets";

interface Props {
  open: boolean;
  onClose: () => void;
  agent: Agent;
  versions: Agent[];
  /** Fired after a successful create so the list can refresh. */
  onCreated: (deployment: Deployment) => void;
}

const inputCls =
  "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

/**
 * Create Deployment modal (matches the official Claude Console). Agent is
 * fixed to the hub's agent; a version can be pinned (default: always
 * latest). Trigger toggles between Manual (info box), Schedule (cron +
 * timezone), and Webhook (URL surfaced after creation).
 */
export function CreateDeploymentDialog({ open, onClose, agent, versions, onCreated }: Props) {
  const { api } = useApi();

  const [name, setName] = useState("");
  const [version, setVersion] = useState("latest"); // "latest" | version number
  const [message, setMessage] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [vaultIds, setVaultIds] = useState<string[]>([]);
  const [memoryStoreIds, setMemoryStoreIds] = useState<string[]>([]);
  const [trigger, setTrigger] = useState<TriggerType>("manual");
  const [cron, setCron] = useState<CronPresetValue>(DEFAULT_CRON_VALUE);
  const [timezone, setTimezone] = useState("UTC");
  const [submitting, setSubmitting] = useState(false);
  // Set on a successful webhook-trigger create so we can show the URL.
  const [createdWebhookUrl, setCreatedWebhookUrl] = useState<string | null>(null);

  // Reset everything when the modal (re)opens.
  useEffect(() => {
    if (!open) return;
    setName("");
    setVersion("latest");
    setMessage("");
    setEnvironmentId("");
    setVaultIds([]);
    setMemoryStoreIds([]);
    setTrigger("manual");
    setCron(DEFAULT_CRON_VALUE);
    setTimezone("UTC");
    setSubmitting(false);
    setCreatedWebhookUrl(null);
  }, [open]);

  const orderedVersions = [...versions].sort((a, b) => b.version - a.version);

  const cronExpression = buildCron(cron);

  const canSubmit =
    name.trim().length > 0 &&
    message.trim().length > 0 &&
    environmentId.length > 0 &&
    (trigger !== "schedule" || cronExpression.trim().length > 0);

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const triggerBody =
        trigger === "schedule"
          ? {
              type: "schedule",
              cron_expression: cronExpression.trim(),
              timezone: timezone.trim() || "UTC",
            }
          : { type: trigger };
      const body: Record<string, unknown> = {
        name: name.trim(),
        agent_id: agent.id,
        agent_version: version === "latest" ? null : Number(version),
        initial_message: message.trim(),
        environment_id: environmentId,
        vault_ids: vaultIds,
        memory_store_ids: memoryStoreIds,
        trigger: triggerBody,
      };
      const created = await api<Deployment>("/v1/deployments", {
        method: "POST",
        body: JSON.stringify(body),
      });
      onCreated(created);
      if (created.trigger?.type === "webhook" && created.webhook_url) {
        // Keep the modal open so the user can copy the webhook URL.
        setCreatedWebhookUrl(created.webhook_url);
        setSubmitting(false);
      } else {
        toast.success("Deployment created");
        onClose();
      }
    } catch {
      // api() already toasts the error.
      setSubmitting(false);
    }
  };

  const copyWebhook = async () => {
    if (!createdWebhookUrl) return;
    try {
      await navigator.clipboard.writeText(createdWebhookUrl);
      toast.success("Webhook URL copied");
    } catch {
      toast.error("Copy failed — select and copy manually");
    }
  };

  // Post-create webhook view — surface the URL, then Done.
  if (createdWebhookUrl) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title="Deployment created"
        subtitle="Trigger runs by POSTing to this webhook URL."
        maxWidth="max-w-xl"
        footer={
          <Button onClick={onClose}>Done</Button>
        }
      >
        <div className="space-y-2">
          <label className="text-sm text-fg-muted">Webhook URL</label>
          <div className="flex items-center gap-2">
            <input readOnly value={createdWebhookUrl} className={`${inputCls} font-mono text-xs`} />
            <Button variant="outline" size="sm" onClick={copyWebhook}>
              Copy
            </Button>
          </div>
          <p className="text-xs text-fg-subtle">
            This URL is unauthenticated but token-secured — treat it like a secret. An optional JSON
            body <code className="font-mono">{`{ "message": "…" }`}</code> overrides the initial
            message.
          </p>
        </div>
      </Modal>
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Create deployment"
      subtitle="Bind this agent to an environment and a trigger so it can run repeatedly."
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit || submitting} loading={submitting}>
            Create deployment
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <label htmlFor="dep-name" className="text-sm text-fg-muted block mb-1">
            Name
          </label>
          <input
            id="dep-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className={inputCls}
            placeholder="Nightly inbox triage"
            autoComplete="off"
          />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="text-sm text-fg-muted">Agent</label>
            <a href={`/agents/${agent.id}`} className="text-xs text-brand hover:underline">
              View agent ↗
            </a>
          </div>
          <div className="flex items-center gap-2 border border-border rounded-md bg-bg-surface px-3 py-2 text-sm">
            <span className="text-fg">{agent.name}</span>
            <span className="text-fg-subtle font-mono text-xs">{agent.id}</span>
          </div>
        </div>

        <div>
          <label className="text-sm text-fg-muted block mb-1">Version</label>
          <Select value={version} onValueChange={setVersion} placeholder="Select version...">
            <SelectOption value="latest">v{agent.version} · latest</SelectOption>
            {orderedVersions
              .filter((v) => v.version !== agent.version)
              .map((v) => (
                <SelectOption key={v.version} value={String(v.version)}>
                  v{v.version}
                </SelectOption>
              ))}
          </Select>
        </div>

        <div>
          <label htmlFor="dep-message" className="text-sm text-fg-muted block mb-1">
            Initial message
          </label>
          <textarea
            id="dep-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            className={inputCls}
            placeholder="Summarize today's support tickets and post to #digest"
          />
          <p className="text-xs text-fg-subtle mt-1">Sent to the agent at the start of every run.</p>
        </div>

        <EnvironmentPicker value={environmentId} onChange={setEnvironmentId} />

        <VaultsPicker value={vaultIds} onChange={setVaultIds} />

        <MemoryStoresPicker value={memoryStoreIds} onChange={setMemoryStoreIds} />

        <div>
          <label className="text-sm text-fg-muted block mb-1">Trigger</label>
          <Select
            value={trigger}
            onValueChange={(v) => setTrigger(v as TriggerType)}
            placeholder="Select trigger..."
          >
            <SelectOption value="manual">✋ Manual</SelectOption>
            <SelectOption value="schedule">🗓 Schedule</SelectOption>
            <SelectOption value="webhook">🔗 Webhook</SelectOption>
          </Select>

          {trigger === "manual" && (
            <p className="mt-2 text-xs text-fg-muted bg-bg-surface border border-border rounded-md px-3 py-2">
              Trigger runs from this Console with the Run now button, or via the API with{" "}
              <code className="font-mono">POST /v1/deployments/:id/run</code>.
            </p>
          )}

          {trigger === "schedule" && (
            <div className="mt-2 grid grid-cols-2 gap-2 items-start">
              <CronPresetPicker
                value={cron}
                onChange={setCron}
                timezone={timezone.trim() || "UTC"}
                idPrefix="dep"
                compact
              />
              <div>
                <label htmlFor="dep-tz" className="text-xs text-fg-muted block mb-0.5">
                  Timezone
                </label>
                <input
                  id="dep-tz"
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className={inputCls}
                  placeholder="UTC"
                />
              </div>
            </div>
          )}

          {trigger === "webhook" && (
            <p className="mt-2 text-xs text-fg-muted bg-bg-surface border border-border rounded-md px-3 py-2">
              A webhook URL will be generated after you create the deployment.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

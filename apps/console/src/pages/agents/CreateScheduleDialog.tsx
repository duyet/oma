import { useEffect, useState } from "react";
import { toast } from "sonner";

import { useApi } from "../../lib/api";
import { Modal } from "../../components/Modal";
import { Button } from "@/components/ui/button";
import { EnvironmentPicker } from "../../components/ResourcePicker";
import type { AgentRecord as Agent } from "../../types/agent";
import type { AgentSchedule } from "./schedule-types";
import { CronPresetPicker } from "./CronPresetPicker";
import { DEFAULT_CRON_VALUE, buildCron, matchCron, type CronPresetValue } from "./cron-presets";

interface Props {
  open: boolean;
  onClose: () => void;
  agent: Agent;
  /** When set, the dialog opens in edit mode: fields prefill from this
   *  schedule and submit goes out as a PATCH instead of a POST. */
  schedule?: AgentSchedule | null;
  /** Fired after a successful create/update so the list can refresh. */
  onCreated: (schedule: AgentSchedule) => void;
}

const inputCls =
  "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle";

/**
 * Create/Edit Schedule modal — mirrors CreateDeploymentDialog's shape but
 * scoped to the simpler agent-schedule contract (cron + timezone +
 * environment + input, no vaults/memory/version pinning — see AGENTS.md
 * "Agent Schedules"). Edit mode is driven by the optional `schedule` prop:
 * when set, fields prefill from it and submit PATCHes
 * `/v1/agents/:agentId/schedules/:scheduleId` (widened in WP1 to accept
 * any of enabled/cron_expression/input/environment_id/timezone/
 * max_sessions) instead of POSTing a new row.
 */
export function CreateScheduleDialog({ open, onClose, agent, schedule, onCreated }: Props) {
  const { api } = useApi();
  const isEdit = !!schedule;

  const [cron, setCron] = useState<CronPresetValue>(DEFAULT_CRON_VALUE);
  const [timezone, setTimezone] = useState("UTC");
  const [environmentId, setEnvironmentId] = useState("");
  const [input, setInput] = useState("");
  const [maxSessions, setMaxSessions] = useState("1");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) return;
    if (schedule) {
      // Reopen on the preset it was created from; anything hand-written
      // falls back to Custom with the expression intact.
      setCron(matchCron(schedule.cron_expression));
      setTimezone(schedule.timezone || "UTC");
      setEnvironmentId(schedule.environment_id);
      setInput(schedule.input);
      setMaxSessions(String(schedule.max_sessions ?? 1));
    } else {
      setCron(DEFAULT_CRON_VALUE);
      setTimezone("UTC");
      setEnvironmentId("");
      setInput("");
      setMaxSessions("1");
    }
    setSubmitting(false);
  }, [open, schedule]);

  const cronExpression = buildCron(cron);
  const canSubmit =
    cronExpression.trim().length > 0 &&
    environmentId.length > 0 &&
    input.trim().length > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        cron_expression: cronExpression.trim(),
        timezone: timezone.trim() || "UTC",
        environment_id: environmentId,
        input: input.trim(),
        max_sessions: Number(maxSessions) || 1,
      };
      const result =
        isEdit && schedule
          ? await api<AgentSchedule>(`/v1/agents/${agent.id}/schedules/${schedule.id}`, {
              method: "PATCH",
              body: JSON.stringify(body),
            })
          : await api<AgentSchedule>(`/v1/agents/${agent.id}/schedules`, {
              method: "POST",
              body: JSON.stringify(body),
            });
      onCreated(result);
      toast.success(isEdit ? "Schedule updated" : "Schedule created");
      onClose();
    } catch {
      // api() already toasts the error.
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isEdit ? "Edit schedule" : "Create schedule"}
      subtitle={
        isEdit
          ? "Update this schedule's cron cadence, environment, or input."
          : "Fire this agent as a fresh session on a cron cadence — no human turn required."
      }
      maxWidth="max-w-xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit || submitting} loading={submitting}>
            {isEdit ? "Save changes" : "Create schedule"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2 items-start">
          <CronPresetPicker
            value={cron}
            onChange={setCron}
            timezone={timezone.trim() || "UTC"}
            idPrefix="sch"
          />
          <div>
            <label htmlFor="sch-tz" className="text-sm text-fg-muted block mb-1">
              Timezone
            </label>
            <input
              id="sch-tz"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className={inputCls}
              placeholder="UTC"
            />
          </div>
        </div>

        <EnvironmentPicker value={environmentId} onChange={setEnvironmentId} />

        <div>
          <label htmlFor="sch-input" className="text-sm text-fg-muted block mb-1">
            Input
          </label>
          <textarea
            id="sch-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            rows={3}
            className={inputCls}
            placeholder="Post the weekly metrics digest to #general."
          />
          <p className="text-xs text-fg-subtle mt-1">
            Injected as the opening user message on every firing.
          </p>
        </div>

        <div>
          <label htmlFor="sch-max" className="text-sm text-fg-muted block mb-1">
            Max concurrent sessions
          </label>
          <input
            id="sch-max"
            type="number"
            min={1}
            max={100}
            value={maxSessions}
            onChange={(e) => setMaxSessions(e.target.value)}
            className={inputCls}
          />
        </div>
      </div>
    </Modal>
  );
}

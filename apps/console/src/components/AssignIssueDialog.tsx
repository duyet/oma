import { useEffect, useState } from "react";

import { useApi, ApiError } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import { useDefaultEnvironment } from "../lib/useDefaultEnvironment";
import type { AgentRecord } from "../types/agent";
import type { GitHubIssue } from "../integrations/api/types";
import { FormDialog } from "@/components/ui/dialog";
import { Select, SelectOption } from "@/components/ui/form-select";
import { EnvironmentPicker } from "./ResourcePicker";
import { Button } from "@/components/ui/button";

interface Props {
  open: boolean;
  onClose: () => void;
  issue: GitHubIssue | null;
  /** `owner/repo` the issue belongs to — included in the agent's brief. */
  repo: string;
  /** Called with the created session id so the caller can navigate. */
  onCreated: (sessionId: string) => void;
}

/** True when the agent is bound to a local ACP runtime and therefore doesn't
 *  need an environment_id (mirrors AgentsList / NewSessionDialog detection). */
function isLocalRuntimeAgent(a: AgentRecord | undefined): boolean {
  if (!a) return false;
  return !!(a.runtime_binding || a._oma?.runtime_binding);
}

/** Compose the opening user.message that briefs the agent on the issue. */
function buildIssueBrief(issue: GitHubIssue, repo: string): string {
  const labels = issue.labels.map((l) => l.name).filter(Boolean).join(", ");
  const lines = [
    `Work on this GitHub issue from ${repo}:`,
    "",
    `Title: ${issue.title}`,
    `Issue: #${issue.number}`,
    `URL: ${issue.html_url}`,
    `State: ${issue.state}`,
  ];
  if (labels) lines.push(`Labels: ${labels}`);
  if (issue.assignee?.login) lines.push(`Assignee: ${issue.assignee.login}`);
  lines.push("", "--- Issue description ---", issue.body?.trim() || "(no description provided)");
  lines.push(
    "",
    "Investigate the issue, then implement and verify a fix. Summarize the root cause and the change you made when done.",
  );
  return lines.join("\n");
}

/**
 * "Assign to agent" dialog for a GitHub issue card. Picks one of the
 * tenant's agents, resolves the run environment (same three-way UX as
 * NewSessionDialog — silent single env / picker / no-env CTA), creates a
 * session, and seeds it with a brief describing the issue.
 */
export function AssignIssueDialog({ open, onClose, issue, repo, onCreated }: Props) {
  const { api } = useApi();
  const { data: agentsRes } = useApiQuery<{ data: AgentRecord[] }>(
    "/v1/agents",
    { limit: "200" },
    { enabled: open },
  );
  const agents = agentsRes?.data ?? [];

  const {
    environments,
    singleEnvironmentId,
    hasNoEnvironments,
  } = useDefaultEnvironment();

  const [agentId, setAgentId] = useState("");
  const [environmentId, setEnvironmentId] = useState("");
  const [creating, setCreating] = useState(false);

  // Reset selection each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setAgentId("");
    setEnvironmentId(singleEnvironmentId ?? "");
    setCreating(false);
  }, [open, singleEnvironmentId]);

  const selectedAgent = agents.find((a) => a.id === agentId);
  const isLocalRuntime = isLocalRuntimeAgent(selectedAgent);
  const needsEnvironment = !isLocalRuntime && environments.length > 1;
  const blockedNoEnv = !isLocalRuntime && hasNoEnvironments;
  const canSubmit =
    !!agentId && !!issue && (isLocalRuntime || (!blockedNoEnv && !!environmentId));

  const submit = async () => {
    if (!canSubmit || !issue) return;
    setCreating(true);
    try {
      const body: Record<string, unknown> = { agent: agentId };
      if (!isLocalRuntime && environmentId) body.environment_id = environmentId;
      const session = await api<{ id: string }>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify(body),
      });

      // Best-effort seed: the session exists regardless, so a failure here
      // still lets the user brief the agent from the session page.
      await api(`/v1/sessions/${session.id}/events`, {
        method: "POST",
        body: JSON.stringify({
          events: [
            {
              type: "user.message",
              content: [{ type: "text", text: buildIssueBrief(issue, repo) }],
            },
          ],
        }),
      }).catch(() => {});

      onCreated(session.id);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // api() already toasted — leave the dialog open so the user can retry.
    } finally {
      setCreating(false);
    }
  };

  return (
    <FormDialog
      open={open}
      onClose={onClose}
      title={issue ? `Assign issue #${issue.number} to an agent` : "Assign issue"}
      maxWidth="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit || creating}>
            {creating ? "Creating…" : "Create session"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {issue && (
          <div className="rounded-lg border border-border bg-bg-surface/50 px-3 py-2">
            <div className="text-sm font-medium text-fg truncate">{issue.title}</div>
            <div className="mt-0.5 text-xs text-fg-subtle font-mono truncate">
              {repo} · #{issue.number}
            </div>
          </div>
        )}

        <div>
          <label className="text-sm text-fg-muted block mb-1">Agent</label>
          <Select
            value={agentId}
            onValueChange={setAgentId}
            placeholder="Select an agent…"
          >
            {agents.map((a) => (
              <SelectOption key={a.id} value={a.id}>
                {a.name}
              </SelectOption>
            ))}
          </Select>
        </div>

        {needsEnvironment && (
          <EnvironmentPicker value={environmentId} onChange={setEnvironmentId} />
        )}
        {blockedNoEnv && (
          <div className="rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm text-fg-muted">
            This agent needs an environment to run sessions, and your tenant has none yet.{" "}
            <a href="/environments" className="text-brand hover:underline">
              Create an environment
            </a>{" "}
            to continue.
          </div>
        )}
      </div>
    </FormDialog>
  );
}

import { useEffect, useState } from "react";

import { useApi, ApiError } from "../lib/api";
import { useDefaultEnvironment } from "../lib/useDefaultEnvironment";
import { Modal } from "./Modal";
import { Button } from "@/components/ui/button";
import { EnvironmentPicker } from "./ResourcePicker";
import { preferredEnvironmentId } from "../pages/agents/browser-env";

interface Props {
  open: boolean;
  onClose: () => void;
  agentId: string;
  /** Skips the environment step entirely — local-runtime agents don't run
   *  a sandbox container so there's nothing to pick. */
  isLocalRuntime: boolean;
  /** The agent's own `metadata`. When it names a default environment (what
   *  the form's Browser mode writes), that wins over the tenant-wide
   *  single-environment shortcut. */
  agentMetadata?: Record<string, unknown>;
  /** Called with the new session's id once created (+ initial message
   *  sent, if any) so the caller can navigate to it. */
  onCreated: (sessionId: string) => void;
}

const textareaCls =
  "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle resize-none";

/**
 * "New session" dialog for the agent hub header — replaces the old
 * blind-create button. Cloud agents need an environment_id (server-enforced
 * — packages/http-routes/src/sessions/index.ts); this reuses the same
 * useDefaultEnvironment resolution AgentChat.tsx uses: a single tenant
 * environment is preselected, several show the picker below, and none
 * shows a CTA to /environments instead of letting the create call 400.
 */
export function NewSessionDialog({
  open,
  onClose,
  agentId,
  isLocalRuntime,
  agentMetadata,
  onCreated,
}: Props) {
  const { api } = useApi();
  const { environments, isLoading: envsLoading, singleEnvironmentId, hasNoEnvironments } =
    useDefaultEnvironment();

  const [environmentId, setEnvironmentId] = useState("");
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);

  // Reset + preselect the default environment every time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setEnvironmentId(preferredEnvironmentId(agentMetadata, singleEnvironmentId));
    setMessage("");
    setCreating(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, singleEnvironmentId]);

  const needsEnvironment = !isLocalRuntime && !hasNoEnvironments;
  // Agent default (metadata.default_environment_id) lets the server resolve
  // the env when the picker is empty — docs/sandbox-runtime-selection.md.
  const agentDefaultEnv = preferredEnvironmentId(agentMetadata, null);
  const canSubmit = isLocalRuntime || !!environmentId || !!agentDefaultEnv;

  const submit = async () => {
    if (!canSubmit) return;
    setCreating(true);
    try {
      const body: Record<string, unknown> = { agent: agentId };
      // Prefer explicit picker value; otherwise omit and let the API use
      // agent.metadata.default_environment_id (server-side resolution).
      if (!isLocalRuntime && environmentId) body.environment_id = environmentId;
      const session = await api<{ id: string }>("/v1/sessions", {
        method: "POST",
        body: JSON.stringify(body),
      });

      if (message.trim()) {
        // Best-effort: the session exists either way, so a failure here
        // still lets the user send the message from the session page.
        await api(`/v1/sessions/${session.id}/events`, {
          method: "POST",
          body: JSON.stringify({
            events: [{ type: "user.message", content: [{ type: "text", text: message.trim() }] }],
          }),
        }).catch(() => {});
      }

      onCreated(session.id);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // api() already toasted — leave the dialog open so the user can adjust.
    } finally {
      setCreating(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New session"
      maxWidth="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!canSubmit || creating || envsLoading}>
            {creating ? "Creating…" : "Create session"}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {needsEnvironment && (
          <div className="space-y-1.5">
            <EnvironmentPicker value={environmentId} onChange={setEnvironmentId} />
            <p className="text-[11px] text-fg-subtle leading-relaxed">
              Where tools run is chosen when the session starts. Change the agent&rsquo;s
              default sandbox for next time, or pick another environment here.
              {agentDefaultEnv && !environmentId ? (
                <>
                  {" "}
                  Using agent default{" "}
                  <code className="font-mono text-[10px]">{agentDefaultEnv}</code>.
                </>
              ) : null}
            </p>
          </div>
        )}
        {!isLocalRuntime && hasNoEnvironments && (
          <div className="rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm text-fg-muted">
            This agent needs an environment to run sessions, and your tenant has none yet.{" "}
            <a href="/environments" className="text-brand hover:underline">
              Create an environment
            </a>{" "}
            to continue.
          </div>
        )}
        <div>
          <label htmlFor="new-session-message" className="text-sm text-fg-muted block mb-1">
            Initial message <span className="text-fg-subtle">(optional)</span>
          </label>
          <textarea
            id="new-session-message"
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={3}
            className={textareaCls}
            placeholder="What should this session do?"
          />
        </div>
      </div>
    </Modal>
  );
}

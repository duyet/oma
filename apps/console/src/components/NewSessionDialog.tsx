import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { useApi, ApiError } from "../lib/api";
import { useDefaultEnvironment } from "../lib/useDefaultEnvironment";
import { useQueryClient } from "../lib/useApiQuery";
import { Modal } from "./Modal";
import { Button } from "@/components/ui/button";
import { EnvironmentPicker, VaultsPicker } from "./ResourcePicker";
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
  /** Pre-fetched MCP server URLs for this agent (optional). When omitted
   *  the dialog loads `/v1/agents/:id` once opened to drive the vault
   *  credential-match warning. */
  agentMcpUrls?: string[];
  /** Called with the new session's id once created (+ initial message
   *  sent, if any) so the caller can navigate to it. */
  onCreated: (sessionId: string) => void;
}

const textareaCls =
  "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors placeholder:text-fg-subtle resize-none";

/** Sensible Cloudflare sandbox default — `type: "cloud"` is the hosted
 *  Console's environment create default and resolves to CloudflareSandbox
 *  when `sandbox_provider` is unset. One-click from the New session modal
 *  so first-run does not dump the user on /environments (#398). */
export const DEFAULT_CLOUD_ENVIRONMENT = {
  name: "Default",
  description: "Cloudflare sandbox (default).",
  config: { type: "cloud" as const },
};

/**
 * "New session" dialog for the agent hub header (and any fixed-agent host).
 * Cloud agents need an environment_id (server-enforced); this reuses the same
 * useDefaultEnvironment resolution as elsewhere. Also attaches credential
 * vaults (same as Sessions list create) so MCP hosts can authenticate via the
 * outbound proxy — the agent hub path used to omit vaults and leave operators
 * with mid-turn 401s.
 */
export function NewSessionDialog({
  open,
  onClose,
  agentId,
  isLocalRuntime,
  agentMetadata,
  agentMcpUrls: agentMcpUrlsProp,
  onCreated,
}: Props) {
  const { api } = useApi();
  const queryClient = useQueryClient();
  const { isLoading: envsLoading, singleEnvironmentId, hasNoEnvironments } =
    useDefaultEnvironment();

  const [environmentId, setEnvironmentId] = useState("");
  const [vaultIds, setVaultIds] = useState<string[]>([]);
  const [message, setMessage] = useState("");
  const [creating, setCreating] = useState(false);
  const [creatingEnv, setCreatingEnv] = useState(false);
  /** Stays true after an inline default-env create so we hide the empty
   *  CTA and keep the picker in this modal without waiting on refetch. */
  const [inlineEnvCreated, setInlineEnvCreated] = useState(false);
  const [mcpUrls, setMcpUrls] = useState<string[]>(agentMcpUrlsProp ?? []);
  const [vaultCredHosts, setVaultCredHosts] = useState<Record<string, Set<string>>>({});
  const [vaultCount, setVaultCount] = useState(0);

  // Reset fields when the dialog opens. Environment preselect tracks
  // `singleEnvironmentId` separately so an inline env create that
  // populates the list does not wipe the initial message.
  useEffect(() => {
    if (!open) return;
    setMessage("");
    setCreating(false);
    setCreatingEnv(false);
    setInlineEnvCreated(false);
    setVaultIds([]);
    setVaultCredHosts({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setEnvironmentId(preferredEnvironmentId(agentMetadata, singleEnvironmentId));
    // agentMetadata is read for the default id; parent identity is stable
    // for the life of the dialog host.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, singleEnvironmentId]);

  // MCP URLs: prop wins; otherwise fetch agent row when open.
  useEffect(() => {
    if (!open) return;
    if (agentMcpUrlsProp) {
      setMcpUrls(agentMcpUrlsProp);
      return;
    }
    let cancelled = false;
    api<{ mcp_servers?: Array<{ url?: string }> }>(`/v1/agents/${agentId}`)
      .then((row) => {
        if (cancelled) return;
        setMcpUrls(
          (row.mcp_servers ?? [])
            .map((s) => s.url)
            .filter((u): u is string => typeof u === "string" && u.length > 0),
        );
      })
      .catch(() => {
        if (!cancelled) setMcpUrls([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, agentId, agentMcpUrlsProp, api]);

  // Whether any vaults exist (to show the picker). Cheap list; shared cache.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<{ data: Array<{ id: string }> }>("/v1/vaults?limit=1")
      .then((r) => {
        if (!cancelled) setVaultCount(r.data?.length ?? 0);
      })
      .catch(() => {
        if (!cancelled) setVaultCount(0);
      });
    return () => {
      cancelled = true;
    };
  }, [open, api]);

  // Lazy-load credential hostnames for selected vaults (hostname match, same
  // as SessionsList / outbound proxy).
  useEffect(() => {
    if (!open) return;
    const missing = vaultIds.filter((vid) => !(vid in vaultCredHosts));
    if (missing.length === 0) return;
    let cancelled = false;
    Promise.all(
      missing.map(async (vid) => {
        try {
          const r = await api<{ data: Array<{ auth?: { mcp_server_url?: string } }> }>(
            `/v1/vaults/${vid}/credentials`,
          );
          const hosts = new Set<string>();
          for (const cred of r.data) {
            const u = cred.auth?.mcp_server_url;
            if (!u) continue;
            try {
              hosts.add(new URL(u).hostname);
            } catch {
              /* ignore */
            }
          }
          return [vid, hosts] as const;
        } catch {
          return [vid, new Set<string>()] as const;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      setVaultCredHosts((prev) => {
        const next = { ...prev };
        for (const [vid, hosts] of entries) next[vid] = hosts;
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [open, vaultIds, vaultCredHosts, api]);

  const unauthedMcpServers = useMemo(() => {
    if (mcpUrls.length === 0) return [];
    const covered = new Set<string>();
    for (const vid of vaultIds) {
      const hosts = vaultCredHosts[vid];
      if (hosts) for (const h of hosts) covered.add(h);
    }
    const missing: Array<{ url: string; host: string }> = [];
    for (const url of mcpUrls) {
      let host: string;
      try {
        host = new URL(url).hostname;
      } catch {
        continue;
      }
      if (!covered.has(host)) missing.push({ url, host });
    }
    return missing;
  }, [mcpUrls, vaultIds, vaultCredHosts]);

  const needsEnvironment = !isLocalRuntime && (!hasNoEnvironments || inlineEnvCreated);
  // Agent default (metadata.default_environment_id) lets the server resolve
  // the env when the picker is empty — docs/sandbox-runtime-selection.md.
  const agentDefaultEnv = preferredEnvironmentId(agentMetadata, null);
  const canSubmit = isLocalRuntime || !!environmentId || !!agentDefaultEnv;
  const showNoEnvCta = !isLocalRuntime && hasNoEnvironments && !inlineEnvCreated;

  const createDefaultEnvironment = async () => {
    if (creatingEnv) return;
    setCreatingEnv(true);
    try {
      const env = await api<{ id: string; name?: string }>("/v1/environments", {
        method: "POST",
        body: JSON.stringify(DEFAULT_CLOUD_ENVIRONMENT),
      });
      setEnvironmentId(env.id);
      setInlineEnvCreated(true);
      await queryClient.invalidateQueries({ queryKey: ["/v1/environments"] });
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      // api() already toasted — leave the CTA so they can retry.
    } finally {
      setCreatingEnv(false);
    }
  };

  const submit = async () => {
    if (!canSubmit) return;
    setCreating(true);
    try {
      const body: Record<string, unknown> = { agent: agentId };
      // Prefer explicit picker value; otherwise omit and let the API use
      // agent.metadata.default_environment_id (server-side resolution).
      if (!isLocalRuntime && environmentId) body.environment_id = environmentId;
      if (vaultIds.length > 0) body.vault_ids = vaultIds;
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
          <Button onClick={submit} disabled={!canSubmit || creating || envsLoading || creatingEnv}>
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
        {showNoEnvCta && (
          <div className="rounded-lg border border-border bg-bg-surface px-3 py-2 text-sm text-fg-muted space-y-2">
            <p>
              This agent needs an environment to run sessions, and your tenant has none yet.
              Create a default Cloudflare sandbox here to continue.
            </p>
            <Button
              variant="secondary"
              onClick={() => void createDefaultEnvironment()}
              disabled={creatingEnv}
            >
              {creatingEnv ? "Creating…" : "Create default environment"}
            </Button>
          </div>
        )}

        {(vaultCount > 0 || mcpUrls.length > 0) && (
          <div className="space-y-1.5">
            <VaultsPicker
              label="Credential Vaults"
              value={vaultIds}
              onChange={setVaultIds}
              optional
            />
            <p className="text-[11px] text-fg-subtle leading-relaxed">
              Secrets are injected by the outbound proxy — they never enter the sandbox.
              {vaultCount === 0 ? (
                <>
                  {" "}
                  <Link to="/vaults" className="text-brand hover:underline">
                    Create a vault
                  </Link>{" "}
                  if this agent uses MCP or authenticated APIs.
                </>
              ) : null}
            </p>
            {unauthedMcpServers.length > 0 && (
              <div className="mt-1 px-3 py-2 rounded-md border border-warning/40 bg-warning/5 text-xs text-warning">
                <div className="font-medium mb-1">
                  {unauthedMcpServers.length === 1
                    ? "1 MCP server has no matching credential in selected vaults:"
                    : `${unauthedMcpServers.length} MCP servers have no matching credentials in selected vaults:`}
                </div>
                <ul className="space-y-0.5 font-mono">
                  {unauthedMcpServers.map((s) => (
                    <li key={s.url}>· {s.host}</li>
                  ))}
                </ul>
                <div className="mt-1 text-fg-muted font-sans">
                  Agent will dial these endpoints unauthenticated. Add a vault credential for
                  each host, or expect 401s mid-conversation.
                </div>
              </div>
            )}
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

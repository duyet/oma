import { useMemo, useState } from "react";
import { Link } from "react-router";
import { BookOpenIcon, ChevronDownIcon, PlugZapIcon, UsersIcon, WrenchIcon } from "lucide-react";

import { useApiQuery } from "../../lib/useApiQuery";
import { RuntimeKindBadge, agentRuntimeKind } from "../../lib/runtime-kind";
import { ModelName } from "../../lib/model-provider";
import { GitHubIcon, LinearIcon, SlackIcon } from "../../components/icons";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { AgentWebhooks } from "./AgentWebhooks";
import { useAgentHub } from "../AgentDetail";
import type { AgentRecord as Agent } from "../../types/agent";
import { rowActivateKeyDown } from "@/lib/utils";
import { harnessLabel, harnessOption } from "./harness-options";

/** Shared publication shape across Linear / GitHub / Slack. */
interface Pub {
  id: string;
  status: string;
  mode: string;
  persona: { name: string; avatarUrl: string | null };
  workspace_name: string | null;
}

const modelStr = (m: Agent["model"]) =>
  typeof m === "string" ? m : `${m?.id} (${m?.speed || "standard"})`;

/**
 * Tab 1 — the agent's configuration view: properties, system prompt,
 * tools, integrations, webhooks, plus a version picker that swaps the
 * config grid + system prompt to any historical version (read-only) and
 * back to latest. Editing is always on the latest version (the header's
 * Edit button, in the hub layout).
 */
export function AgentOverviewTab() {
  const { agent, versions } = useAgentHub();

  // Selected version to VIEW. Defaults to latest; picking an older version
  // renders its snapshot read-only with a banner.
  const [viewVersion, setViewVersion] = useState<number | null>(null);
  const isViewingOld = viewVersion !== null && viewVersion !== agent.version;
  const displayAgent = useMemo<Agent>(() => {
    if (viewVersion === null) return agent;
    return versions.find((v) => v.version === viewVersion) ?? agent;
  }, [viewVersion, versions, agent]);

  // Reverse-lookup publications per provider (agent-level, not versioned).
  const { data: linearRes } = useApiQuery<{ data: Pub[] }>(
    `/v1/integrations/linear/agents/${agent.id}/publications`,
  );
  const { data: githubRes } = useApiQuery<{ data: Pub[] }>(
    `/v1/integrations/github/agents/${agent.id}/publications`,
  );
  const { data: slackRes } = useApiQuery<{ data: Pub[] }>(
    `/v1/integrations/slack/agents/${agent.id}/publications`,
  );
  const linearPubs = useMemo(
    () => (linearRes?.data ?? []).filter((p) => p.status === "live"),
    [linearRes],
  );
  const githubPubs = useMemo(
    () => (githubRes?.data ?? []).filter((p) => p.status === "live"),
    [githubRes],
  );
  const slackPubs = useMemo(
    () => (slackRes?.data ?? []).filter((p) => p.status === "live"),
    [slackRes],
  );

  return (
    <div className="pb-4 space-y-6">
      {/* Version picker + banner */}
      <div className="flex items-center gap-3 flex-wrap">
        <VersionPicker
          versions={versions}
          latest={agent.version}
          value={viewVersion ?? agent.version}
          onChange={(v) => setViewVersion(v === agent.version ? null : v)}
        />
        {isViewingOld && (
          <div className="text-xs text-warning bg-warning/10 border border-warning/30 rounded-md px-2.5 py-1">
            Viewing v{viewVersion} — the active version is v{agent.version}.{" "}
            <button
              type="button"
              onClick={() => setViewVersion(null)}
              className="underline hover:no-underline"
            >
              Back to latest
            </button>
          </div>
        )}
      </div>

      {/* Properties grid — reflects the version being viewed. */}
      <div className="grid grid-cols-[140px_1fr] gap-x-4 gap-y-2 max-w-2xl text-sm">
        <span className="text-fg-muted">ID</span>
        <span className="font-mono text-xs">{agent.id}</span>
        {displayAgent.description && (
          <>
            <span className="text-fg-muted">Description</span>
            <span>{displayAgent.description}</span>
          </>
        )}
        <span className="text-fg-muted">Model</span>
        <ModelName model={modelStr(displayAgent.model)} />
        {displayAgent._oma?.aux_model && (
          <>
            <span className="text-fg-muted">Aux Model</span>
            <ModelName model={modelStr(displayAgent._oma.aux_model)} />
          </>
        )}
        <span className="text-fg-muted">Runtime</span>
        <RuntimeKindBadge
          kind={agentRuntimeKind(displayAgent)}
          className="text-sm text-fg"
          detail={
            displayAgent._oma?.runtime_binding
              ? `machine ${displayAgent._oma.runtime_binding.runtime_id} · ACP agent ${displayAgent._oma.runtime_binding.acp_agent_id}`
              : undefined
          }
        />
        <span className="text-fg-muted">Harness</span>
        <span className="inline-flex items-center gap-2 flex-wrap">
          <span>{harnessLabel(displayAgent._oma?.harness)}</span>
          {(() => {
            const opt = harnessOption(displayAgent._oma?.harness || "default");
            return opt ? (
              <span className="text-[10px] rounded px-1 py-0.5 bg-bg-surface text-fg-subtle">
                {opt.badge}
              </span>
            ) : null;
          })()}
          <span className="text-[10px] font-mono text-fg-subtle">
            {displayAgent._oma?.harness || "default"}
          </span>
        </span>
        {displayAgent._oma?.runtime_binding && (
          <>
            <span className="text-fg-muted">Local Runtime</span>
            <span className="text-xs">
              <span className="font-mono">
                {displayAgent._oma.runtime_binding.runtime_id.slice(0, 8)}…
              </span>
              <span className="text-fg-subtle"> · ACP agent: </span>
              <span className="font-mono">{displayAgent._oma.runtime_binding.acp_agent_id}</span>
            </span>
          </>
        )}
        <span className="text-fg-muted">Version</span>
        <span>v{displayAgent.version}</span>
        <span className="text-fg-muted inline-flex items-center gap-1.5">
          <WrenchIcon className="size-3.5 text-fg-subtle" aria-hidden="true" />
          Tools
        </span>
        <span>
          {(displayAgent.tools || [])
            .map((t) => {
              const tool = t as { type: string; name?: string };
              return tool.type === "custom" ? `Custom: ${tool.name}` : tool.type;
            })
            .join(", ") || "None"}
        </span>
        {(displayAgent.skills?.length ?? 0) > 0 && (
          <>
            <span className="text-fg-muted inline-flex items-center gap-1.5">
              <BookOpenIcon className="size-3.5 text-fg-subtle" aria-hidden="true" />
              Skills
            </span>
            <span>
              {(displayAgent.skills as Array<{ skill_id: string }>)
                .map((s) => s.skill_id)
                .join(", ")}
            </span>
          </>
        )}
        {(displayAgent.mcp_servers?.length ?? 0) > 0 && (
          <>
            <span className="text-fg-muted inline-flex items-center gap-1.5">
              <PlugZapIcon className="size-3.5 text-fg-subtle" aria-hidden="true" />
              MCP Servers
            </span>
            <span>
              {(displayAgent.mcp_servers as Array<{ name: string }>)
                .map((m) => m.name)
                .join(", ")}
            </span>
          </>
        )}
        {(displayAgent.multiagent?.agents?.length ?? 0) > 0 && (
          <>
            <span className="text-fg-muted inline-flex items-center gap-1.5">
              <UsersIcon className="size-3.5 text-fg-subtle" aria-hidden="true" />
              Callable Agents
            </span>
            <span className="font-mono text-xs">
              {displayAgent.multiagent!.agents.map((a) => a.id).join(", ")}
            </span>
          </>
        )}
        {displayAgent.metadata && Object.keys(displayAgent.metadata).length > 0 && (
          <>
            <span className="text-fg-muted">Metadata</span>
            <span className="font-mono text-xs whitespace-pre-wrap">
              {JSON.stringify(displayAgent.metadata)}
            </span>
          </>
        )}
        <span className="text-fg-muted">Created</span>
        <span>{new Date(agent.created_at).toLocaleString()}</span>
        <span className="text-fg-muted">Updated</span>
        <span>{new Date(agent.updated_at || agent.created_at).toLocaleString()}</span>
        {agent.archived_at && (
          <>
            <span className="text-fg-muted">Archived</span>
            <span className="text-warning">{new Date(agent.archived_at).toLocaleString()}</span>
          </>
        )}
      </div>

      {/* Two-column on xl: integrations + webhooks left, system prompt +
          version history right. */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-x-8 items-start">
        <div className="min-w-0">
          <div className="max-w-2xl">
            <h2 className="font-display text-base font-semibold mb-2">Integrations</h2>
            <div className="space-y-2">
              <IntegrationFold
                kind="linear"
                label="Linear"
                icon={<LinearIcon className="w-4 h-4" />}
                pubs={linearPubs}
                agentId={agent.id}
              />
              <IntegrationFold
                kind="github"
                label="GitHub"
                icon={<GitHubIcon className="w-4 h-4" />}
                pubs={githubPubs}
                agentId={agent.id}
              />
              <IntegrationFold
                kind="slack"
                label="Slack"
                icon={<SlackIcon className="w-4 h-4" />}
                pubs={slackPubs}
                agentId={agent.id}
              />
            </div>
          </div>

          <AgentWebhooks agent={agent} />
        </div>

        <div className="min-w-0">
          {displayAgent.system && (
            <div className="mt-6 xl:mt-0 max-w-2xl">
              <h2 className="font-display text-base font-semibold mb-2">System Prompt</h2>
              <pre className="bg-bg-surface border border-border rounded-lg p-4 text-sm whitespace-pre-wrap max-h-64 overflow-y-auto font-mono text-fg-muted leading-relaxed">
                {displayAgent.system}
              </pre>
            </div>
          )}

          {versions.length > 0 && (
            <div className="mt-8 max-w-2xl">
              <h2 className="font-display text-base font-semibold mb-2">Version History</h2>
              <div className="border border-border rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-bg-surface/60 text-fg-muted text-xs uppercase tracking-wider">
                      <th className="text-left px-4 py-2">Version</th>
                      <th className="text-left px-4 py-2">Model</th>
                      <th className="text-left px-4 py-2">System Prompt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {versions.map((v) => (
                      <tr
                        key={v.version}
                        className="border-t border-border cursor-pointer hover:bg-bg-surface/40"
                        onClick={() => setViewVersion(v.version === agent.version ? null : v.version)}
                        onKeyDown={rowActivateKeyDown(() =>
                          setViewVersion(v.version === agent.version ? null : v.version),
                        )}
                        tabIndex={0}
                        role="button"
                      >
                        <td className="px-4 py-2">
                          v{v.version}
                          {v.version === agent.version && (
                            <span className="ml-1.5 text-[10px] text-success">latest</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-fg-muted">{modelStr(v.model)}</td>
                        <td className="px-4 py-2 text-fg-muted max-w-xs truncate">
                          {v.system || "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** `Version: vN ▾` dropdown listing every version, latest tagged. */
function VersionPicker({
  versions,
  latest,
  value,
  onChange,
}: {
  versions: Agent[];
  latest: number;
  value: number;
  onChange: (v: number) => void;
}) {
  // Descending so the newest is at the top. The live agent's own version is
  // folded in: `/v1/agents/:id/versions` can come back empty (or still be
  // loading) for an agent that has never been updated, and a dropdown that
  // opens onto nothing but its header reads as broken — there is always at
  // least one version to show.
  const ordered = useMemo(() => {
    const seen = new Set<number>([latest, value]);
    for (const v of versions) seen.add(v.version);
    return [...seen].sort((a, b) => b - a);
  }, [versions, latest, value]);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="inline-flex items-center gap-1.5 border border-border rounded-md bg-bg-surface px-3 py-1.5 text-sm hover:bg-bg-surface/70">
        <span className="text-fg-muted">Version:</span>
        <span className="font-medium">v{value}</span>
        {value === latest && <span className="text-[10px] text-success">latest</span>}
        <ChevronDownIcon className="size-3.5 text-fg-subtle" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-44">
        <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-fg-subtle font-medium">
          View version
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {ordered.map((version) => (
          <DropdownMenuCheckboxItem
            key={version}
            checked={version === value}
            onCheckedChange={() => onChange(version)}
          >
            v{version}
            {version === latest && <span className="ml-1.5 text-[10px] text-success">latest</span>}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** One foldable provider section (default-open when there's a live pub). */
function IntegrationFold({
  kind,
  label,
  icon,
  pubs,
  agentId,
}: {
  kind: "linear" | "github" | "slack";
  label: string;
  icon: React.ReactNode;
  pubs: Pub[];
  agentId: string;
}) {
  return (
    <details
      open={pubs.length > 0}
      className="border border-border rounded-lg bg-bg-surface/30 [&_summary::-webkit-details-marker]:hidden"
    >
      <summary className="px-4 py-2.5 min-h-11 sm:min-h-0 flex items-center gap-3 text-sm cursor-pointer hover:bg-bg-surface/60 list-none">
        <span className="text-fg-muted shrink-0">{icon}</span>
        <span className="font-medium text-fg">{label}</span>
        <span className="ml-auto text-xs text-fg-subtle">
          {pubs.length === 0 ? "Not published" : `${pubs.length} live`}
        </span>
      </summary>
      <div className="px-4 pb-3 pt-2 border-t border-border/40 space-y-1.5 text-sm">
        {pubs.length === 0 ? (
          <Link
            to={`/integrations/${kind}/publish?agent_id=${agentId}`}
            className="inline-flex items-center gap-1.5 min-h-11 sm:min-h-0 text-brand hover:underline"
          >
            Publish to {label} →
          </Link>
        ) : (
          <>
            {pubs.map((p) => (
              <Link
                key={p.id}
                to={`/integrations/${kind}`}
                className="flex items-center gap-2 min-h-11 sm:min-h-0 text-fg-muted hover:text-fg"
              >
                <span className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-success-subtle text-success">
                  Live
                </span>
                <span>
                  as <strong>{p.persona.name}</strong> in {p.workspace_name ?? `${label} workspace`}
                </span>
                {p.mode === "full" && (
                  <span className="text-xs text-fg-subtle">(full identity)</span>
                )}
              </Link>
            ))}
            <Link
              to={`/integrations/${kind}/publish?agent_id=${agentId}`}
              className="inline-flex items-center min-h-11 sm:min-h-0 text-xs text-brand hover:underline pt-1"
            >
              + Publish to another workspace
            </Link>
          </>
        )}
      </div>
    </details>
  );
}

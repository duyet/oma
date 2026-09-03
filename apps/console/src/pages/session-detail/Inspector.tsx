import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";

import { useApi } from "../../lib/api";
import { formatDuration, formatRelative, shortenId } from "../../lib/format";
import type { Event } from "../../lib/events";
import { RuntimeKindBadge, agentRuntimeKind } from "../../lib/runtime-kind";
import { ModelName } from "../../lib/model-provider";
import { Button } from "@/components/ui/button";
import { BrowserVmDetailDialog } from "../../lib/browser-vm/BrowserVmDetailDialog";
import { ResponsiveRail } from "@/components/ResponsiveRail";
import { browserVmStatusMeta, useBrowserVm } from "../../lib/browser-vm/BrowserVmProvider";
import {
  estimateCostUsd,
  formatEstCostUsd,
  formatTokens,
  sandboxProviderInfo,
  useSessionAnalytics,
  type SessionAnalytics,
} from "./analytics";

/**
 * Right-rail session Inspector.
 *
 * Replaces the old click-a-badge `ResourcePanel` / `FilesPanel` pair with a
 * persistent tabbed rail. The design goal is that an operator watching a run
 * never has to leave the page to answer "what is this thing actually doing":
 * which model, on what sandbox, how much context is left, what the tools are
 * costing, where the files live.
 *
 * Data sources, in order of preference:
 *   1. The event log the page already streams (via `useSessionAnalytics`) —
 *      live during a run, no polling.
 *   2. `GET /v1/sessions/:id` extras (sandbox_status, sandbox_usage, usage).
 *   3. Lazy per-tab fetches for the agent + environment records, which carry
 *      the config the event log doesn't (harness, skills, MCP servers,
 *      sandbox provider, packages, networking).
 */

export type InspectorTab = "overview" | "usage" | "tools" | "sandbox" | "files";

const TABS: Array<{ id: InspectorTab; label: string }> = [
  { id: "overview", label: "Overview" },
  { id: "usage", label: "Usage" },
  { id: "tools", label: "Tools" },
  { id: "sandbox", label: "Sandbox" },
  { id: "files", label: "Files" },
];

interface AgentRecord {
  id?: string;
  name?: string;
  description?: string;
  model?: string | { id?: string; speed?: string };
  aux_model?: string | { id?: string };
  harness?: string;
  version?: number;
  system?: string;
  tools?: Array<Record<string, unknown>>;
  skills?: Array<{ skill_id?: string; type?: string }>;
  mcp_servers?: Array<{ name?: string; url?: string; registry_id?: string }>;
  callable_agents?: Array<Record<string, unknown>>;
  max_parallel_subagents?: number;
  runtime_binding?: { acp_agent_id?: string; model?: string; reasoning_effort?: string };
  enable_general_subagent?: boolean;
}

interface EnvironmentRecord {
  id?: string;
  name?: string;
  status?: string;
  config?: {
    type?: string;
    sandbox_provider?: string;
    packages?: Record<string, string[]>;
    networking?: { type?: string; allowed_hosts?: string[] };
    git_repo?: { url?: string; branch?: string };
  };
}

interface SessionOutputFile {
  filename: string;
  size_bytes: number;
  uploaded_at: string;
  media_type: string;
}

export interface InspectorSessionMeta {
  environmentId?: string;
  vaults?: Array<{ id: string; display_name?: string }>;
  vaultIds?: string[];
  createdAt?: string;
  agentSnapshot?: {
    id?: string;
    name?: string;
    model?: string | { id: string };
    description?: string;
    version?: number;
    runtime_binding?: { runtime_id?: string; acp_agent_id?: string };
    metadata?: Record<string, unknown>;
  };
  envSnapshot?: { id?: string; name?: string; description?: string };
  /** Extras returned by GET /v1/sessions/:id beyond the stored row. */
  sandboxUsage?: { instance_type?: string; active_seconds?: number };
  resources?: unknown[];
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function modelIdOf(m: AgentRecord["model"]): string | undefined {
  return typeof m === "string" ? m : m?.id;
}

/* ── Presentational atoms ───────────────────────────────────────────── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[10px] uppercase tracking-wide text-fg-subtle font-mono">{title}</h3>
      {children}
    </section>
  );
}

function Row({
  label,
  value,
  title,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  title?: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-3 text-xs py-0.5">
      <span className="text-fg-subtle shrink-0">{label}</span>
      <span
        className={`ml-auto min-w-0 text-right text-fg-muted truncate ${mono ? "font-mono" : ""}`}
        title={title ?? (typeof value === "string" ? value : undefined)}
      >
        {value}
      </span>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md bg-bg-surface/60 px-2.5 py-2" title={hint}>
      <div className="text-[10px] uppercase tracking-wide text-fg-subtle">{label}</div>
      <div className="text-sm font-mono text-fg mt-0.5 truncate">{value}</div>
    </div>
  );
}

/** Segmented horizontal bar. Segments render in order; a `max` larger than
 *  the segment sum leaves the remainder as unfilled track (used for the
 *  context-window meter, where the empty part is the point). */
function Meter({
  segments,
  max,
}: {
  segments: Array<{ label: string; value: number; className: string }>;
  max?: number;
}) {
  const sum = segments.reduce((a, s) => a + s.value, 0);
  const denom = Math.max(max ?? sum, 1);
  return (
    <div className="flex h-2 w-full overflow-hidden rounded-full bg-bg-surface">
      {segments.map((s) =>
        s.value > 0 ? (
          <div
            key={s.label}
            className={s.className}
            style={{ width: `${(s.value / denom) * 100}%` }}
            title={`${s.label}: ${s.value.toLocaleString()}`}
          />
        ) : null,
      )}
    </div>
  );
}

function Dot({ tone }: { tone: "ok" | "warn" | "off" }) {
  const cls =
    tone === "ok" ? "bg-success" : tone === "warn" ? "bg-warning" : "bg-fg-subtle";
  return <span className={`inline-block size-1.5 rounded-full ${cls}`} aria-hidden />;
}

/* ── Tabs ───────────────────────────────────────────────────────────── */

function OverviewTab({
  analytics,
  meta,
  agent,
  status,
  sandboxStatus,
  streaming,
  reasoningEffort,
}: {
  analytics: SessionAnalytics;
  meta: InspectorSessionMeta;
  agent: AgentRecord | null;
  status: string;
  sandboxStatus?: string;
  streaming: boolean;
  reasoningEffort?: string;
}) {
  const configuredModel = modelIdOf(agent?.model) ?? modelIdOf(meta.agentSnapshot?.model);
  const model = analytics.latestModel ?? configuredModel;
  const effort = reasoningEffort ?? agent?.runtime_binding?.reasoning_effort;
  const lastEventAge =
    analytics.lastEventTs !== undefined ? Date.now() - analytics.lastEventTs : undefined;

  return (
    <div className="space-y-5">
      <Section title="Coding agent">
        <Row label="Agent" value={agent?.name ?? meta.agentSnapshot?.name ?? "—"} />
        <Row
          label="Version"
          value={agent?.version ?? meta.agentSnapshot?.version ?? "—"}
          mono
        />
        <Row label="Harness" value={agent?.harness ?? "default"} mono />
        {agent?.runtime_binding?.acp_agent_id && (
          <Row label="ACP agent" value={agent.runtime_binding.acp_agent_id} mono />
        )}
        <Row
          label="Sub-agents"
          value={
            agent?.callable_agents?.length
              ? `${agent.callable_agents.length} callable${agent.enable_general_subagent ? " + general" : ""}`
              : agent?.enable_general_subagent
                ? "general_subagent"
                : "none"
          }
        />
        <Row
          label="Runtime"
          value={<RuntimeKindBadge kind={agentRuntimeKind(agent ?? meta.agentSnapshot)} />}
        />
        {agent?.description && (
          <p className="text-xs text-fg-subtle pt-1 line-clamp-3">{agent.description}</p>
        )}
      </Section>

      <Section title="Model">
        <Row
          label="Running"
          value={model ? <ModelName model={model} className="justify-end" /> : "—"}
          title={model}
        />
        {/* A gateway alias (anyrouter/free, a router "auto" tier) only names
            a concrete model in the response — surface what actually ran. */}
        {analytics.latestResolvedModel && (
          <Row
            label="Resolved to"
            value={<ModelName model={analytics.latestResolvedModel} className="justify-end" />}
            title={analytics.latestResolvedModel}
          />
        )}
        {configuredModel && configuredModel !== model && (
          <Row label="Configured" value={configuredModel} mono />
        )}
        {agent?.aux_model && (
          <Row label="Aux model" value={modelIdOf(agent.aux_model) ?? "—"} mono />
        )}
        {effort && <Row label="Reasoning" value={effort} mono />}
        {analytics.modelsUsed.length > 1 && (
          <Row
            label="Models seen"
            value={analytics.modelsUsed.join(", ")}
            title={analytics.modelsUsed.join(", ")}
          />
        )}
        <Row
          label="Context window"
          value={analytics.contextWindow ? `${formatTokens(analytics.contextWindow)} tok` : "unknown"}
          mono
        />
      </Section>

      <Section title="Connection">
        <Row
          label="Session"
          value={
            <span className="inline-flex items-center gap-1.5">
              <Dot tone={status === "running" ? "ok" : status === "error" ? "warn" : "off"} />
              {status}
            </span>
          }
        />
        <Row
          label="Stream"
          value={
            <span className="inline-flex items-center gap-1.5">
              <Dot tone={streaming ? "ok" : "off"} />
              {streaming ? "live (SSE)" : "idle"}
            </span>
          }
        />
        <Row
          label="Sandbox"
          value={
            <span className="inline-flex items-center gap-1.5">
              <Dot
                tone={
                  sandboxStatus === "running" ? "ok" : sandboxStatus === "paused" ? "warn" : "off"
                }
              />
              {sandboxStatus ?? "unknown"}
            </span>
          }
        />
        <Row
          label="Last event"
          value={lastEventAge !== undefined ? `${formatRelative(lastEventAge)}` : "—"}
        />
        <Row
          label="Wall clock"
          value={analytics.wallClockMs !== undefined ? formatDuration(analytics.wallClockMs) : "—"}
        />
        {meta.createdAt && (
          <Row
            label="Started"
            value={new Date(meta.createdAt).toLocaleString()}
            title={meta.createdAt}
          />
        )}
      </Section>

      <Section title="Activity">
        <div className="grid grid-cols-2 gap-2">
          <Stat label="Model calls" value={String(analytics.modelCalls)} />
          <Stat label="Tool calls" value={String(analytics.toolCalls)} />
          <Stat label="Threads" value={String(analytics.subAgentThreads + 1)} hint="Primary thread plus spawned sub-agent threads" />
          <Stat
            label="Errors"
            value={String(analytics.erroredModelCalls + analytics.toolErrors)}
            hint="Errored model calls plus failed tool results"
          />
        </div>
      </Section>

      <Section title="Attached">
        <Row label="Skills" value={agent?.skills?.length ? String(agent.skills.length) : "none"} />
        <Row
          label="MCP servers"
          value={
            agent?.mcp_servers?.length
              ? agent.mcp_servers.map((s) => s.name ?? "unnamed").join(", ")
              : "none"
          }
        />
        <Row
          label="Vaults"
          value={
            (meta.vaults ?? meta.vaultIds?.map((id) => ({ id })) ?? []).length
              ? (meta.vaults ?? []).map((v) => v.display_name ?? shortenId(v.id)).join(", ") ||
                String(meta.vaultIds?.length)
              : "none"
          }
        />
        <Row
          label="Memory stores"
          value={
            (meta.resources ?? []).filter(
              (r) => (r as { type?: string }).type === "memory_store",
            ).length || "none"
          }
        />
      </Section>

      {meta.agentSnapshot?.id && (
        <Link
          to={`/agents/${meta.agentSnapshot.id}`}
          className="inline-flex items-center gap-1.5 text-xs text-info hover:text-info/80 font-medium"
        >
          Open agent →
        </Link>
      )}
    </div>
  );
}

function UsageTab({ analytics }: { analytics: SessionAnalytics }) {
  const t = analytics.totals;
  const cost = estimateCostUsd(analytics.latestModel, t);
  const ctxPct =
    analytics.contextTokens && analytics.contextWindow
      ? Math.min(100, (analytics.contextTokens / analytics.contextWindow) * 100)
      : undefined;

  return (
    <div className="space-y-5">
      <Section title="Context window">
        {analytics.contextTokens === undefined ? (
          <p className="text-xs text-fg-subtle">No completed model call yet.</p>
        ) : (
          <>
            <Meter
              segments={[
                {
                  label: "Used",
                  value: analytics.contextTokens,
                  className: ctxPct !== undefined && ctxPct > 85 ? "bg-warning" : "bg-info",
                },
              ]}
              max={analytics.contextWindow}
            />
            <Row
              label="Occupied"
              value={
                analytics.contextWindow
                  ? `${formatTokens(analytics.contextTokens)} / ${formatTokens(analytics.contextWindow)} (${ctxPct?.toFixed(0)}%)`
                  : `${formatTokens(analytics.contextTokens)} tok`
              }
              mono
              title="Full prompt of the most recent model call: fresh input + cache reads + cache writes"
            />
            {analytics.compactions > 0 && (
              <Row label="Compactions" value={String(analytics.compactions)} mono />
            )}
          </>
        )}
      </Section>

      <Section title="Tokens">
        <Meter
          segments={[
            { label: "Cache read", value: t.cacheRead, className: "bg-success" },
            { label: "Cache write", value: t.cacheCreation, className: "bg-info" },
            { label: "Input", value: t.input, className: "bg-warning" },
            { label: "Output", value: t.output, className: "bg-accent-violet" },
          ]}
        />
        <Row label="Input (fresh)" value={t.input.toLocaleString()} mono />
        <Row label="Output" value={t.output.toLocaleString()} mono />
        <Row label="Cache read" value={t.cacheRead.toLocaleString()} mono />
        <Row label="Cache write" value={t.cacheCreation.toLocaleString()} mono />
        {t.reasoning > 0 && <Row label="Reasoning" value={t.reasoning.toLocaleString()} mono />}
        <Row label="Total" value={analytics.totalTokens.toLocaleString()} mono />
      </Section>

      <Section title="Efficiency">
        <div className="grid grid-cols-2 gap-2">
          <Stat
            label="Cache hit rate"
            value={
              analytics.cacheHitRate !== undefined
                ? `${(analytics.cacheHitRate * 100).toFixed(1)}%`
                : "—"
            }
            hint="Cache reads as a share of all prompt tokens billed. Higher is cheaper — a byte-level change to the cached prefix drops this to 0."
          />
          <Stat
            label="Est. cost"
            value={cost !== undefined ? formatEstCostUsd(cost) : "—"}
            hint="Rough estimate — cache reads billed at 10% of input, writes at 125%. Hidden for models with no known price."
          />
          <Stat
            label="Avg latency"
            value={
              analytics.avgLatencyMs !== undefined ? formatDuration(analytics.avgLatencyMs) : "—"
            }
            hint="Mean provider round-trip per model call"
          />
          <Stat
            label="p95 latency"
            value={
              analytics.p95LatencyMs !== undefined ? formatDuration(analytics.p95LatencyMs) : "—"
            }
          />
        </div>
      </Section>

      {analytics.latest && (
        <Section title="Latest call">
          <Row label="Model" value={analytics.latest.model ?? "—"} mono />
          <Row
            label="Duration"
            value={
              analytics.latest.durationMs !== undefined
                ? formatDuration(analytics.latest.durationMs)
                : "—"
            }
          />
          <Row
            label="Tokens"
            value={`${analytics.latest.usage.input.toLocaleString()} in / ${analytics.latest.usage.output.toLocaleString()} out`}
            mono
          />
          <Row label="Finish" value={analytics.latest.finishReason ?? "—"} mono />
          {analytics.latest.isError && (
            <Row label="Status" value={<span className="text-danger">errored</span>} />
          )}
        </Section>
      )}
    </div>
  );
}

function ToolsTab({ analytics }: { analytics: SessionAnalytics }) {
  if (analytics.tools.length === 0) {
    return <p className="text-xs text-fg-subtle">No tool calls yet.</p>;
  }
  const busiest = analytics.tools[0].calls || 1;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <Stat label="Total calls" value={String(analytics.toolCalls)} />
        <Stat
          label="Failures"
          value={
            analytics.toolCalls > 0
              ? `${analytics.toolErrors} (${((analytics.toolErrors / analytics.toolCalls) * 100).toFixed(0)}%)`
              : "0"
          }
        />
      </div>
      <ul className="space-y-2">
        {analytics.tools.map((t) => (
          <li key={`${t.kind}:${t.name}`} className="space-y-1">
            <div className="flex items-baseline gap-2 text-xs">
              <span className="font-mono text-fg truncate" title={t.name}>
                {t.name}
              </span>
              {t.kind !== "builtin" && (
                <span className="shrink-0 text-[10px] px-1 py-px rounded bg-bg-surface text-fg-subtle uppercase">
                  {t.kind}
                </span>
              )}
              <span className="ml-auto shrink-0 font-mono text-fg-muted">{t.calls}×</span>
              {t.avgMs !== undefined && (
                <span className="shrink-0 text-fg-subtle" title="Mean duration">
                  {formatDuration(t.avgMs)}
                </span>
              )}
              {t.errors > 0 && (
                <span className="shrink-0 text-danger" title="Failed results">
                  {t.errors} err
                </span>
              )}
            </div>
            <Meter
              segments={[{ label: t.name, value: t.calls, className: "bg-info" }]}
              max={busiest}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Live embedded browser-vm status card, rendered on the Sandbox tab only
 *  when the session's environment runs on the browser-vm provider. Shares
 *  the app-wide `BrowserVmProvider` context, so it reflects the same
 *  hidden iframe every other status surface (RuntimesList) does. */
function BrowserVmStatusSection() {
  const { status, runtimeId, engine, ops, start } = useBrowserVm();
  const [detailOpen, setDetailOpen] = useState(false);
  const { label, tone } = browserVmStatusMeta(status);
  const needsStart = status === "off" || status === "offline" || status === "error";
  const recentOps = ops.slice(-3).reverse();

  return (
    <Section title="Browser VM">
      <div className="rounded-md bg-bg-surface/60 px-3 py-2.5 space-y-2">
        <div className="flex items-center gap-2">
          <Dot tone={tone === "ok" ? "ok" : tone === "off" ? "off" : "warn"} />
          <span className="text-sm font-medium text-fg">{label}</span>
          {engine && <span className="ml-auto text-[10px] font-mono text-fg-subtle">{engine}</span>}
        </div>
        {runtimeId && (
          <Row label="Runtime ID" value={runtimeId} mono />
        )}
        {recentOps.length > 0 && (
          <div className="space-y-0.5 pt-1">
            {recentOps.map((o, i) => (
              <div key={`${o.ts}-${i}`} className="text-[11px] font-mono text-fg-subtle flex gap-1.5">
                <span
                  className={
                    o.phase === "error" ? "text-danger" : o.phase === "done" ? "text-success" : ""
                  }
                >
                  {o.phase}
                </span>
                <span className="truncate">{o.op}</span>
              </div>
            ))}
          </div>
        )}
        <div className="flex gap-2 pt-1">
          {needsStart && (
            <Button size="sm" variant="secondary" onClick={() => void start()}>
              Start VM
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setDetailOpen(true)}>
            Details
          </Button>
        </div>
      </div>
      <BrowserVmDetailDialog open={detailOpen} onClose={() => setDetailOpen(false)} />
    </Section>
  );
}

function SandboxTab({
  meta,
  environment,
  sandboxStatus,
}: {
  meta: InspectorSessionMeta;
  environment: EnvironmentRecord | null;
  sandboxStatus?: string;
}) {
  const provider = sandboxProviderInfo(
    environment?.config?.sandbox_provider ?? environment?.config?.type,
  );
  const packages = environment?.config?.packages ?? {};
  const packageEntries = Object.entries(packages).filter(([, v]) => (v ?? []).length > 0);
  const activeSeconds = meta.sandboxUsage?.active_seconds;
  const isBrowserVm = provider.id === "browser-vm";

  return (
    <div className="space-y-5">
      {isBrowserVm && <BrowserVmStatusSection />}
      <Section title="Provider">
        <div className="rounded-md bg-bg-surface/60 px-3 py-2.5 space-y-1">
          <div className="flex items-center gap-2">
            <Dot
              tone={
                sandboxStatus === "running" ? "ok" : sandboxStatus === "paused" ? "warn" : "off"
              }
            />
            <span className="text-sm font-medium text-fg">{provider.label}</span>
            <span className="ml-auto text-[10px] font-mono text-fg-subtle">{provider.id}</span>
          </div>
          <p className="text-xs text-fg-muted">{provider.blurb}</p>
        </div>
        <Row label="Status" value={sandboxStatus ?? "unknown"} />
        <Row label="Runs on" value={provider.where} title={provider.where} />
        <Row label="Workspace" value={provider.workspace} mono />
        {meta.sandboxUsage?.instance_type && (
          <Row label="Instance" value={meta.sandboxUsage.instance_type} mono />
        )}
        {activeSeconds !== undefined && (
          <Row
            label="Active time"
            value={formatDuration(activeSeconds * 1000)}
            title="Billed sandbox uptime for this session"
          />
        )}
      </Section>

      {provider.caveats.length > 0 && (
        <Section title="Caveats">
          <ul className="space-y-1 text-xs text-fg-muted">
            {provider.caveats.map((c) => (
              <li key={c} className="flex gap-2">
                <span className="text-warning shrink-0" aria-hidden>
                  !
                </span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section title="Environment">
        <Row
          label="Name"
          value={environment?.name ?? meta.envSnapshot?.name ?? "—"}
        />
        <Row label="Status" value={environment?.status ?? "—"} />
        <Row
          label="Networking"
          value={environment?.config?.networking?.type ?? "unrestricted"}
        />
        {environment?.config?.networking?.allowed_hosts?.length ? (
          <Row
            label="Allowed hosts"
            value={`${environment.config.networking.allowed_hosts.length} host(s)`}
            title={environment.config.networking.allowed_hosts.join(", ")}
          />
        ) : null}
        {environment?.config?.git_repo?.url && (
          <Row
            label="Auto-clone"
            value={environment.config.git_repo.url}
            title={environment.config.git_repo.url}
            mono
          />
        )}
        {meta.environmentId && (
          <Link
            to={`/environments/${meta.environmentId}`}
            className="inline-flex items-center gap-1.5 text-xs text-info hover:text-info/80 font-medium pt-1"
          >
            Open environment →
          </Link>
        )}
      </Section>

      {packageEntries.length > 0 && (
        <Section title="Packages">
          {packageEntries.map(([mgr, list]) => (
            <Row key={mgr} label={mgr} value={list.join(", ")} title={list.join(", ")} mono />
          ))}
        </Section>
      )}
    </div>
  );
}

function FilesTab({ sessionId }: { sessionId: string }) {
  const { api } = useApi();
  const [files, setFiles] = useState<SessionOutputFile[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setFiles(null);
    setErr(null);
    api<{ data: SessionOutputFile[]; has_more: boolean }>(`/v1/sessions/${sessionId}/outputs`)
      .then((d) => setFiles(d.data ?? []))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
    // `api` is a fresh closure every render; sessionId is the stable input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-subtle">
        Files the agent wrote to <code className="font-mono">/mnt/session/outputs/</code>.
      </p>
      {err && <div className="text-xs text-danger">Failed to load: {err}</div>}
      {!files && !err && <div className="text-xs text-fg-subtle">Loading…</div>}
      {files && files.length === 0 && (
        <div className="text-xs text-fg-subtle">No files yet.</div>
      )}
      {files && files.length > 0 && (
        <ul className="space-y-1.5">
          {files.map((f) => (
            <li key={f.filename} className="py-1">
              <a
                href={`/v1/sessions/${sessionId}/outputs/${encodeURIComponent(f.filename)}`}
                download={f.filename}
                className="font-mono text-xs text-fg hover:text-info truncate block"
                title={f.filename}
              >
                {f.filename}
              </a>
              <div className="text-[10px] text-fg-subtle mt-0.5">
                {formatBytes(f.size_bytes)} · {f.media_type} ·{" "}
                {new Date(f.uploaded_at).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ── Rail ───────────────────────────────────────────────────────────── */

export function SessionInspector({
  sessionId,
  events,
  meta,
  agentId,
  status,
  sandboxStatus,
  streaming,
  reasoningEffort,
  tab,
  onTabChange,
  onClose,
}: {
  sessionId: string;
  events: Event[];
  meta: InspectorSessionMeta;
  agentId?: string;
  status: string;
  sandboxStatus?: string;
  /** True while an SSE stream is attached — drives the liveness dot. */
  streaming: boolean;
  reasoningEffort?: string;
  tab: InspectorTab;
  onTabChange: (tab: InspectorTab) => void;
  onClose: () => void;
}) {
  const { api } = useApi();
  const analytics = useSessionAnalytics(events);
  const [agent, setAgent] = useState<AgentRecord | null>(null);
  const [environment, setEnvironment] = useState<EnvironmentRecord | null>(null);

  const resolvedAgentId = meta.agentSnapshot?.id ?? agentId;

  useEffect(() => {
    if (!resolvedAgentId) return;
    let cancelled = false;
    api<AgentRecord>(`/v1/agents/${resolvedAgentId}`)
      .then((d) => {
        if (!cancelled) setAgent(d);
      })
      // A deleted/inaccessible agent must not blank the rail — the snapshot
      // fields on `meta` already cover the essentials.
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolvedAgentId]);

  useEffect(() => {
    if (!meta.environmentId) return;
    let cancelled = false;
    api<EnvironmentRecord>(`/v1/environments/${meta.environmentId}`)
      .then((d) => {
        if (!cancelled) setEnvironment(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta.environmentId]);

  const headline = useMemo(() => {
    const model = analytics.latestModel ?? modelIdOf(meta.agentSnapshot?.model);
    return model ?? "session";
  }, [analytics.latestModel, meta.agentSnapshot?.model]);

  return (
    <ResponsiveRail
      open
      onClose={onClose}
      title="Session inspector"
      label="Session inspector"
      desktopClassName="w-[360px] shrink-0 border-l border-border bg-bg-surface/30 flex flex-col min-h-0"
    >
      <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 py-3 flex items-start gap-3 shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-[10px] uppercase tracking-wide text-fg-subtle font-mono">
            Inspector
          </div>
          <div className="text-sm font-semibold text-fg truncate" title={headline}>
            {headline}
          </div>
        </div>
        <button
          onClick={onClose}
          className="text-fg-subtle hover:text-fg-muted text-lg leading-none inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-8 sm:min-h-8 rounded hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          title="Hide inspector"
          aria-label="Hide inspector"
        >
          ×
        </button>
      </div>

      <div role="tablist" aria-label="Inspector section" className="px-2 flex gap-0.5 shrink-0">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            onClick={() => onTabChange(t.id)}
            className={`px-2 py-1.5 text-xs rounded-md transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
              tab === t.id
                ? "bg-bg-surface text-fg font-medium"
                : "text-fg-subtle hover:text-fg-muted hover:bg-bg-surface/60"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4">
        {tab === "overview" && (
          <OverviewTab
            analytics={analytics}
            meta={meta}
            agent={agent}
            status={status}
            sandboxStatus={sandboxStatus}
            streaming={streaming}
            reasoningEffort={reasoningEffort}
          />
        )}
        {tab === "usage" && <UsageTab analytics={analytics} />}
        {tab === "tools" && <ToolsTab analytics={analytics} />}
        {tab === "sandbox" && (
          <SandboxTab meta={meta} environment={environment} sandboxStatus={sandboxStatus} />
        )}
        {tab === "files" && <FilesTab sessionId={sessionId} />}
      </div>
      </div>
    </ResponsiveRail>
  );
}

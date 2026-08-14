import { useEffect, useState } from "react";

import { useApi } from "../../lib/api";
import { useApiQuery } from "../../lib/useApiQuery";
import { Modal } from "../../components/Modal";
import { Button } from "@/components/ui/button";
import { McpServerPickerModal } from "../../components/McpServerPickerModal";
import { RuntimeInfo } from "../../components/RuntimeInfo";
import type { ModelCard } from "@duyet/oma-api-types";
import type { AgentRecord as Agent } from "../../types/agent";
import {
  AgentsTab,
  BasicTab,
  configToForm,
  formToConfig,
  INITIAL_FORM,
  McpTab,
  SkillsTab,
  syncRepoEnvironment,
  ToolsTab,
  type AgentFormDialogProps,
  type FormState,
} from "./AgentFormDialog";
import { DEFAULT_ENV_METADATA_KEY, isValidRepoUrl } from "./browser-env";

/** Map an API agent record back into the config shape `configToForm`
 *  understands (the same shape the create dialog's YAML/JSON paste mode
 *  parses). Model objects collapse to their id — speed isn't form-editable. */
function agentToConfig(a: Agent): Record<string, unknown> {
  return {
    name: a.name,
    model: typeof a.model === "string" ? a.model : a.model?.id,
    system: a.system ?? "",
    description: a.description ?? "",
    tools: a.tools,
    mcp_servers: a.mcp_servers,
    skills: a.skills,
    multiagent: a.multiagent,
    enable_general_subagent: (a as { enable_general_subagent?: boolean })
      .enable_general_subagent,
    _oma: a._oma,
  };
}

interface AgentEditDialogProps {
  open: boolean;
  onClose: () => void;
  agent: Agent;
  /** Called after a successful save so the parent can refetch. */
  onSaved: () => void;
}

/**
 * Edit dialog for an existing agent. Reuses the create dialog's tab
 * components (Basic / Tools / Skills / MCP / Multi-Agent) and its
 * form ⇄ config converters, plus edit-only fields the create form
 * doesn't expose (aux model, metadata). Saving PUTs the full config with
 * the read version for optimistic concurrency — the server mints a new
 * agent version; existing sessions keep theirs.
 */
export function AgentEditDialog({ open, onClose, agent, onSaved }: AgentEditDialogProps) {
  const { api } = useApi();

  const [form, setForm] = useState<FormState>({ ...INITIAL_FORM });
  const [auxModel, setAuxModel] = useState("");
  const [metadataText, setMetadataText] = useState("{}");
  const [tab, setTab] = useState<"basic" | "tools" | "skills" | "mcp" | "agents" | "runtime">(
    "basic",
  );
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [showMcpPicker, setShowMcpPicker] = useState(false);

  // Aux data the pickers need — fetched only while the dialog is open.
  const { data: mcRes } = useApiQuery<{ data: ModelCard[] }>(
    "/v1/model_cards?limit=200",
    undefined,
    { enabled: open },
  );
  const { data: rtRes } = useApiQuery<{ runtimes: AgentFormDialogProps["runtimes"] }>(
    "/v1/runtimes",
    undefined,
    { enabled: open },
  );
  const { data: agentsRes } = useApiQuery<{ data: Agent[] }>(
    "/v1/agents?limit=100",
    undefined,
    { enabled: open },
  );
  const { data: skillsRes } = useApiQuery<{
    data: Array<{ id: string; name: string; description: string }>;
  }>("/v1/skills", undefined, { enabled: open });

  const modelCards = mcRes?.data ?? [];
  const runtimes = rtRes?.runtimes ?? [];
  const allAgents = agentsRes?.data ?? [];
  const customSkills = skillsRes?.data ?? [];

  // Hydrate from the agent record each time the dialog opens (or the
  // record refreshes underneath it while closed).
  useEffect(() => {
    if (!open) return;
    setForm(configToForm(agentToConfig(agent)));
    setAuxModel(agent._oma?.aux_model?.id ?? "");
    setMetadataText(JSON.stringify(agent.metadata ?? {}, null, 2));
    setTab("basic");
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, agent.id, agent.version]);

  // configToForm only hydrates repoEnvId (an id, read straight off
  // metadata) — the URL/branch text fields live on the environment record
  // itself, so fetch it once we know which environment to look at.
  useEffect(() => {
    if (!open) return;
    const envId = form.repoEnvId;
    if (!envId) return;
    let cancelled = false;
    api<{ config?: { git_repo?: { url?: string; branch?: string } } }>(
      `/v1/environments/${envId}`,
    )
      .then((env) => {
        if (cancelled) return;
        const repo = env.config?.git_repo;
        if (!repo?.url) return;
        setForm((f) =>
          f.repoEnvId === envId
            ? { ...f, repoUrl: repo.url ?? "", repoBranch: repo.branch ?? "" }
            : f,
        );
      })
      .catch(() => {
        // Best-effort prefill only — an unreachable/deleted environment
        // just leaves the repo fields blank, same as a fresh agent.
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, form.repoEnvId]);

  const save = async () => {
    setError("");
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(metadataText || "{}");
      if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) {
        throw new Error("not an object");
      }
    } catch {
      setError("Metadata must be a JSON object.");
      setTab("basic");
      return;
    }

    setSaving(true);
    try {
      // Repo mode: mint or patch the environment carrying `config.git_repo`
      // before building the payload — an API call `formToConfig` (pure)
      // can't make itself. No-ops when repoUrl is empty.
      const resolvedForm = await syncRepoEnvironment(api, form);
      if (resolvedForm.repoEnvId !== form.repoEnvId) setForm(resolvedForm);
      const payload = formToConfig(resolvedForm);
      // Edit semantics differ from create: absent fields mean "keep", so
      // clearing a field needs an explicit value. Send the full state.
      payload.version = agent.version;
      payload.system = form.system || null;
      payload.description = form.description || null;
      payload.mcp_servers = form.mcpServers;
      payload.skills = form.skills;
      payload.multiagent = form.callableAgents.length
        ? { type: "coordinator", agents: form.callableAgents }
        : null;
      payload.metadata = resolvedForm.repoEnvId
        ? { ...metadata, [DEFAULT_ENV_METADATA_KEY]: resolvedForm.repoEnvId }
        : metadata;
      payload.enable_general_subagent = form.enableGeneralSubagent;
      const oma = (payload._oma ?? {}) as Record<string, unknown>;
      if (!oma.harness) oma.harness = form.harness;
      oma.aux_model = auxModel.trim() ? auxModel.trim() : null;
      payload._oma = oma;

      await api(`/v1/agents/${agent.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      });
      onSaved();
      onClose();
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to save agent");
    } finally {
      setSaving(false);
    }
  };

  const inputCls =
    "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";
  const tabCls = (t: string) =>
    `inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 text-sm rounded-md transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
      tab === t ? "bg-brand text-brand-fg" : "text-fg-muted hover:bg-bg-surface"
    }`;

  const selectedCardId =
    form.modelCardId || modelCards.find((mc) => mc.model_id === form.model)?.id || "";

  const addMcp = () =>
    setForm({ ...form, mcpServers: [...form.mcpServers, { name: "", type: "url", url: "" }] });
  const updateMcp = (i: number, field: "name" | "type" | "url", val: string) => {
    const updated = [...form.mcpServers];
    updated[i] = { ...updated[i], [field]: val };
    setForm({ ...form, mcpServers: updated });
  };
  const removeMcp = (i: number) =>
    setForm({ ...form, mcpServers: form.mcpServers.filter((_, j) => j !== i) });
  const addMcpFromRegistry = (entry: { id: string; name: string; url: string }) => {
    if (form.mcpServers.some((m) => m.url === entry.url)) return;
    setForm({
      ...form,
      mcpServers: [...form.mcpServers, { name: entry.id, type: "url", url: entry.url }],
    });
  };

  const toggleAnthropicSkill = (skillId: string) => {
    const exists = form.skills.find((s) => s.type === "anthropic" && s.skill_id === skillId);
    if (exists) {
      setForm({
        ...form,
        skills: form.skills.filter((s) => !(s.type === "anthropic" && s.skill_id === skillId)),
      });
    } else {
      setForm({
        ...form,
        skills: [...form.skills, { type: "anthropic", skill_id: skillId }],
      });
    }
  };

  const addCallable = (agentId: string) => {
    if (form.callableAgents.find((c) => c.id === agentId)) return;
    setForm({
      ...form,
      callableAgents: [...form.callableAgents, { type: "agent", id: agentId, version: 1 }],
    });
  };
  const removeCallable = (i: number) =>
    setForm({ ...form, callableAgents: form.callableAgents.filter((_, j) => j !== i) });

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={`Edit ${agent.name}`}
        subtitle={`Saving creates version v${agent.version + 1}; existing sessions keep v${agent.version}.`}
        maxWidth="max-w-2xl"
        footer={
          <div className="flex gap-2 justify-end w-full">
            <Button variant="ghost" onClick={onClose} disabled={saving}>
              Cancel
            </Button>
            <Button
              onClick={save}
              disabled={saving || !form.name || !isValidRepoUrl(form.repoUrl)}
            >
              {saving ? "Saving…" : "Save Changes"}
            </Button>
          </div>
        }
      >
        <div
          role="tablist"
          aria-label="Agent configuration sections"
          className="flex flex-wrap gap-1 mb-4"
        >
          {(
            [
              ["basic", "Basic"],
              ["tools", "Tools"],
              ["skills", "Skills"],
              ["mcp", "MCP Servers"],
              ["agents", "Multi-Agent"],
              ["runtime", "Runtime"],
            ] as const
          ).map(([t, label]) => (
            <button
              key={t}
              role="tab"
              aria-selected={tab === t}
              tabIndex={tab === t ? 0 : -1}
              onClick={() => setTab(t)}
              className={tabCls(t)}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "basic" && (
          <div className="space-y-3">
            <BasicTab
              form={form}
              setForm={setForm}
              createError={error}
              inputCls={inputCls}
              modelCards={modelCards}
              runtimes={runtimes}
              selectedCardId={selectedCardId}
            />
            <div>
              <label htmlFor="agent-aux-model" className="text-sm text-fg-muted block mb-1">
                Aux model
                <span className="ml-1 text-xs text-fg-subtle">(optional)</span>
              </label>
              <p className="text-xs text-fg-subtle mb-1">
                Auxiliary model used by tools for in-process LLM work (e.g. web_fetch page
                summarization). Leave empty to disable.
              </p>
              <input
                id="agent-aux-model"
                value={auxModel}
                onChange={(e) => setAuxModel(e.target.value)}
                className={inputCls}
                placeholder="claude-haiku-4-5"
              />
            </div>
            <div>
              <label htmlFor="agent-metadata" className="text-sm text-fg-muted block mb-1">
                Metadata
                <span className="ml-1 text-xs text-fg-subtle">(JSON object)</span>
              </label>
              <textarea
                id="agent-metadata"
                value={metadataText}
                onChange={(e) => setMetadataText(e.target.value)}
                rows={4}
                className={`${inputCls} resize-none font-mono text-xs leading-relaxed`}
                spellCheck={false}
              />
            </div>
          </div>
        )}

        {tab === "tools" && <ToolsTab form={form} setForm={setForm} createError={error} />}

        {tab === "skills" && (
          <SkillsTab
            form={form}
            setForm={setForm}
            customSkills={customSkills}
            toggleAnthropicSkill={toggleAnthropicSkill}
          />
        )}

        {tab === "mcp" && (
          <McpTab
            form={form}
            inputCls={inputCls}
            onPickFromRegistry={() => setShowMcpPicker(true)}
            addMcp={addMcp}
            updateMcp={updateMcp}
            removeMcp={removeMcp}
          />
        )}

        {tab === "agents" && (
          <AgentsTab
            form={form}
            setForm={setForm}
            allAgents={allAgents}
            addCallable={addCallable}
            removeCallable={removeCallable}
          />
        )}

        {tab === "runtime" && <RuntimeInfo harness={form.harness} />}

        {error && tab !== "basic" && tab !== "tools" && (
          <div className="mt-3 text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
            {error}
          </div>
        )}
      </Modal>

      <McpServerPickerModal
        open={showMcpPicker}
        onClose={() => setShowMcpPicker(false)}
        alreadyAddedUrls={form.mcpServers.map((m) => m.url)}
        onPick={addMcpFromRegistry}
      />
    </>
  );
}

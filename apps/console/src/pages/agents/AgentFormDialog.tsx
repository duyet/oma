import type { ComponentType, CSSProperties } from "react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import yaml from "js-yaml";
import {
  Sparkles,
  Search,
  Braces,
  Radar,
  Headset,
  Siren,
  Lightbulb,
  ClipboardList,
  Bug,
  ChartColumn,
  ListChecks,
  GitPullRequest,
  Eye,
  Wrench,
  ScrollText,
  Sprout,
  RefreshCw,
  Users,
} from "lucide-react";

import { useApi } from "../../lib/api";
import { Button } from "@/components/ui/button";
import { Select, SelectGroup, SelectGroupLabel, SelectOption } from "@/components/ui/form-select";
import { Combobox } from "../../components/Combobox";
import { McpServerPickerModal } from "../../components/McpServerPickerModal";
import { GitHubIcon, SlackIcon, LinearIcon } from "../../components/icons";
import { brandColor } from "@duyet/oma-fit-diagram";
import { AGENT_TEMPLATES, type AgentTemplate } from "../../data/templates";
import type { ModelCard } from "@duyet/oma-api-types";
import {
  KNOWN_ACP_AGENTS,
  resolveKnownAgent,
} from "@duyet/oma-acp-runtime/known-agents";
import type { AgentRecord as Agent } from "../../types/agent";
import { HarnessPicker } from "./HarnessPicker";
import { harnessOption } from "./harness-options";
import {
  DEFAULT_ENV_METADATA_KEY,
  browserVmEnvironments,
  isValidRepoUrl,
  newBrowserEnvironmentBody,
  repoEnvironmentBody,
  type EnvironmentLite,
} from "./browser-env";
import { useApiQuery } from "../../lib/useApiQuery";
import { RUNTIME_KINDS, RUNTIME_KIND_METADATA_KEY } from "../../lib/runtime-kind";
import { ModelProviderMark } from "../../lib/model-provider";

// ─── Template card presentation ───────────────────────────────────────────
// Maps a template's `icon` key (data/templates.ts) to its lucide glyph. The
// accent hex travels on the template itself; here we only resolve the shape.
type LucideGlyph = ComponentType<{ className?: string; strokeWidth?: number }>;

const TEMPLATE_ICONS: Record<string, LucideGlyph> = {
  sparkles: Sparkles,
  search: Search,
  braces: Braces,
  radar: Radar,
  headset: Headset,
  siren: Siren,
  lightbulb: Lightbulb,
  clipboard: ClipboardList,
  bug: Bug,
  chart: ChartColumn,
  listChecks: ListChecks,
  gitPullRequest: GitPullRequest,
  eye: Eye,
  wrench: Wrench,
  scrollText: ScrollText,
  sprout: Sprout,
  refresh: RefreshCw,
};

// Brand marks for integration tags. `Icon` renders the actual mark (colored
// via `color`); a bare `color` renders a colored dot. Colors are picked to
// stay legible on both light and dark surfaces — GitHub stays monochrome
// (its brand IS the silhouette) so it inherits the chip's text tone.
type BrandMark = ComponentType<{ className?: string }>;
const INTEGRATION_MARKS: Record<string, { Icon?: BrandMark; color?: string }> = {
  github: { Icon: GitHubIcon },
  slack: { Icon: SlackIcon, color: brandColor("slack") },
  linear: { Icon: LinearIcon, color: brandColor("linear") },
  sentry: { color: "#7B51F8" },
  asana: { color: "#F06A6A" },
  amplitude: { color: "#1E61F0" },
  intercom: { color: "#1F8DED" },
  atlassian: { color: "#2684FF" },
  notion: { color: "#9CA3AF" },
  docx: { color: "#2B579A" },
};

function TemplateGlyph({ icon, accent }: { icon: string; accent: string }) {
  const Glyph = TEMPLATE_ICONS[icon] ?? Sparkles;
  return (
    <span
      className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg"
      style={{
        color: accent,
        backgroundColor: `color-mix(in srgb, ${accent} 14%, transparent)`,
      }}
      aria-hidden="true"
    >
      <Glyph className="size-5" strokeWidth={1.75} />
    </span>
  );
}

function TagChip({ tag }: { tag: string }) {
  const mark = INTEGRATION_MARKS[tag.toLowerCase()];
  return (
    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-bg-surface text-fg-muted rounded text-[10px]">
      {mark?.Icon ? (
        <span
          className="inline-flex"
          style={mark.color ? { color: mark.color } : undefined}
        >
          <mark.Icon className="size-3" />
        </span>
      ) : mark?.color ? (
        <span
          className="size-1.5 shrink-0 rounded-full"
          style={{ backgroundColor: mark.color }}
          aria-hidden="true"
        />
      ) : null}
      {tag}
    </span>
  );
}

interface McpEntry {
  name: string;
  type: string;
  url: string;
}
interface SkillEntry {
  type: "anthropic" | "custom";
  skill_id: string;
  version?: string;
}
interface CallableEntry {
  type: "agent";
  id: string;
  version: number;
}

const ANTHROPIC_SKILLS = [
  { id: "xlsx", label: "Excel (xlsx)" },
  { id: "pdf", label: "PDF" },
  { id: "pptx", label: "PowerPoint (pptx)" },
  { id: "docx", label: "Word (docx)" },
];

// Model override for local ACP agents. A local ACP child has no OMA
// model-card concept of its own — we only offer ids the selected agent
// actually speaks (issue #183: no invented ids; issue #380: do not
// show Claude ids on a Grok/Codex/Gemini child).
interface AcpModelOption {
  value: string;
  label: string;
}

const CLAUDE_ACP_MODEL_OPTIONS: AcpModelOption[] = [
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4-6" },
  { value: "claude-haiku-4-5", label: "Claude Haiku 4-5" },
];

// Official xAI text/coding ids from https://docs.x.ai/developers/models
// (retrieved 2026-08-14). Do not invent slugs.
const GROK_ACP_MODEL_OPTIONS: AcpModelOption[] = [
  { value: "grok-4.6", label: "Grok 4.6" },
  { value: "grok-4.5", label: "Grok 4.5" },
  { value: "grok-4.3", label: "Grok 4.3" },
  { value: "grok-build-0.1", label: "Grok Build 0.1" },
];

/** Per-agent model-override list. Unknown / other ACP agents get an
 *  empty list so the picker stays on "Use daemon default" rather than
 *  offering Claude ids that the child will silently ignore. */
export function acpModelOptionsFor(acpAgentId: string): AcpModelOption[] {
  const canonical = resolveKnownAgent(acpAgentId)?.id ?? acpAgentId;
  if (canonical === "grok-build") return GROK_ACP_MODEL_OPTIONS;
  if (canonical === "claude-acp") return CLAUDE_ACP_MODEL_OPTIONS;
  return [];
}

/** Keep a model override only when the next ACP child actually speaks it.
 *  Used by every runtime/agent transition so a Grok id never serializes
 *  onto a Claude child (and vice versa). */
export function acpBindingFor(
  form: Pick<FormState, "acpModel">,
  acpAgentId: string,
): { acpAgentId: string; acpModel: string } {
  const allowed = new Set(acpModelOptionsFor(acpAgentId).map((o) => o.value));
  return {
    acpAgentId,
    acpModel: allowed.has(form.acpModel) ? form.acpModel : "",
  };
}

// Reasoning-effort override for local ACP agents. No canonical "reasoning"
// field exists elsewhere in OMA today — this mirrors the OpenAI/Codex
// reasoning_effort convention (codex-acp is the ACP agent most likely to
// honor it). Applied best-effort by the daemon via ACP's experimental
// session/set_config_option method, matched against whatever
// "thought_level" option the spawned ACP agent itself advertises — see
// https://github.com/duyet/oma/issues/269.
const ACP_REASONING_OPTIONS = [
  { value: "minimal", label: "Minimal" },
  { value: "low", label: "Low" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High" },
];

// AMA spec built-in tool names — must match
// `BetaManagedAgentsAgentToolConfig.name` enum in the SDK. Source of
// truth lives in the agent_toolset_20260401 toolset; emitting unknown
// names here would still validate at the API layer but produces a tool
// the runtime never wires.
const BUILTIN_TOOLS: Array<{ name: string; label: string; description: string }> = [
  { name: "bash", label: "bash", description: "Run shell commands in the sandbox" },
  { name: "edit", label: "edit", description: "In-place file edits" },
  { name: "read", label: "read", description: "Read files from the sandbox FS" },
  { name: "write", label: "write", description: "Create or overwrite files" },
  { name: "glob", label: "glob", description: "Pattern-match file paths" },
  { name: "grep", label: "grep", description: "Search file contents" },
  { name: "web_fetch", label: "web_fetch", description: "Fetch a URL → markdown. Default for any web read." },
  { name: "web_search", label: "web_search", description: "Web search via DuckDuckGo. Default for lookups." },
  { name: "browser", label: "browser (opt-in)", description: "Heavy multi-step browser session (navigate / click / screenshot). Off by default — LLMs over-reach for it on simple lookups. Enable only when you need interactive navigation, JS-rendered SPAs, or auth flows." },
];

type ToolOverride = "default" | "always_allow" | "always_ask" | "disabled";

/**
 * Serialize a form's tool-policy state into the AMA-shape `tools` array.
 * Always emits exactly one toolset entry of type `agent_toolset_20260401`;
 * per-tool overrides only land in `configs[]` when they differ from the
 * default. Module-level (pure) so the edit dialog can reuse it.
 */
export function buildToolsField(form: FormState) {
  const overrides = Object.entries(form.toolOverrides)
    .filter(([, v]) => v !== "default")
    .map(([name, v]) => {
      if (v === "disabled") return { name, enabled: false };
      return {
        name,
        enabled: true,
        permission_policy: { type: v as "always_allow" | "always_ask" },
      };
    });
  // AMA spec: each entry in mcp_servers gets a corresponding mcp_toolset
  // tool that references it by name. Surface them all as always_allow
  // by default — the user already opted in by adding the server.
  const mcpToolsets = form.mcpServers
    .filter((m) => m.name)
    .map((m) => ({
      type: "mcp_toolset" as const,
      mcp_server_name: m.name,
      default_config: { permission_policy: { type: "always_allow" as const } },
    }));
  return [
    {
      type: "agent_toolset_20260401",
      default_config: {
        enabled: form.toolDefaultEnabled,
        permission_policy: { type: form.toolDefaultPermission },
      },
      ...(overrides.length > 0 ? { configs: overrides } : {}),
    },
    ...mcpToolsets,
  ];
}

/**
 * Create or update the environment backing `form.repoUrl`/`repoBranch`, and
 * return the form patched with the resulting `repoEnvId` — or `form`
 * unchanged when `repoUrl` is empty. Both `create()` and the edit dialog's
 * `save()` call this before `formToConfig`, since minting/patching an
 * environment is an API call `formToConfig` (pure) can't make itself.
 */
export async function syncRepoEnvironment(
  api: <T>(path: string, init?: RequestInit) => Promise<T>,
  form: FormState,
): Promise<FormState> {
  if (!form.repoUrl) return form;
  const body = repoEnvironmentBody(form.repoUrl, form.repoBranch);
  const env = form.repoEnvId
    ? await api<{ id: string }>(`/v1/environments/${form.repoEnvId}`, {
        method: "PUT",
        body: JSON.stringify(body),
      })
    : await api<{ id: string }>("/v1/environments", {
        method: "POST",
        body: JSON.stringify(body),
      });
  return { ...form, repoEnvId: env.id };
}

/** Convert a form state to an agent config payload (create/update body). */
export function formToConfig(form: FormState) {
  const config: Record<string, unknown> = {
    name: form.name,
    model: form.model,
  };
  if (form.system) config.system = form.system;
  if (form.description) config.description = form.description;
  config.tools = buildToolsField(form);
  if (form.mcpServers.length) config.mcp_servers = form.mcpServers;
  if (form.skills.length) config.skills = form.skills;
  if (form.callableAgents.length) {
    config.multiagent = { type: "coordinator", agents: form.callableAgents };
  }
  if (form.enableGeneralSubagent) {
    config.enable_general_subagent = true;
  }
  if (form.runtimeId && form.acpAgentId) {
    config._oma = {
      harness: "acp-proxy",
      runtime_binding: {
        runtime_id: form.runtimeId,
        acp_agent_id: form.acpAgentId,
        ...(form.localSkillBlocklist.length > 0
          ? { local_skill_blocklist: form.localSkillBlocklist }
          : {}),
        ...(form.acpModel ? { model: form.acpModel } : {}),
        ...(form.acpReasoningEffort ? { reasoning_effort: form.acpReasoningEffort } : {}),
        ...(form.workingDir ? { working_dir: form.workingDir } : {}),
        ...(form.worktreeBranch
          ? { worktree: { branch: form.worktreeBranch } }
          : form.branch
            ? { branch: form.branch }
            : {}),
      },
    };
  } else if (form.harness !== "default") {
    config._oma = { harness: form.harness };
  }
  // Browser runtime: not a harness, a sandbox provider. The agent records
  // which browser-vm environment its sessions should start on; the harness
  // above is untouched.
  if (form.browserEnvId) {
    config.metadata = {
      [DEFAULT_ENV_METADATA_KEY]: form.browserEnvId,
      // Explicit marker: which sandbox provider an environment uses isn't
      // knowable from an agent row alone, so every surface that renders the
      // runtime kind would otherwise need the environment list.
      [RUNTIME_KIND_METADATA_KEY]: "browser",
    };
  } else if (form.repoEnvId) {
    // Repo mode: the environment carrying `config.git_repo` must already
    // exist (created/updated by the submit handler before this runs, since
    // that's an async API call this pure function can't make) — same
    // metadata.default_environment_id field browser mode uses, minus the
    // runtime-kind marker since it's still a plain cloud sandbox.
    config.metadata = { [DEFAULT_ENV_METADATA_KEY]: form.repoEnvId };
  }
  return config;
}

/**
 * Best-effort inverse of `formToConfig` — hydrate a form state from an
 * agent config object (pasted YAML/JSON, or an existing agent record for
 * the edit dialog). Custom tools and MCP toolsets pass through untouched
 * in code view but can't be edited in the Form view.
 */
export function configToForm(parsed: Record<string, unknown>): FormState {
  const oma = parsed._oma as
    | {
        harness?: string;
        runtime_binding?: {
          runtime_id?: string;
          acp_agent_id?: string;
          local_skill_blocklist?: string[];
          model?: string;
          reasoning_effort?: string;
          working_dir?: string;
          branch?: string;
          worktree?: { branch: string };
        };
      }
    | undefined;
  const rb = oma?.runtime_binding;
  const toolset = Array.isArray(parsed.tools)
    ? (parsed.tools as Array<Record<string, unknown>>).find(
        (t) => t?.type === "agent_toolset_20260401",
      )
    : undefined;
  const dc = (toolset?.default_config ?? {}) as {
    enabled?: boolean;
    permission_policy?: { type?: string };
  };
  const cfgs = (toolset?.configs ?? []) as Array<{
    name?: string;
    enabled?: boolean;
    permission_policy?: { type?: string };
  }>;
  const overrides: Record<string, ToolOverride> = {};
  for (const c of cfgs) {
    if (!c?.name) continue;
    if (c.enabled === false) overrides[c.name] = "disabled";
    else if (c.permission_policy?.type === "always_ask") overrides[c.name] = "always_ask";
    else if (c.permission_policy?.type === "always_allow") overrides[c.name] = "always_allow";
  }
  const multiagent = parsed.multiagent as { agents?: unknown[] } | null | undefined;
  return {
    ...INITIAL_FORM,
    name: String(parsed.name || ""),
    // Paste-mode fallback: if the pasted config has no model field,
    // claude-sonnet-4-6 is a real, current Anthropic model id (not
    // a placeholder), so it's a reasonable default. The form
    // dropdown does its own dynamic option set from modelCards.
    model: String(parsed.model || "claude-sonnet-4-6"),
    system: String(parsed.system || ""),
    description: String(parsed.description || ""),
    mcpServers: Array.isArray(parsed.mcp_servers)
      ? (parsed.mcp_servers as McpEntry[])
      : [],
    skills: Array.isArray(parsed.skills) ? (parsed.skills as SkillEntry[]) : [],
    callableAgents: Array.isArray(multiagent?.agents)
      ? (multiagent.agents as CallableEntry[])
      : [],
    runtimeId: rb?.runtime_id ?? "",
    acpAgentId: rb?.acp_agent_id ?? "claude-agent-acp",
    browserEnvId: (() => {
      const meta = parsed.metadata as Record<string, unknown> | undefined;
      if (meta?.[RUNTIME_KIND_METADATA_KEY] !== "browser") return "";
      const id = meta?.[DEFAULT_ENV_METADATA_KEY];
      return typeof id === "string" ? id : "";
    })(),
    // The repo-carrying environment's id, when the default environment
    // isn't the browser-vm one — repoUrl/repoBranch text fields are
    // hydrated separately (async, from the environment record) by whatever
    // host has the environments list, since this converter is pure.
    repoEnvId: (() => {
      const meta = parsed.metadata as Record<string, unknown> | undefined;
      if (meta?.[RUNTIME_KIND_METADATA_KEY] === "browser") return "";
      const id = meta?.[DEFAULT_ENV_METADATA_KEY];
      return typeof id === "string" ? id : "";
    })(),
    repoUrl: "",
    repoBranch: "",
    // Preserve whatever the agent already declares, including harnesses the
    // picker no longer offers — editing an agent must never rewrite it. A
    // config with no `_oma.harness` really is the server default.
    harness: oma?.harness && oma.harness !== "acp-proxy" ? oma.harness : "default",
    localSkillBlocklist: Array.isArray(rb?.local_skill_blocklist)
      ? rb.local_skill_blocklist
      : [],
    acpModel: rb?.model ?? "",
    acpReasoningEffort: rb?.reasoning_effort ?? "",
    workingDir: rb?.working_dir ?? "",
    branch: rb?.branch ?? "",
    worktreeBranch: rb?.worktree?.branch ?? "",
    toolDefaultEnabled: dc.enabled ?? true,
    toolDefaultPermission:
      dc.permission_policy?.type === "always_ask" ? "always_ask" : "always_allow",
    toolOverrides: overrides,
    enableGeneralSubagent: parsed.enable_general_subagent === true,
  };
}

export const INITIAL_FORM = {
  name: "",
  model: "",
  system: "",
  description: "",
  modelCardId: "",
  mcpServers: [] as McpEntry[],
  skills: [] as SkillEntry[],
  callableAgents: [] as CallableEntry[],
  // When set, agent uses harness:"acp-proxy" — its loop runs on a user-
  // registered local runtime via `oma bridge daemon` instead of OMA's cloud
  // SessionDO loop. Both fields must be set together; partial = fall back to
  // default cloud agent.
  runtimeId: "",
  acpAgentId: "claude-agent-acp",
  // When set, the agent runs in Browser mode: its sessions default to this
  // browser-vm environment. Mutually exclusive with runtimeId in the UI.
  browserEnvId: "",
  // Optional repo to auto-clone into /workspace on every session (Cloud
  // mode only). On save, these back a dedicated environment carrying
  // `config.git_repo`, set as the agent's default environment via
  // metadata.default_environment_id — see browser-env.ts. repoEnvId tracks
  // that environment's id once created, so editing updates it in place
  // instead of leaking a new environment per save.
  repoUrl: "",
  repoBranch: "",
  repoEnvId: "",
  // Cloud harness — ignored (implicitly "acp-proxy") whenever runtimeId is
  // set. "default" emits no _oma.harness at all (server default) and is the
  // create default so Cloudflare Console agents get a loop that works there.
  // Claude Agent SDK remains a first-class picker option for self-host.
  harness: "default" as string,
  /** Local skill ids to HIDE from this agent's ACP child. Empty = all
   *  detected local skills are visible (the daemon's default). */
  localSkillBlocklist: [] as string[],
  /** Optional model override forwarded in runtime_binding.model. Empty =
   *  inherit whatever the daemon-fetched bundle / ACP child's own config
   *  resolves. Applied best-effort by the daemon via ACP's experimental
   *  session/set_model method — no-op for ACP agents that don't advertise
   *  model selection. See https://github.com/duyet/oma/issues/269. */
  acpModel: "",
  /** Optional reasoning-effort override forwarded in
   *  runtime_binding.reasoning_effort. Same best-effort caveat as
   *  acpModel, via ACP's session/set_config_option ("thought_level"). */
  acpReasoningEffort: "",
  /** Optional: absolute path to a project on the paired machine, forwarded
   *  in runtime_binding.working_dir. Empty = the daemon's synthetic
   *  per-session directory (default, unchanged behavior). */
  workingDir: "",
  /** Optional: git branch to check out in workingDir before spawning,
   *  forwarded in runtime_binding.branch. Mutually exclusive with
   *  worktreeBranch (worktreeBranch wins if both are set). */
  branch: "",
  /** Optional: instead of checking out branch in place, create a git
   *  worktree from this branch and use it as cwd, forwarded in
   *  runtime_binding.worktree.branch. Takes precedence over branch. */
  worktreeBranch: "",
  // Built-in tool policy. `agent_toolset_20260401` toolset's
  // `default_config` controls fallback enabled/permission for any
  // tool without a specific override. `toolOverrides` is a per-tool
  // 4-state: "default" (no entry emitted in configs[]), "always_allow",
  // "always_ask", or "disabled" (enabled=false).
  toolDefaultEnabled: true,
  toolDefaultPermission: "always_allow" as "always_allow" | "always_ask",
  toolOverrides: {} as Record<string, ToolOverride>,
  // Opt-in to the built-in `general_subagent` tool.
  enableGeneralSubagent: false,
};

/** Runtime roster shape the form's Local-runtime pickers consume. */
export type FormRuntime = {
  id: string;
  hostname: string;
  status: string;
  agents: Array<{ id: string }>;
  local_skills?: Record<
    string,
    Array<{ id: string; name?: string; description?: string; source?: string; source_label?: string }>
  >;
};

/** Data sets shared by every host of the create form (dialog + page). */
export interface AgentCreateFormData {
  allAgents: Agent[];
  customSkills: Array<{ id: string; name: string; description: string }>;
  modelCards: ModelCard[];
  runtimes: FormRuntime[];
}

export interface AgentFormDialogProps extends AgentCreateFormData {
  open: boolean;
  onClose: () => void;
  /** Called after the agent is created successfully. Parent uses this
   *  to refresh the list. The dialog handles its own navigation to the
   *  new agent's detail page. */
  onCreated?: () => void;
}

interface AgentCreateFormProps extends AgentCreateFormData {
  /** "dialog" wraps the flow in the modal box chrome; "page" renders it
   *  bare for the full-page `/agents/new` route. The two share every bit
   *  of state and markup below — only the outer container differs. */
  variant: "dialog" | "page";
  /** Cancel affordance — closes the dialog / navigates away from the page. */
  onCancel: () => void;
  onCreated?: () => void;
  /** Forwarded onto the form's root element so the dialog host can run its
   *  focus trap against it. Unused by the page host. */
  rootRef?: React.RefObject<HTMLDivElement | null>;
}

/**
 * The New Agent create flow — multi-step (template → form) with three
 * editor modes (form / yaml / json). Owns all of its own state — `form`,
 * `createStep`, `createMode`, etc. — and is rendered in two places from a
 * single implementation: inside `AgentFormDialog` (modal) and on the
 * `/agents/new` full page (`AgentBuilder`). The `variant` prop only swaps
 * the outer container so the two stay byte-identical everywhere else.
 */
export function AgentCreateForm({
  variant,
  onCancel,
  onCreated,
  rootRef,
  allAgents,
  customSkills,
  modelCards,
  runtimes,
}: AgentCreateFormProps) {
  const { api } = useApi();
  const nav = useNavigate();

  const [createError, setCreateError] = useState("");
  const [createStep, setCreateStep] = useState<"template" | "form">("template");
  const [templateSearch, setTemplateSearch] = useState("");
  const [form, setForm] = useState({ ...INITIAL_FORM });
  const [tab, setTab] = useState<"basic" | "tools" | "skills" | "mcp" | "agents">("basic");
  const [createMode, setCreateMode] = useState<"form" | "yaml" | "json">("form");
  const [codeValue, setCodeValue] = useState("");
  const [showMcpPicker, setShowMcpPicker] = useState(false);

  const createPreviousFocus = useRef<HTMLElement | null>(null);
  const isDialog = variant === "dialog";

  // Pre-select default model card when entering the form step. (tenant_id,
  // model_id) is UNIQUE in DB, so picking a card uniquely determines the
  // model. Skip if user/paste already set model. Re-runs when modelCards
  // arrives if the dialog opened before the aux fetch.
  useEffect(() => {
    if (createStep !== "form") return;
    if (form.modelCardId || form.model) return;
    if (modelCards.length === 0) return;
    const def = modelCards.find((mc) => mc.is_default) ?? modelCards[0];
    setForm((f) => ({ ...f, modelCardId: def.id, model: def.model_id }));
    // Intentionally not depending on form.* — guards above prevent the
    // re-trigger loop and we only want to hydrate on step entry / cards arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [createStep, modelCards.length]);

  const closeCreate = () => {
    setCreateStep("template");
    setTemplateSearch("");
    setForm({ ...INITIAL_FORM });
    setTab("basic");
    setCreateError("");
    setCreateMode("form");
    setCodeValue("");
    onCancel();
  };

  // Dialog a11y — focus trap + Escape, scroll lock, focus restore on close.
  // Mirrors components/Modal.tsx behavior so this hand-rolled multi-step
  // dialog is keyboard-equivalent. Page variant skips all of this (it's a
  // normal route, not a modal).
  useEffect(() => {
    if (!isDialog) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        closeCreate();
        return;
      }
      if (e.key !== "Tab") return;
      const el = rootRef?.current;
      if (!el) return;
      const f = el.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        last.focus();
        e.preventDefault();
      } else if (!e.shiftKey && document.activeElement === last) {
        first.focus();
        e.preventDefault();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // closeCreate is stable enough — deps kept tight to avoid re-binding
    // on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isDialog]);

  useEffect(() => {
    if (!isDialog) return;
    createPreviousFocus.current = document.activeElement as HTMLElement;
    const el = rootRef?.current;
    el?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )?.focus();
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
      createPreviousFocus.current?.focus();
    };
  }, [isDialog]);

  const create = async () => {
    setCreateError("");
    try {
      const resolvedForm = await syncRepoEnvironment(api, form);
      const payload: Record<string, unknown> = {
        name: resolvedForm.name,
        model: resolvedForm.model,
        system: resolvedForm.system || undefined,
        description: resolvedForm.description || undefined,
        tools: buildToolsField(resolvedForm),
      };
      if (form.mcpServers.length) payload.mcp_servers = form.mcpServers;
      if (form.skills.length) payload.skills = form.skills;
      if (form.callableAgents.length) {
        payload.multiagent = { type: "coordinator", agents: form.callableAgents };
      }
      if (form.enableGeneralSubagent) {
        payload.enable_general_subagent = true;
      }
      // Local-runtime agent: opt into acp-proxy harness when both runtimeId
      // and acpAgentId are set. Partial config silently falls back to the
      // default cloud loop — same semantics as the CLI flag pair. Wins over
      // the plain harness picker below — a runtime binding always implies
      // acp-proxy regardless of what was selected before it was picked.
      if (form.runtimeId && form.acpAgentId) {
        payload._oma = {
          harness: "acp-proxy",
          runtime_binding: {
            runtime_id: form.runtimeId,
            acp_agent_id: form.acpAgentId,
            ...(form.localSkillBlocklist.length > 0
              ? { local_skill_blocklist: form.localSkillBlocklist }
              : {}),
            ...(form.acpModel ? { model: form.acpModel } : {}),
            ...(form.acpReasoningEffort ? { reasoning_effort: form.acpReasoningEffort } : {}),
            ...(form.workingDir ? { working_dir: form.workingDir } : {}),
            ...(form.worktreeBranch
              ? { worktree: { branch: form.worktreeBranch } }
              : form.branch
                ? { branch: form.branch }
                : {}),
          },
        };
      } else if (form.harness !== "default") {
        payload._oma = { harness: form.harness };
      }
      if (form.browserEnvId) {
        payload.metadata = {
          [DEFAULT_ENV_METADATA_KEY]: form.browserEnvId,
          [RUNTIME_KIND_METADATA_KEY]: "browser",
        };
      } else if (resolvedForm.repoEnvId) {
        payload.metadata = { [DEFAULT_ENV_METADATA_KEY]: resolvedForm.repoEnvId };
      }

      const agent = await api<Agent>("/v1/agents", {
        method: "POST",
        body: JSON.stringify(payload),
      });
      closeCreate();
      onCreated?.();
      nav(`/agents/${agent.id}`);
    } catch (e: any) {
      setCreateError(e?.message || "Failed to create agent");
    }
  };

  const addMcp = () =>
    setForm({ ...form, mcpServers: [...form.mcpServers, { name: "", type: "url", url: "" }] });
  const addMcpFromRegistry = (entry: { id: string; name: string; url: string }) => {
    if (form.mcpServers.some((m) => m.url === entry.url)) return;
    setForm({
      ...form,
      // AMA remote servers use type "url" (streamable HTTP / SSE) — see docs/mcp-servers.md.
      mcpServers: [...form.mcpServers, { name: entry.id, type: "url", url: entry.url }],
    });
  };
  const updateMcp = (i: number, field: keyof McpEntry, val: string) => {
    const updated = [...form.mcpServers];
    updated[i] = { ...updated[i], [field]: val };
    setForm({ ...form, mcpServers: updated });
  };
  const removeMcp = (i: number) =>
    setForm({ ...form, mcpServers: form.mcpServers.filter((_, j) => j !== i) });

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

  const selectTemplate = (tmpl: AgentTemplate) => {
    if (tmpl.id === "blank") {
      setForm({ ...INITIAL_FORM });
    } else {
      setForm({
        ...INITIAL_FORM,
        name: tmpl.name,
        model: tmpl.model,
        system: tmpl.system,
        description: tmpl.description,
        mcpServers: tmpl.mcpServers.map((m) => ({ ...m })),
        skills: tmpl.skills.map((s) => ({ ...s } as SkillEntry)),
      });
    }
    setCreateStep("form");
    setTab("basic");
  };

  // Switch between form/yaml/json modes
  const switchMode = (mode: "form" | "yaml" | "json") => {
    if (mode === createMode) return;
    if (createMode === "form") {
      // form → code: serialize current form
      const config = formToConfig(form);
      setCodeValue(
        mode === "yaml" ? yaml.dump(config, { lineWidth: -1 }) : JSON.stringify(config, null, 2),
      );
    } else if (mode === "form") {
      // code → form: try to parse back (best-effort, may lose data)
      try {
        const parsed =
          createMode === "yaml"
            ? (yaml.load(codeValue) as Record<string, unknown>)
            : JSON.parse(codeValue);
        setForm(configToForm(parsed));
      } catch {
        /* keep current form if parse fails */
      }
    } else {
      // yaml ↔ json: convert between formats
      try {
        const parsed = createMode === "yaml" ? yaml.load(codeValue) : JSON.parse(codeValue);
        setCodeValue(
          mode === "yaml"
            ? yaml.dump(parsed, { lineWidth: -1 })
            : JSON.stringify(parsed, null, 2),
        );
      } catch {
        /* keep current value if parse fails */
      }
    }
    setCreateMode(mode);
  };

  // Create agent from code editor
  const createFromCode = async () => {
    setCreateError("");
    try {
      const parsed =
        createMode === "yaml"
          ? (yaml.load(codeValue) as Record<string, unknown>)
          : JSON.parse(codeValue);
      if (!parsed.name) {
        setCreateError("name is required");
        return;
      }
      if (!parsed.tools) parsed.tools = [{ type: "agent_toolset_20260401" }];
      const agent = await api<Agent>("/v1/agents", {
        method: "POST",
        body: JSON.stringify(parsed),
      });
      closeCreate();
      onCreated?.();
      nav(`/agents/${agent.id}`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Invalid config";
      setCreateError(msg);
    }
  };

  const filteredTemplates = templateSearch
    ? AGENT_TEMPLATES.filter(
        (t) =>
          t.name.toLowerCase().includes(templateSearch.toLowerCase()) ||
          t.description.toLowerCase().includes(templateSearch.toLowerCase()) ||
          t.tags.some((tag) => tag.toLowerCase().includes(templateSearch.toLowerCase())),
      )
    : AGENT_TEMPLATES;

  const inputCls =
    "w-full border border-border rounded-md px-3 py-2 min-h-11 sm:min-h-0 text-sm bg-bg text-fg outline-none focus:border-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] placeholder:text-fg-subtle";
  const tabCls = (t: string) =>
    `inline-flex items-center justify-center px-3 py-1.5 min-h-11 sm:min-h-0 text-sm rounded-md transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
      tab === t ? "bg-brand text-brand-fg" : "text-fg-muted hover:bg-bg-surface"
    }`;

  // Resolve which card the Model dropdown should highlight: explicit pick
  // wins, otherwise derive from model_id (paste path / pre-select effect).
  // Empty string when nothing matches (e.g. paste mode with an unknown model).
  const selectedCardId =
    form.modelCardId || modelCards.find((mc) => mc.model_id === form.model)?.id || "";

  // Outer box classes. Dialog = the modal card (width driven by step);
  // page = a plain full-width column (the route provides max-width + padding).
  const boxCls = isDialog
    ? `bg-bg rounded-lg shadow-xl w-full max-h-[85vh] flex flex-col ${
        createStep === "template"
          ? "max-w-2xl md:max-w-3xl xl:max-w-5xl"
          : "max-w-2xl"
      }`
    : "w-full flex flex-col";

  return (
    <>
      <MaybeOverlay isDialog={isDialog} onBackdrop={closeCreate}>
        <div
          ref={rootRef}
          role={isDialog ? "dialog" : undefined}
          aria-modal={isDialog ? true : undefined}
          aria-label={isDialog ? "New Agent" : undefined}
          className={boxCls}
          onClick={isDialog ? (e) => e.stopPropagation() : undefined}
        >
          {/* Template selection step */}
          {createStep === "template" && (
            <>
              <div className="px-6 pt-6 pb-4 border-b border-border">
                <h2 className="font-display text-lg font-semibold text-fg">New Agent</h2>
                <p className="text-sm text-fg-muted mt-1">
                  Start from a template or build from scratch.
                </p>
                <input
                  value={templateSearch}
                  onChange={(e) => setTemplateSearch(e.target.value)}
                  className={`${inputCls} mt-3`}
                  placeholder="Search templates..."
                  aria-label="Search templates"
                />
              </div>
              <div className="flex-1 overflow-y-auto px-6 py-4">
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
                  {filteredTemplates.map((tmpl) => (
                    <button
                      key={tmpl.id}
                      onClick={() => selectTemplate(tmpl)}
                      style={{ "--accent": tmpl.accent } as CSSProperties}
                      className="group flex flex-col text-left border border-border rounded-lg p-4 min-h-11 hover:border-[var(--accent)] hover:bg-bg-surface transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                    >
                      <div className="flex items-start gap-3">
                        <TemplateGlyph icon={tmpl.icon} accent={tmpl.accent} />
                        <div className="min-w-0">
                          <div className="font-medium text-sm text-fg">{tmpl.name}</div>
                          <div className="text-xs text-fg-muted mt-1 line-clamp-2">
                            {tmpl.description}
                          </div>
                        </div>
                      </div>
                      {(tmpl.tags.length > 0 || tmpl.subAgents) && (
                        <div className="flex flex-wrap gap-1 mt-3">
                          {/* Multi-agent marker — this template's prompt is
                              written to coordinate a sub-agent roster; hover
                              lists the suggested roles. The user wires real
                              agents via callable_agents after creation. */}
                          {tmpl.subAgents && (
                            <span
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px]"
                              style={{
                                color: tmpl.accent,
                                backgroundColor: `color-mix(in srgb, ${tmpl.accent} 12%, transparent)`,
                              }}
                              title={tmpl.subAgents.map((s) => `${s.name} — ${s.role}`).join("\n")}
                            >
                              <Users className="size-3" />
                              {tmpl.subAgents.map((s) => s.name).join(" + ")}
                            </span>
                          )}
                          {tmpl.tags.map((tag) => (
                            <TagChip key={tag} tag={tag} />
                          ))}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
                {filteredTemplates.length === 0 && (
                  <div className="text-center py-8 text-fg-subtle text-sm">
                    No templates match your search.
                  </div>
                )}
              </div>
              <div className="px-6 py-4 border-t border-border flex justify-end">
                <button
                  onClick={closeCreate}
                  className="inline-flex items-center min-h-11 sm:min-h-0 px-4 py-2 text-sm text-fg-muted hover:text-fg"
                >
                  Cancel
                </button>
              </div>
            </>
          )}

          {/* Form step */}
          {createStep === "form" && (
            <>
              <div className="px-6 pt-6 pb-4 border-b border-border">
                <div className="flex items-center justify-between mb-1">
                  <button
                    onClick={() => {
                      setCreateStep("template");
                      setTemplateSearch("");
                      setCreateMode("form");
                    }}
                    className="inline-flex items-center min-h-11 sm:min-h-0 text-sm text-fg-subtle hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
                  >
                    &larr; Templates
                  </button>
                  <div className="flex items-center gap-0.5 bg-bg-surface rounded-md p-0.5">
                    {(["form", "yaml", "json"] as const).map((m) => (
                      <button
                        key={m}
                        onClick={() => switchMode(m)}
                        className={`inline-flex items-center justify-center px-2 py-1 min-h-11 sm:min-h-0 text-xs rounded transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                          createMode === m
                            ? "bg-bg text-fg font-medium shadow-sm"
                            : "text-fg-muted hover:text-fg"
                        }`}
                      >
                        {m === "form" ? "Form" : m.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>
                <h2 className="font-display text-lg font-semibold text-fg">New Agent</h2>
                {createMode === "form" && (
                  <div
                    role="tablist"
                    aria-label="Agent configuration sections"
                    className="flex gap-1 mt-3"
                  >
                    <button
                      role="tab"
                      aria-selected={tab === "basic"}
                      tabIndex={tab === "basic" ? 0 : -1}
                      onClick={() => setTab("basic")}
                      className={tabCls("basic")}
                    >
                      Basic
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "tools"}
                      tabIndex={tab === "tools" ? 0 : -1}
                      onClick={() => setTab("tools")}
                      className={tabCls("tools")}
                    >
                      Tools{" "}
                      {Object.keys(form.toolOverrides).length > 0 && (
                        <span className="ml-1 text-xs opacity-60">
                          ({Object.keys(form.toolOverrides).length})
                        </span>
                      )}
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "skills"}
                      tabIndex={tab === "skills" ? 0 : -1}
                      onClick={() => setTab("skills")}
                      className={tabCls("skills")}
                    >
                      Skills{" "}
                      {form.skills.length > 0 && (
                        <span className="ml-1 text-xs opacity-60">({form.skills.length})</span>
                      )}
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "mcp"}
                      tabIndex={tab === "mcp" ? 0 : -1}
                      onClick={() => setTab("mcp")}
                      className={tabCls("mcp")}
                    >
                      MCP Servers{" "}
                      {form.mcpServers.length > 0 && (
                        <span className="ml-1 text-xs opacity-60">
                          ({form.mcpServers.length})
                        </span>
                      )}
                    </button>
                    <button
                      role="tab"
                      aria-selected={tab === "agents"}
                      tabIndex={tab === "agents" ? 0 : -1}
                      onClick={() => setTab("agents")}
                      className={tabCls("agents")}
                    >
                      Multi-Agent{" "}
                      {form.callableAgents.length > 0 && (
                        <span className="ml-1 text-xs opacity-60">
                          ({form.callableAgents.length})
                        </span>
                      )}
                    </button>
                  </div>
                )}
              </div>

              <div className="flex-1 overflow-y-auto px-6 py-4">
                {/* Code editor mode (YAML/JSON) */}
                {createMode !== "form" && (
                  <div className="space-y-3 h-full flex flex-col">
                    {createError && (
                      <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
                        {createError}
                      </div>
                    )}
                    <textarea
                      value={codeValue}
                      onChange={(e) => setCodeValue(e.target.value)}
                      className={`${inputCls} flex-1 resize-none font-mono text-xs leading-relaxed ${
                        isDialog ? "min-h-[300px]" : "min-h-[calc(100vh-15rem)]"
                      }`}
                      spellCheck={false}
                    />
                  </div>
                )}
                {/* Form mode */}
                {createMode === "form" && tab === "basic" && (
                  <BasicTab
                    form={form}
                    setForm={setForm}
                    createError={createError}
                    inputCls={inputCls}
                    modelCards={modelCards}
                    runtimes={runtimes}
                    selectedCardId={selectedCardId}
                  />
                )}

                {createMode === "form" && tab === "tools" && (
                  <ToolsTab form={form} setForm={setForm} createError={createError} />
                )}

                {createMode === "form" && tab === "skills" && (
                  <SkillsTab
                    form={form}
                    setForm={setForm}
                    customSkills={customSkills}
                    toggleAnthropicSkill={toggleAnthropicSkill}
                  />
                )}

                {createMode === "form" && tab === "mcp" && (
                  <McpTab
                    form={form}
                    inputCls={inputCls}
                    onPickFromRegistry={() => setShowMcpPicker(true)}
                    addMcp={addMcp}
                    updateMcp={updateMcp}
                    removeMcp={removeMcp}
                  />
                )}

                {createMode === "form" && tab === "agents" && (
                  <AgentsTab
                    form={form}
                    setForm={setForm}
                    allAgents={allAgents}
                    addCallable={addCallable}
                    removeCallable={removeCallable}
                  />
                )}
              </div>

              <div className="px-6 py-4 border-t border-border flex justify-between items-center">
                <div className="text-xs text-fg-subtle">
                  {createMode === "form" && (
                    <>
                      {form.skills.length > 0 && (
                        <span className="mr-3">{form.skills.length} skills</span>
                      )}
                      {form.mcpServers.length > 0 && (
                        <span className="mr-3">{form.mcpServers.length} MCP</span>
                      )}
                      {form.callableAgents.length > 0 && (
                        <span>{form.callableAgents.length} agents</span>
                      )}
                    </>
                  )}
                  {createMode !== "form" && <span>{createMode.toUpperCase()} editor</span>}
                </div>
                <div className="flex gap-2">
                  <Button variant="ghost" onClick={closeCreate}>
                    Cancel
                  </Button>
                  {createMode === "form" ? (
                    <Button
                      onClick={create}
                      disabled={!form.name || !isValidRepoUrl(form.repoUrl)}
                    >
                      Create Agent
                    </Button>
                  ) : (
                    <Button onClick={createFromCode} disabled={!codeValue.trim()}>
                      Create Agent
                    </Button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      </MaybeOverlay>

      {/* MCP server registry picker — same MCP_REGISTRY the vault page uses */}
      <McpServerPickerModal
        open={showMcpPicker}
        onClose={() => setShowMcpPicker(false)}
        alreadyAddedUrls={form.mcpServers.map((m) => m.url)}
        onPick={addMcpFromRegistry}
      />
    </>
  );
}

/** Wraps the create flow in the modal backdrop for the dialog variant; a
 *  pass-through for the page variant. */
function MaybeOverlay({
  isDialog,
  onBackdrop,
  children,
}: {
  isDialog: boolean;
  onBackdrop: () => void;
  children: React.ReactNode;
}) {
  if (!isDialog) return <>{children}</>;
  return (
    <div
      className="fixed inset-0 bg-bg-overlay flex items-center justify-center z-50"
      onClick={onBackdrop}
    >
      {children}
    </div>
  );
}

/**
 * Create-agent dialog. A thin modal host around `AgentCreateForm` — mounts
 * it only while `open`, so the form's internal state resets cleanly on every
 * open. `AgentBuilder` renders the same `AgentCreateForm` with
 * `variant="page"` for the `/agents/new` full-page route.
 */
export function AgentFormDialog({
  open,
  onClose,
  onCreated,
  allAgents,
  customSkills,
  modelCards,
  runtimes,
}: AgentFormDialogProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  if (!open) return null;
  return (
    <AgentCreateForm
      variant="dialog"
      onCancel={onClose}
      onCreated={onCreated}
      rootRef={rootRef}
      allAgents={allAgents}
      customSkills={customSkills}
      modelCards={modelCards}
      runtimes={runtimes}
    />
  );
}

export type FormState = typeof INITIAL_FORM;
type FormSetter = React.Dispatch<React.SetStateAction<FormState>>;

interface BasicTabProps {
  form: FormState;
  setForm: FormSetter;
  createError: string;
  inputCls: string;
  modelCards: ModelCard[];
  runtimes: AgentFormDialogProps["runtimes"];
  selectedCardId: string;
}

/**
 * Browser-mode panel: choose which `browser-vm` environment this agent's
 * sessions start on, or create one when the tenant has none. The harness is
 * unchanged — only the sandbox moves into the user's browser tab.
 */
export function BrowserRuntimePanel({
  value,
  environments,
  onChange,
}: {
  value: string;
  environments: EnvironmentLite[];
  onChange: (id: string) => void;
}) {
  const { api } = useApi();
  const [creating, setCreating] = useState(false);

  const createEnvironment = async () => {
    setCreating(true);
    try {
      const env = await api<{ id: string }>("/v1/environments", {
        method: "POST",
        body: JSON.stringify(newBrowserEnvironmentBody()),
      });
      onChange(env.id);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="mt-3 space-y-2">
      <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
        Sessions run their sandbox inside a browser tab you open from the session page — no
        container, no machine to pair. The model and harness below still apply.
      </p>
      {environments.length === 0 ? (
        <Button variant="secondary" onClick={createEnvironment} disabled={creating}>
          {creating ? "Creating…" : "Create a browser environment"}
        </Button>
      ) : (
        <div>
          <label className="text-sm text-fg-muted block mb-1">Browser environment</label>
          <Select
            value={value}
            onValueChange={onChange}
            placeholder="Select a browser environment..."
          >
            {environments.map((e) => (
              <SelectOption key={e.id} value={e.id}>
                {e.name}
              </SelectOption>
            ))}
          </Select>
        </div>
      )}
    </div>
  );
}

export function BasicTab({
  form,
  setForm,
  createError,
  inputCls,
  modelCards,
  runtimes,
  selectedCardId,
}: BasicTabProps) {
  // Cloud vs Local. The *binding* is derived from whether a runtime is set
  // (a bound runtime implies harness "acp-proxy"); but the toggle needs its
  // own intent so that picking "Local" with no runtimes registered still
  // reveals the connect-a-machine empty-state instead of silently no-oping.
  const [runtimeMode, setRuntimeMode] = useState<"cloud" | "local" | "browser">(
    form.runtimeId ? "local" : form.browserEnvId ? "browser" : "cloud",
  );
  const isLocal = runtimeMode === "local";
  const isBrowser = runtimeMode === "browser";
  const onlineRuntimes = runtimes.filter((r) => r.status === "online");

  // Browser mode picks a browser-vm environment, so the form needs the
  // tenant's environment list. Cheap + cached; the query is shared with the
  // session-create flows that use the same endpoint.
  const { data: envData } = useApiQuery<{ data: EnvironmentLite[] }>("/v1/environments");
  const browserEnvs = browserVmEnvironments(envData?.data ?? []);

  const selectCloud = () => {
    setRuntimeMode("cloud");
    // Clearing the runtime binding drops back to the cloud loop. The acp*
    // overrides stay in state harmlessly — they're only serialized by
    // formToConfig when a runtime is bound.
    setForm({ ...form, runtimeId: "", browserEnvId: "" });
  };
  const selectLocal = () => {
    setRuntimeMode("local");
    // Auto-bind the first online runtime + its first detected ACP agent so
    // the common case is one click. If none are registered, still flip to
    // Local and show the connect-a-machine empty-state below.
    const rt = onlineRuntimes[0] ?? runtimes[0];
    const nextAgent = rt?.agents?.[0]?.id ?? form.acpAgentId;
    setForm({
      ...form,
      browserEnvId: "",
      ...(rt ? { runtimeId: rt.id, ...acpBindingFor(form, nextAgent) } : {}),
    });
  };
  const selectBrowser = () => {
    setRuntimeMode("browser");
    // Auto-pick an existing browser-vm environment; with none, flip anyway
    // and show the create-one state below rather than silently no-oping.
    setForm({ ...form, runtimeId: "", browserEnvId: browserEnvs[0]?.id ?? "" });
  };

  // Per-harness model guidance: a suggested default that stays editable, and
  // the inline "this harness doesn't use the model field" note.
  const selectedHarness = harnessOption(form.harness);
  const harnessDefaultModel = selectedHarness?.defaultModel;
  const harnessModelCaveat = selectedHarness?.modelCaveat === true;
  const harnessNote = selectedHarness?.note;

  const segCls = (active: boolean) =>
    `flex-1 inline-flex flex-col items-start gap-0.5 px-3 py-2 min-h-11 text-sm rounded-md border transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
      active
        ? "border-brand bg-brand/5 text-fg"
        : "border-border text-fg-muted hover:border-border-strong"
    }`;

  return (
    <div className="space-y-4">
      {createError && (
        <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
          {createError}
        </div>
      )}
      {/* ── Identity first: name, description, system prompt ─────────────── */}
      <div>
        <label htmlFor="agent-name" className="text-sm text-fg-muted block mb-1">
          Name *
        </label>
        <input
          id="agent-name"
          value={form.name}
          onChange={(e) => setForm({ ...form, name: e.target.value })}
          className={inputCls}
          placeholder="Coding Assistant"
        />
      </div>
      <div>
        <label htmlFor="agent-description" className="text-sm text-fg-muted block mb-1">
          Description
        </label>
        <input
          id="agent-description"
          value={form.description}
          onChange={(e) => setForm({ ...form, description: e.target.value })}
          className={inputCls}
          placeholder="A coding assistant that writes clean code..."
        />
      </div>
      <div>
        <label htmlFor="agent-system" className="text-sm text-fg-muted block mb-1">
          System Prompt
        </label>
        <p className="text-xs text-fg-subtle mb-1">
          Instructions the agent follows on every turn — its persona, goals, and any rules
          it should stick to.
        </p>
        <textarea
          id="agent-system"
          value={form.system}
          onChange={(e) => setForm({ ...form, system: e.target.value })}
          rows={5}
          className={`${inputCls} resize-none font-mono text-xs leading-relaxed`}
          placeholder="You are a helpful assistant..."
        />
      </div>

      {/* ── Agent runtime: Cloud vs Local ───────────────────────────────── */}
      <div className="pt-1 border-t border-border">
        <label className="text-sm font-medium text-fg block mb-1 mt-3">Agent runtime</label>
        <p className="text-xs text-fg-subtle mb-2">
          Where this agent's loop runs. Cloud uses a model backed by one of your keys;
          Local delegates each turn to a coding agent on a machine you've paired.
        </p>
        <div className="flex gap-2" role="radiogroup" aria-label="Agent runtime">
          {(["cloud", "local", "browser"] as const).map((kind) => {
            const info = RUNTIME_KINDS[kind];
            const onSelect =
              kind === "cloud" ? selectCloud : kind === "local" ? selectLocal : selectBrowser;
            return (
              <button
                key={kind}
                type="button"
                role="radio"
                aria-checked={runtimeMode === kind}
                aria-label={info.label}
                onClick={onSelect}
                className={segCls(runtimeMode === kind)}
              >
                <span className="font-medium inline-flex items-center gap-1.5">
                  <info.Icon className="size-4 shrink-0" aria-hidden="true" />
                  {info.label}
                </span>
                <span className="text-xs text-fg-subtle">{info.description}</span>
              </button>
            );
          })}
        </div>

        {/* Browser: a sandbox provider, not a harness — pick the browser-vm
            environment this agent's sessions should start on. */}
        {isBrowser && (
          <BrowserRuntimePanel
            value={form.browserEnvId}
            environments={browserEnvs}
            onChange={(id) => setForm({ ...form, browserEnvId: id })}
          />
        )}

        {/* Cloud: harness template first, then the model it should use. */}
        {!isLocal && (
          <div className="mt-3 space-y-3">
            <HarnessPicker
              value={form.harness}
              onChange={(id) => setForm({ ...form, harness: id })}
            />
            {modelCards.length === 0 ? (
              <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
                No model cards configured. Cloud agents need at least one card to provide LLM
                credentials.{" "}
                <a
                  href="/model-cards"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-fg-muted"
                >
                  Add one
                </a>{" "}
                (opens in a new tab — your draft here is kept).
              </p>
            ) : (
              <div>
                <label className="text-sm text-fg-muted block mb-1">Model</label>
                <Combobox<ModelCard>
                  value={selectedCardId}
                  onValueChange={(v, item) => {
                    setForm({ ...form, modelCardId: v, model: item?.model_id ?? v });
                  }}
                  endpoint="/v1/model_cards"
                  getValue={(mc) => mc.id}
                  getLabel={(mc) => (
                    <span className="inline-flex items-center gap-1.5">
                      <ModelProviderMark modelId={mc.model ?? mc.model_id} />
                      {mc.is_default ? "★ " : ""}
                      {mc.model_id}
                      {mc.source === "platform" ? " (platform)" : ""}
                      {mc.model !== mc.model_id && (
                        <span className="text-fg-subtle text-[12px]"> ({mc.model})</span>
                      )}
                    </span>
                  )}
                  getTextLabel={(mc) =>
                    `${mc.is_default ? "★ " : ""}${mc.model_id}${
                      mc.source === "platform" ? " (platform)" : ""
                    }${mc.model !== mc.model_id ? ` (${mc.model})` : ""}`
                  }
                  placeholder={
                    !selectedCardId && form.model
                      ? `⚠ ${form.model} — no matching card, pick one`
                      : "Select a model card..."
                  }
                />
                {harnessDefaultModel && (
                  <p className="text-xs text-fg-subtle mt-1">
                    Default: <code>{harnessDefaultModel}</code>
                    {form.model !== harnessDefaultModel && (
                      <>
                        {" — "}
                        <button
                          type="button"
                          className="underline hover:text-fg-muted"
                          onClick={() =>
                            setForm({ ...form, model: harnessDefaultModel, modelCardId: "" })
                          }
                        >
                          use default
                        </button>
                      </>
                    )}
                  </p>
                )}
              </div>
            )}
            {harnessNote && (
              <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
                {harnessNote}
              </p>
            )}
            {harnessModelCaveat && (
              <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
                This harness applies the per-agent model when it resolves to a model card
                on an Anthropic-format endpoint (provider <code>ant</code> or{" "}
                <code>ant-compatible</code>) — the card's model, key and base URL are passed
                to the Claude Code CLI for the turn. An OpenAI-format card fails the turn:
                the CLI has no OpenAI transport. With no matching card, the CLI falls back
                to the deployment's environment (<code>ANTHROPIC_API_KEY</code> or{" "}
                <code>CLAUDE_CODE_OAUTH_TOKEN</code>, plus{" "}
                <code>ANTHROPIC_BASE_URL</code>).
              </p>
            )}
          </div>
        )}

        {/* Cloud only: optional repo auto-cloned into /workspace on every
            session start (AGENTS.md "Auto-Clone"). Backed by a dedicated
            environment carrying `config.git_repo`, minted/patched on save
            and set as this agent's default environment — see browser-env.ts. */}
        {runtimeMode === "cloud" && (
          <div className="mt-3">
            <label className="text-sm text-fg-muted block mb-1">
              Repository <span className="text-xs text-fg-subtle">(optional)</span>
            </label>
            <p className="text-xs text-fg-subtle mb-2">
              Clone a repo into <code>/workspace</code> at the start of every session.
            </p>
            <div className="flex gap-2">
              <input
                aria-label="Repository URL"
                value={form.repoUrl}
                onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
                className={`${inputCls} flex-1`}
                placeholder="https://github.com/owner/repo"
              />
              <input
                aria-label="Branch"
                value={form.repoBranch}
                onChange={(e) => setForm({ ...form, repoBranch: e.target.value })}
                className={`${inputCls} w-32`}
                placeholder="main"
              />
            </div>
            {!isValidRepoUrl(form.repoUrl) && (
              <p className="text-xs text-danger mt-1">
                Enter a full https:// git URL, e.g. https://github.com/owner/repo
              </p>
            )}
          </div>
        )}

        {/* Local: pick the paired machine, then the coding agent + overrides. */}
        {isLocal && (
          <div className="mt-3 space-y-2">
            {runtimes.length === 0 ? (
              <p className="text-xs text-fg-subtle bg-bg-surface px-3 py-2 rounded-lg">
                No runtimes registered.{" "}
                <a
                  href="/runtimes"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-fg-muted"
                >
                  Connect a machine
                </a>{" "}
                (opens in a new tab — your draft here is kept) to delegate this agent's loop
                to your own Claude Code (or other ACP) child.
              </p>
            ) : (
              <>
                <div>
                  <label className="text-sm text-fg-muted block mb-1">Machine</label>
                  <Select
                    value={form.runtimeId}
                    onValueChange={(v) => {
                      // Auto-pick the first detected ACP agent on the chosen
                      // runtime — user doesn't have to know what strings the
                      // daemon emits. Drop a model override that the new
                      // child does not speak (Claude id on Grok, etc.).
                      const first = runtimes.find((r) => r.id === v)?.agents?.[0]?.id;
                      const nextAgent = first ?? form.acpAgentId;
                      setForm({
                        ...form,
                        runtimeId: v,
                        ...acpBindingFor(form, nextAgent),
                      });
                    }}
                    placeholder="Select a machine..."
                  >
                    {runtimes.map((r) => (
                      <SelectOption key={r.id} value={r.id} disabled={r.status !== "online"}>
                        {r.hostname} ({r.status}
                        {r.status === "online" && r.agents.length
                          ? ` · ${r.agents.length} agents`
                          : ""}
                        )
                      </SelectOption>
                    ))}
                  </Select>
                </div>
                {form.runtimeId && (
                  <AcpAgentPicker form={form} setForm={setForm} runtimes={runtimes} inputCls={inputCls} />
                )}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AcpAgentPicker({
  form,
  setForm,
  runtimes,
  inputCls,
}: {
  form: FormState;
  setForm: FormSetter;
  runtimes: AgentFormDialogProps["runtimes"];
  inputCls: string;
}) {
  const detectedAgents = runtimes.find((r) => r.id === form.runtimeId)?.agents ?? [];
  // OMA promotes featured overlay agents as "first class" in the UI
  // (claude-acp, codex-acp, grok-build, hermes, openclaw). Featured-
  // detected render on top so the common case is one click. Anything
  // not detected by the daemon is intentionally hidden — users must
  // install via cli first.
  const featuredIds = new Set(KNOWN_ACP_AGENTS.filter((e) => e.featured).map((e) => e.id));
  const featuredDetected = detectedAgents.filter((a) => featuredIds.has(a.id));
  const otherDetected = detectedAgents.filter((a) => !featuredIds.has(a.id));

  // Canonicalize first: form.acpAgentId may be a legacy alias on stale
  // rows ("claude-code-acp"), but the daemon emits local_skills under the
  // canonical key ("claude-agent-acp"). Without resolving here the
  // blocklist would silently show empty even though skills exist.
  const canonicalId = resolveKnownAgent(form.acpAgentId)?.id ?? form.acpAgentId;
  const localSkills =
    runtimes.find((r) => r.id === form.runtimeId)?.local_skills?.[canonicalId] ?? [];

  return (
    <div className="mt-2">
      <label className="text-xs text-fg-subtle block mb-1">ACP agent on this machine</label>
      <Select
        value={form.acpAgentId}
        onValueChange={(v) => {
          setForm({
            ...form,
            localSkillBlocklist: [],
            ...acpBindingFor(form, v),
          });
        }}
      >
        {featuredDetected.length > 0 && (
          <SelectGroup>
            <SelectGroupLabel>★ Featured</SelectGroupLabel>
            {featuredDetected.map((a) => (
              <SelectOption key={a.id} value={a.id}>
                {a.id}
              </SelectOption>
            ))}
          </SelectGroup>
        )}
        {otherDetected.length > 0 && (
          <SelectGroup>
            <SelectGroupLabel>Other detected on this runtime</SelectGroupLabel>
            {otherDetected.map((a) => (
              <SelectOption key={a.id} value={a.id}>
                {a.id}
              </SelectOption>
            ))}
          </SelectGroup>
        )}
      </Select>
      <p className="text-xs text-fg-subtle mt-1">
        Each turn spawns this ACP child on the runtime. Model + skills come from the
        daemon-fetched bundle unless overridden below.
      </p>

      {/* Optional per-agent overrides forwarded in runtime_binding. The
          harness sends these on session.start and the daemon applies them
          best-effort against the spawned ACP child (see the linked issue
          for exactly which ACP methods and their support caveats). */}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-fg-subtle block mb-1">Model override</label>
          <Select
            value={form.acpModel || "__default__"}
            onValueChange={(v) =>
              setForm({ ...form, acpModel: v === "__default__" ? "" : v })
            }
          >
            <SelectOption value="__default__">Use daemon default</SelectOption>
            {acpModelOptionsFor(form.acpAgentId).map((o) => (
              <SelectOption key={o.value} value={o.value}>
                {o.label}
              </SelectOption>
            ))}
          </Select>
        </div>
        <div>
          <label className="text-xs text-fg-subtle block mb-1">Reasoning effort</label>
          <Select
            value={form.acpReasoningEffort || "__default__"}
            onValueChange={(v) =>
              setForm({ ...form, acpReasoningEffort: v === "__default__" ? "" : v })
            }
          >
            <SelectOption value="__default__">Default</SelectOption>
            {ACP_REASONING_OPTIONS.map((o) => (
              <SelectOption key={o.value} value={o.value}>
                {o.label}
              </SelectOption>
            ))}
          </Select>
        </div>
      </div>
      <p className="text-[10px] text-fg-subtle mt-1">
        Optional overrides sent as <span className="font-mono">runtime_binding.model</span> /{" "}
        <span className="font-mono">runtime_binding.reasoning_effort</span>. Applied
        best-effort against the spawned ACP child via ACP's experimental
        model/config-option selection methods — most ACP agents don't advertise support
        for either yet, in which case the child silently keeps its own local default (see{" "}
        <a
          href="https://github.com/duyet/oma/issues/269"
          target="_blank"
          rel="noopener noreferrer"
          className="underline hover:text-fg-muted"
        >
          #269
        </a>
        ).
      </p>

      {/* Local-agent-binding (advanced, optional): run the ACP child in a
          real project directory on the paired machine instead of the
          daemon's synthetic per-session cwd. Forwarded as
          runtime_binding.working_dir / .branch / .worktree.branch. */}
      <div className="mt-3 space-y-2">
        <div>
          <label className="text-xs text-fg-subtle block mb-1">
            Working directory (path on paired machine)
          </label>
          <input
            value={form.workingDir}
            onChange={(e) => setForm({ ...form, workingDir: e.target.value })}
            className={inputCls}
            placeholder="/Users/you/projects/my-repo"
          />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-fg-subtle block mb-1">Branch to check out</label>
            <input
              value={form.branch}
              onChange={(e) => setForm({ ...form, branch: e.target.value })}
              className={inputCls}
              placeholder="main"
            />
          </div>
          <div>
            <label className="text-xs text-fg-subtle block mb-1">
              Or: create worktree from branch
            </label>
            <input
              value={form.worktreeBranch}
              onChange={(e) => setForm({ ...form, worktreeBranch: e.target.value })}
              className={inputCls}
              placeholder="feature/my-branch"
            />
          </div>
        </div>
        <p className="text-xs text-fg-muted">
          Optional — only used for local runtimes. Leave blank to keep the daemon's default
          per-session working directory. Worktree branch takes precedence over the plain
          branch field when both are set.
        </p>
      </div>

      {/* Local-skill blocklist — multi-select fed by what the daemon
          reported in hello.local_skills[acpAgentId]. */}
      {localSkills.length > 0 && (
        <LocalSkillBlocklist form={form} setForm={setForm} localSkills={localSkills} />
      )}
    </div>
  );
}

function LocalSkillBlocklist({
  form,
  setForm,
  localSkills,
}: {
  form: FormState;
  setForm: FormSetter;
  localSkills: Array<{
    id: string;
    name?: string;
    description?: string;
    source?: string;
    source_label?: string;
  }>;
}) {
  const allowed = new Set(localSkills.map((s) => s.id));
  for (const id of form.localSkillBlocklist) allowed.delete(id);
  return (
    <div className="mt-3 border border-border rounded-md p-2.5 bg-bg-surface">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-fg-muted">
          Local skills ({allowed.size}/{localSkills.length} visible)
        </span>
        <button
          type="button"
          onClick={() => setForm({ ...form, localSkillBlocklist: [] })}
          className="inline-flex items-center min-h-11 sm:min-h-0 px-1 text-[10px] text-fg-subtle hover:text-fg underline"
        >
          reset
        </button>
      </div>
      <div className="space-y-0.5 max-h-40 overflow-y-auto">
        {localSkills.map((s) => {
          const blocked = form.localSkillBlocklist.includes(s.id);
          return (
            <label
              key={s.id}
              className="flex items-start gap-2 text-xs cursor-pointer hover:bg-bg rounded px-1.5 py-0.5"
            >
              <input
                type="checkbox"
                checked={!blocked}
                onChange={(e) => {
                  const next = new Set(form.localSkillBlocklist);
                  if (e.target.checked) next.delete(s.id);
                  else next.add(s.id);
                  setForm({ ...form, localSkillBlocklist: [...next] });
                }}
                className="mt-0.5 accent-brand"
              />
              <span className="font-mono text-fg flex-shrink-0">{s.id}</span>
              <span className="text-fg-subtle">
                ({s.source ?? "global"}
                {s.source_label ? `:${s.source_label}` : ""})
              </span>
              {s.name && s.name !== s.id && (
                <span className="text-fg-muted truncate">— {s.name}</span>
              )}
            </label>
          );
        })}
      </div>
      <p className="text-[10px] text-fg-subtle mt-1.5">
        Unchecked = hidden from the ACP child (daemon won't symlink the dir into the spawn
        cwd).
      </p>
    </div>
  );
}

export function ToolsTab({
  form,
  setForm,
  createError,
}: {
  form: FormState;
  setForm: FormSetter;
  createError: string;
}) {
  return (
    <div className="space-y-5">
      {createError && (
        <div className="text-sm text-danger bg-danger-subtle border border-danger/30 rounded-lg px-3 py-2">
          {createError}
        </div>
      )}

      <p className="text-xs text-fg-subtle leading-relaxed">
        Tools are the actions the agent can take — running commands, reading and writing
        files, searching the web. Built-in toolset (AMA{" "}
        <span className="font-mono">agent_toolset_20260401</span>). Multi-agent delegation
        lives in its own tab and is a separate AMA field{" "}
        <span className="font-mono">multiagent</span> — not part of this toolset. External MCP
        tools live in the MCP Servers tab.
      </p>

      <div className="rounded-md border border-border bg-bg-surface px-3 py-3">
        <div className="text-sm font-medium text-fg mb-1">Default policy</div>
        <p className="text-xs text-fg-subtle mb-3">
          Applies to every tool below that's set to{" "}
          <span className="font-mono">default</span>.
        </p>
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.toolDefaultEnabled}
              onChange={(e) => setForm({ ...form, toolDefaultEnabled: e.target.checked })}
              className="accent-brand"
            />
            Enable tools
          </label>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-fg-muted">Permission:</span>
            <select
              value={form.toolDefaultPermission}
              disabled={!form.toolDefaultEnabled}
              onChange={(e) =>
                setForm({
                  ...form,
                  toolDefaultPermission: e.target.value as "always_allow" | "always_ask",
                })
              }
              className="border border-border rounded-md px-2 py-1 text-sm bg-bg text-fg outline-none focus:border-brand disabled:opacity-40"
            >
              <option value="always_allow">always_allow</option>
              <option value="always_ask">always_ask</option>
            </select>
          </div>
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-fg block mb-2">Per-tool overrides</label>
        <p className="text-xs text-fg-subtle mb-3">
          Each row's effective state is shown in the dropdown. Pick{" "}
          <span className="font-mono">default</span> to inherit the policy above; pick a
          specific value to override. <span className="font-mono">always_ask</span> emits a{" "}
          <span className="font-mono">user.tool_confirmation</span> event the client must
          approve before each call.
        </p>
        <div className="border border-border rounded-md divide-y divide-border">
          {BUILTIN_TOOLS.map((bt) => {
            const current = form.toolOverrides[bt.name] ?? "default";
            const effectiveLabel = !form.toolDefaultEnabled
              ? "disabled"
              : form.toolDefaultPermission;
            const isOff =
              current === "disabled" || (current === "default" && !form.toolDefaultEnabled);
            return (
              <div
                key={bt.name}
                className={`flex items-center justify-between px-3 py-2 gap-3 ${
                  isOff ? "opacity-50" : ""
                }`}
              >
                <div className="min-w-0">
                  <div className="text-sm font-mono text-fg">{bt.label}</div>
                  <div className="text-xs text-fg-subtle truncate">{bt.description}</div>
                </div>
                <select
                  value={current}
                  onChange={(e) => {
                    const v = e.target.value as ToolOverride;
                    const next = { ...form.toolOverrides };
                    if (v === "default") delete next[bt.name];
                    else next[bt.name] = v;
                    setForm({ ...form, toolOverrides: next });
                  }}
                  className="border border-border rounded-md px-2 py-1 min-h-11 sm:min-h-0 text-xs bg-bg text-fg outline-none focus:border-brand shrink-0"
                >
                  <option value="default">default ({effectiveLabel})</option>
                  <option value="always_allow">always_allow</option>
                  <option value="always_ask">always_ask</option>
                  <option value="disabled">disabled</option>
                </select>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function SkillsTab({
  form,
  setForm,
  customSkills,
  toggleAnthropicSkill,
}: {
  form: FormState;
  setForm: FormSetter;
  customSkills: AgentFormDialogProps["customSkills"];
  toggleAnthropicSkill: (id: string) => void;
}) {
  // Hide skills that are already surfaced under Anthropic Skills above
  // (xlsx/pdf/pptx/docx — their backend rows show up in the same list as
  // user-registered skills, otherwise we duplicate).
  const anthropicIds = new Set(ANTHROPIC_SKILLS.map((s) => s.id));
  const filtered = customSkills.filter((cs) => !anthropicIds.has(cs.id));

  return (
    <div className="space-y-4">
      <p className="text-xs text-fg-subtle leading-relaxed">
        A skill is a reusable set of instructions and files — like a mini playbook — that
        gets mounted into the agent's sandbox and added to its system prompt.
      </p>
      <div>
        <label className="text-sm font-medium text-fg block mb-2">Anthropic Skills</label>
        <div className="grid grid-cols-2 gap-2">
          {ANTHROPIC_SKILLS.map((s) => {
            const active = form.skills.some(
              (sk) => sk.type === "anthropic" && sk.skill_id === s.id,
            );
            return (
              <button
                key={s.id}
                onClick={() => toggleAnthropicSkill(s.id)}
                className={`flex items-center gap-2 px-3 py-2.5 rounded-md border text-sm text-left transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                  active
                    ? "border-brand bg-brand text-brand-fg"
                    : "border-border hover:border-border-strong"
                }`}
              >
                <span
                  className={`w-4 h-4 rounded border flex items-center justify-center text-xs ${
                    active
                      ? "bg-brand-fg text-brand border-brand-fg"
                      : "border-border-strong"
                  }`}
                >
                  {active && "✓"}
                </span>
                {s.label}
              </button>
            );
          })}
        </div>
      </div>

      <div>
        <label className="text-sm font-medium text-fg block mb-2">Custom Skills</label>
        {filtered.length > 0 ? (
          <div className="space-y-2">
            {filtered.map((cs) => {
              const active = form.skills.some(
                (sk) => sk.type === "custom" && sk.skill_id === cs.id,
              );
              return (
                <button
                  key={cs.id}
                  onClick={() => {
                    if (active) {
                      setForm({
                        ...form,
                        skills: form.skills.filter(
                          (sk) => !(sk.type === "custom" && sk.skill_id === cs.id),
                        ),
                      });
                    } else {
                      setForm({
                        ...form,
                        skills: [
                          ...form.skills,
                          { type: "custom", skill_id: cs.id, version: "latest" },
                        ],
                      });
                    }
                  }}
                  className={`flex items-center gap-2 w-full px-3 py-2.5 rounded-md border text-sm text-left transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] ${
                    active
                      ? "border-brand bg-brand text-brand-fg"
                      : "border-border hover:border-border-strong"
                  }`}
                >
                  <span
                    className={`w-4 h-4 rounded border flex items-center justify-center text-xs shrink-0 ${
                      active
                        ? "bg-brand-fg text-brand border-brand-fg"
                        : "border-border-strong"
                    }`}
                  >
                    {active && "✓"}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="font-medium">{cs.name}</div>
                    <div
                      className={`text-xs truncate ${
                        active ? "text-brand-fg/70" : "text-fg-subtle"
                      }`}
                    >
                      {cs.description}
                    </div>
                  </div>
                  <span
                    className={`text-xs font-mono shrink-0 ${
                      active ? "text-brand-fg/60" : "text-fg-subtle"
                    }`}
                  >
                    {cs.id}
                  </span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-fg-subtle">
            No custom skills registered.{" "}
            <a
              href={`/skills?new=1&return=${encodeURIComponent(
                typeof window !== "undefined"
                  ? `${window.location.pathname}${window.location.search}`
                  : "/agents/new",
              )}`}
              className="underline hover:text-fg-muted"
            >
              Create one
            </a>
            .
          </p>
        )}
      </div>
    </div>
  );
}

export function McpTab({
  form,
  inputCls,
  onPickFromRegistry,
  addMcp,
  updateMcp,
  removeMcp,
}: {
  form: FormState;
  inputCls: string;
  onPickFromRegistry: () => void;
  addMcp: () => void;
  updateMcp: (i: number, field: keyof McpEntry, val: string) => void;
  removeMcp: (i: number) => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-xs text-fg-subtle leading-relaxed">
        MCP servers connect the agent to external tools and data — GitHub, Slack, your own
        APIs — via the Model Context Protocol. Credentials stay in a{" "}
        <a href="/vaults" className="underline hover:text-fg-muted">
          vault
        </a>{" "}
        and are injected by the outbound proxy (never into the sandbox). Works the same on
        Cloudflare Workers and self-host (k3s / Node).
      </p>
      <div className="flex items-center justify-between mb-1">
        <label className="text-sm font-medium text-fg">MCP Servers</label>
        <div className="flex items-center gap-3">
          <button
            onClick={onPickFromRegistry}
            className="inline-flex items-center min-h-11 sm:min-h-0 text-xs text-fg-muted hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            + Pick known
          </button>
          <button
            onClick={addMcp}
            className="inline-flex items-center min-h-11 sm:min-h-0 text-xs text-fg-muted hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            + Custom URL
          </button>
        </div>
      </div>
      {form.mcpServers.map((mcp, i) => {
        let hostHint = "";
        try {
          if (mcp.url) hostHint = new URL(mcp.url).hostname;
        } catch {
          /* ignore */
        }
        return (
          <div key={i} className="border border-border rounded-lg p-3 space-y-2">
            <div className="flex gap-2">
              <div className="flex-1">
                <label htmlFor={`mcp-name-${i}`} className="text-xs text-fg-muted block mb-0.5">
                  Name
                </label>
                <input
                  id={`mcp-name-${i}`}
                  value={mcp.name}
                  onChange={(e) => updateMcp(i, "name", e.target.value)}
                  className={inputCls}
                  placeholder="github"
                />
              </div>
              <div className="w-28">
                <label className="text-xs text-fg-muted block mb-0.5">Type</label>
                <Select value={mcp.type || "url"} onValueChange={(v) => updateMcp(i, "type", v)}>
                  {/* "url" = remote HTTP/SSE (AMA wire name). Label shows http for operators. */}
                  <SelectOption value="url">url (http)</SelectOption>
                  <SelectOption value="sse">sse</SelectOption>
                  <SelectOption value="stdio">stdio</SelectOption>
                </Select>
              </div>
              <button
                onClick={() => removeMcp(i)}
                aria-label={`Remove MCP server ${mcp.name || i + 1}`}
                className="self-end inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 py-2 text-fg-subtle hover:text-danger transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
              >
                ×
              </button>
            </div>
            <div>
              <label htmlFor={`mcp-url-${i}`} className="text-xs text-fg-muted block mb-0.5">
                URL
              </label>
              <input
                id={`mcp-url-${i}`}
                value={mcp.url}
                onChange={(e) => updateMcp(i, "url", e.target.value)}
                className={inputCls}
                placeholder="https://mcp.github.com/mcp"
              />
            </div>
            {hostHint ? (
              <p className="text-[11px] text-fg-subtle">
                Add a vault credential for{" "}
                <span className="font-mono text-fg-muted">{hostHint}</span> so session runs can
                authenticate.{" "}
                <a href="/vaults" className="underline hover:text-fg-muted">
                  Open vaults
                </a>
              </p>
            ) : null}
          </div>
        );
      })}
      {form.mcpServers.length === 0 && (
        <div className="text-center py-8 text-fg-subtle">
          <p className="text-sm">No MCP servers configured.</p>
          <p className="text-xs mt-1">
            MCP servers provide external tools via the Model Context Protocol.
          </p>
        </div>
      )}
    </div>
  );
}

export function AgentsTab({
  form,
  setForm,
  allAgents,
  addCallable,
  removeCallable,
}: {
  form: FormState;
  setForm: FormSetter;
  allAgents: Agent[];
  addCallable: (agentId: string) => void;
  removeCallable: (i: number) => void;
}) {
  return (
    <div className="space-y-5">
      {/* Built-in general sub-agent — opt-in. */}
      <div className="rounded-md border border-border bg-bg-surface px-3 py-3">
        <label className="flex items-start gap-2 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={form.enableGeneralSubagent}
            onChange={(e) => setForm({ ...form, enableGeneralSubagent: e.target.checked })}
            className="accent-brand mt-0.5"
          />
          <div>
            <div className="font-medium text-fg">Enable general sub-agent</div>
            <p className="text-xs text-fg-subtle mt-0.5">
              Exposes a built-in{" "}
              <span className="font-mono">general_subagent(task)</span> tool. Spawns a
              generic sub-agent thread (reserved id{" "}
              <span className="font-mono">general</span>) inheriting this agent's model +
              sandbox, with a safe built-in tool subset
              (bash/read/write/edit/grep/glob). No roster setup needed.
            </p>
          </div>
        </label>
      </div>

      <div>
        <label className="text-sm font-medium text-fg block">Callable Agents</label>
        <p className="text-xs text-fg-subtle mb-2">
          Specific agents this agent can delegate to via{" "}
          <span className="font-mono">call_agent_&lt;id&gt;</span> tools.
        </p>
      </div>

      {form.callableAgents.map((ca, i) => {
        const agentInfo = allAgents.find((a) => a.id === ca.id);
        return (
          <div
            key={i}
            className="flex items-center gap-2 px-3 py-2 border border-border rounded-lg"
          >
            <div className="flex-1">
              <div className="text-sm font-medium text-fg">{agentInfo?.name || ca.id}</div>
              <div className="text-xs text-fg-subtle font-mono">{ca.id}</div>
            </div>
            <button
              onClick={() => removeCallable(i)}
              className="inline-flex items-center justify-center min-w-11 min-h-11 sm:min-w-0 sm:min-h-0 px-2 text-fg-subtle hover:text-danger transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
            >
              ×
            </button>
          </div>
        );
      })}

      <div>
        <label className="text-xs text-fg-muted block mb-1">Add agent</label>
        <Combobox<Agent>
          value=""
          onValueChange={(v) => {
            if (v) addCallable(v);
          }}
          endpoint="/v1/agents"
          getValue={(a) => a.id}
          getLabel={(a) => (
            <span>
              {a.name} <span className="text-fg-subtle text-[12px]">({a.id})</span>
            </span>
          )}
          getTextLabel={(a) => `${a.name} (${a.id})`}
          placeholder="Select an agent..."
          excludeIds={form.callableAgents.map((c) => c.id)}
        />
      </div>

      {form.callableAgents.length === 0 && allAgents.length === 0 && (
        <p className="text-xs text-fg-subtle">
          Create other agents first to enable multi-agent delegation.
        </p>
      )}
    </div>
  );
}

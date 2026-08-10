// Static mirror of the Console's "How it fits together" panel
// (apps/console/src/components/StackedAssembly.tsx), rendered through the
// shared @duyet/oma-fit-diagram package. Same visual grammar — numbered step
// columns, dashed type-cards with instance badges, the composition formula,
// flow pointers — but purely decorative: no links, no live data, example
// instances hard-coded. The click-to-describe <dialog> and the sandbox
// avatar-group live here (host-specific interaction); FitDiagram only knows
// about `onActivate` callbacks and `providerMarks` ids.
import { useCallback, useMemo, useRef, useState } from "react";
import {
  BotIcon,
  BoxIcon,
  ClockIcon,
  CpuIcon,
  DatabaseIcon,
  FileTextIcon,
  GitBranchIcon,
  GlobeIcon,
  KeyRoundIcon,
  LockIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  PlugIcon,
  ServerIcon,
  TerminalIcon,
  ZapIcon,
} from "lucide-react";
import { FitDiagram, ProviderMark, type FitStep } from "@duyet/oma-fit-diagram";

const iconSm = "size-3.5";
const iconHero = "size-4";

interface DialogContent {
  title: string;
  desc: string;
  /** 2-3 concrete facts, rendered as a bullet list. */
  points?: string[];
  /** Mini flow diagram rendered above the points. */
  flow?: FlowItem[];
  /** Supported providers/integrations — logo tiles, each linking to setup docs. */
  resources?: DialogResource[];
  /** Related docs / blog links. */
  links?: { label: string; href: string }[];
  /** Product screenshot shown in a right-side pane (borderless). Absolute
   *  /screenshots/* URLs — same assets are hot-linkable from docs/help. */
  image?: { src: string; alt: string };
}

interface DialogResource {
  /** ProviderMark id — sandbox providers or channel marks (github/slack/…). */
  id: string;
  label: string;
  href: string;
}

const DOCS = "https://docs.oma.duyet.net";

/** Grid of supported providers/integrations — each tile links to its setup guide. */
function ResourceGrid({ items }: { items: DialogResource[] }) {
  return (
    <div className="mt-3 grid grid-cols-2 gap-1.5 sm:grid-cols-3">
      {items.map((r) => (
        <a
          key={r.id + r.href}
          href={r.href}
          target="_blank"
          rel="noreferrer"
          className="group flex items-center gap-2 rounded-md border border-border bg-bg-surface/60 px-2.5 py-2 no-underline transition-colors hover:border-brand/60 hover:bg-bg-surface"
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-bg text-fg-muted group-hover:text-brand">
            <ProviderMark id={r.id} colored className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[12px] font-medium text-fg">{r.label}</span>
            <span className="block text-[10px] text-fg-subtle group-hover:text-brand">setup →</span>
          </span>
        </a>
      ))}
    </div>
  );
}

// ── Mini flow diagram ────────────────────────────────────────────────────
// Theme-token styled boxes joined by arrows — a consistent little visual
// grammar for every dialog without an SVG library. `hero` tints the box.

type FlowItem = { label: string; hero?: boolean; stack?: string[] };

function FlowDiagram({ items }: { items: FlowItem[] }) {
  return (
    <div className="my-3 flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-bg-surface/50 px-3 py-3" aria-hidden="true">
      {items.map((it, i) => (
        <span key={it.label} className="flex items-center gap-1.5">
          {i > 0 && <span className="text-fg-subtle">→</span>}
          {it.stack ? (
            <span className="flex flex-col gap-1">
              {it.stack.map((l) => (
                <span key={l} className="rounded border border-border bg-bg px-2 py-0.5 font-mono text-[11px] text-fg-muted">
                  {l}
                </span>
              ))}
            </span>
          ) : (
            <span
              className={
                it.hero
                  ? "rounded border border-brand/50 bg-brand/10 px-2 py-1 font-mono text-[11px] font-semibold text-brand"
                  : "rounded border border-border bg-bg px-2 py-1 font-mono text-[11px] text-fg"
              }
            >
              {it.label}
            </span>
          )}
        </span>
      ))}
    </div>
  );
}

// Monochrome sandbox-provider ids, same set as the landing page's fleet band
// and console's ProviderMark — rendered via the package's avatar-group.
const sandboxProviderIds = ["cloudflare", "kubernetes", "openshell", "e2b", "daytona", "docker-compose", "subprocess"];

export default function HowItFits() {
  const [dialog, setDialog] = useState<DialogContent | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const open = useCallback(
    (
      title: string,
      desc: string,
      extra?: Partial<Omit<DialogContent, "title" | "desc">>,
    ) => {
      setDialog({ title, desc, ...extra });
      dialogRef.current?.showModal();
    },
    [],
  );

  const steps: FitStep[] = useMemo(() => [
    {
      number: "1",
      name: "Configure",
      accent: "sky",
      cards: [
        {
          key: "api-key",
          icon: <KeyRoundIcon className={iconSm} strokeWidth={2} />,
          accent: "sky",
          title: "API key",
          badges: ["cli"],
          onActivate: () =>
            open(
              "API key",
              "Authenticates the CLI and your programs against your OMA instance. Every REST call, SDK call, and `oma` CLI command presents one — scoped to your tenant.",
              {
                flow: [
                  { stack: ["oma CLI", "SDK / REST"] },
                  { label: "x-api-key", hero: true },
                  { label: "your OMA instance" },
                ],
                image: { src: "/screenshots/cli-bridge-status.jpg", alt: "The oma CLI authenticated against an OMA instance — bridge status output" },
                points: [
                  "One key authenticates the CLI, SDKs, and raw REST calls.",
                  "Scoped to your tenant — rotate or revoke per key.",
                ],
                links: [
                  { label: "Quickstart", href: `${DOCS}/quickstart/` },
                  { label: "CLI & SDK", href: `${DOCS}/build/cli-sdk/` },
                  { label: "API reference", href: `${DOCS}/reference/api/` },
                ],
              },
            ),
        },
        {
          key: "model",
          icon: <CpuIcon className={iconSm} strokeWidth={2} />,
          accent: "violet",
          title: "Model card",
          badges: ["claude-sonnet-4-6"],
          onActivate: () =>
            open(
              "Model card",
              "The AI brain, made pluggable. A model card binds a model id to a provider and credentials — Anthropic, any OpenAI-compatible gateway, or your own endpoint. Agents reference it by handle, so swapping providers never touches agent config.",
              {
                flow: [
                  { label: "agent" },
                  { label: "model handle", hero: true },
                  { stack: ["provider", "api key", "base_url"] },
                ],
                points: [
                  "Anthropic, any OpenAI-compatible gateway, or your own endpoint.",
                  "Swap providers by editing the card — agent config never changes.",
                  "Mark one card as default for new agents.",
                ],
                links: [
                  { label: "Configuration reference", href: `${DOCS}/reference/configuration/` },
                  { label: "Claude Managed Agents vs OMA", href: "/blog/claude-managed-agents-vs-open-managed-agents/" },
                ],
              },
            ),
        },
        {
          key: "cli",
          icon: <TerminalIcon className={iconSm} strokeWidth={2} />,
          accent: "slate",
          title: "CLI",
          badges: ["oma bridge"],
          onActivate: () =>
            open(
              "CLI",
              "Binds your own machine to your OMA instance. `oma bridge setup` pairs the laptop over an outbound-only WebSocket, so an agent's tools — bash, files, git — run locally against your real environment while the control plane stays in the cloud.",
              {
                flow: [
                  { label: "oma bridge setup" },
                  { label: "outbound WebSocket", hero: true },
                  { label: "tools exec on your machine" },
                ],
                points: [
                  "Pairs a local machine as a `subprocess` sandbox runtime — no inbound ports.",
                  "The agent runs in the cloud; its tools execute on your box.",
                  "Also fronts the `acp-proxy` harness for local Claude Code / Codex.",
                ],
                links: [
                  { label: "CLI & SDK", href: `${DOCS}/build/cli-sdk/` },
                  { label: "Quickstart", href: `${DOCS}/quickstart/` },
                ],
                image: { src: "/screenshots/cli-bridge.jpg", alt: "The oma CLI pairing a local machine as a bridge runtime" },
              },
            ),
        },
      ],
    },
    {
      number: "2",
      name: "Compose",
      accent: "brand",
      wide: true,
      cards: [
        {
          key: "agent",
          icon: <BotIcon className={iconHero} strokeWidth={2} />,
          accent: "brand",
          title: "Agent",
          badges: ["support-bot"],
          hero: true,
          onActivate: () =>
            open(
              "Agent",
              "The thing you're building: agent = model + skills + mcp. A versioned configuration — system prompt, tools, skills, MCP servers, callable sub-agents. Stateless by itself; every conversation with it runs as a session.",
              {
                flow: [
                  { stack: ["model", "skills", "mcp"] },
                  { label: "agent", hero: true },
                  { label: "session per conversation" },
                ],
                points: [
                  "A versioned configuration — every update creates a new version.",
                  "Stateless by itself; sessions bind to a specific version.",
                  "Can delegate to other agents (callable_agents), in parallel.",
                ],
                links: [
                  { label: "Core concepts", href: `${DOCS}/concepts/` },
                  { label: "How it works", href: `${DOCS}/how-it-works/` },
                  { label: "Migrating from Claude Managed Agents", href: "/blog/migrate-from-claude-managed-agents/" },
                ],
                image: { src: "/screenshots/new-agent-from-template.jpg", alt: "Creating a new agent from a template in the OMA Console" },
              },
            ),
        },
        {
          key: "skills",
          icon: <ZapIcon className={iconSm} strokeWidth={2} />,
          accent: "amber",
          title: "Skills",
          badges: ["xlsx", "pdf", "pptx", "html", "report", "data-analysis"],
          onActivate: () =>
            open(
              "Skills",
              "Reusable know-how: prompt fragments and files mounted into the sandbox and injected into the system prompt. Write a skill once, attach it to any number of agents.",
              {
                flow: [
                  { label: "SKILL.md + files" },
                  { label: "mounted in sandbox", hero: true },
                  { label: "injected into system prompt" },
                ],
                points: [
                  "Write once, attach to any number of agents.",
                  "Ships prompt fragments and supporting files together.",
                ],
                links: [
                  { label: "Skills & tools guide", href: `${DOCS}/build/skills-and-tools/` },
                ],
                image: { src: "/screenshots/skills.jpg", alt: "Skills library in the OMA Console" },
              },
            ),
        },
        {
          key: "mcp",
          icon: <PlugIcon className={iconSm} strokeWidth={2} />,
          accent: "sky",
          title: "MCP servers",
          note: "External tools the agent can call",
          providerMarks: ["github", "firecrawl", "linear"],
          onActivate: () =>
            open(
              "MCP servers",
              "The `mcp` in agent = model + skills + mcp. Connect remote MCP servers — GitHub, Firecrawl, Linear, anything — and the agent gets their tools. Every call is proxied through the control plane, which is the only layer that ever holds the upstream credential.",
              {
                flow: [
                  { label: "agent tool call" },
                  { label: "mcp-proxy + credential", hero: true },
                  { label: "remote MCP server" },
                ],
                points: [
                  "Register once at the tenant level, reference by id from any agent.",
                  "The proxy injects the vault credential — the sandbox never sees it.",
                  "Works identically across every sandbox provider.",
                ],
                resources: [
                  { id: "github", label: "GitHub", href: `${DOCS}/build/vault-and-mcp/` },
                  { id: "firecrawl", label: "Firecrawl", href: `${DOCS}/build/vault-and-mcp/` },
                  { id: "linear", label: "Linear", href: `${DOCS}/build/vault-and-mcp/` },
                ],
                links: [
                  { label: "Vault & MCP guide", href: `${DOCS}/build/vault-and-mcp/` },
                ],
              },
            ),
        },
        {
          key: "subagents",
          icon: <GitBranchIcon className={iconSm} strokeWidth={2} />,
          accent: "violet",
          title: "Sub-agents",
          note: "Delegate to other agents",
          dashed: true,
          onActivate: () =>
            open(
              "Sub-agents",
              "An agent can call other agents. List them in callable_agents and the platform generates call_agent_* tools plus a call_agents_parallel tool that fans out to several children concurrently and aggregates their results.",
              {
                flow: [
                  { label: "parent agent" },
                  { label: "call_agents_parallel", hero: true },
                  { stack: ["researcher", "writer", "reviewer"] },
                ],
                points: [
                  "Each child runs as its own thread nested in the parent session.",
                  "By default children share the parent's sandbox — opt one into its own via environment_id.",
                  "Concurrency capped (default 5, ceiling 10) — set max_parallel_subagents.",
                ],
                links: [
                  { label: "Core concepts", href: `${DOCS}/concepts/` },
                  { label: "How it works", href: `${DOCS}/how-it-works/` },
                ],
              },
            ),
        },
        [
          {
            key: "memory",
            icon: <DatabaseIcon className={iconSm} strokeWidth={2} />,
            accent: "emerald",
            title: "Memory",
            note: "Notes it keeps",
            dashed: true,
            onActivate: () =>
              open(
                "Memory",
                "Persistent memory stores, mounted into the sandbox at /mnt/memory/<name>. The agent reads and writes them with ordinary file tools, so knowledge survives across sessions — versioned, auditable, and rollback-able.",
                {
                flow: [
                  { label: "/mnt/memory/<name>", hero: true },
                  { label: "ordinary file tools" },
                  { label: "survives across sessions" },
                ],
                points: [
                  "No bespoke memory tools — the agent just reads and writes files.",
                  "Every mutation is versioned: 30-day history, rollback, redaction.",
                ],
                links: [
                  { label: "Core concepts", href: `${DOCS}/concepts/` },
                  { label: "Glossary", href: `${DOCS}/reference/glossary/` },
                ],
              },
              ),
          },
          {
            key: "files",
            icon: <FileTextIcon className={iconSm} strokeWidth={2} />,
            accent: "slate",
            title: "Files",
            note: "Data to mount",
            dashed: true,
            onActivate: () =>
              open(
                "Files",
                "Files you upload once and mount into any session's sandbox at a path you choose — datasets, configs, reference documents. Created once, attached to sessions at runtime.",
                {
                flow: [
                  { label: "upload once" },
                  { label: "mount path you choose", hero: true },
                  { label: "any session sandbox" },
                ],
                points: [
                  "Datasets, configs, reference documents.",
                  "Attached to sessions at runtime — no re-upload per session.",
                ],
                links: [
                  { label: "Skills & tools guide", href: `${DOCS}/build/skills-and-tools/` },
                  { label: "API reference", href: `${DOCS}/reference/api/` },
                ],
              },
              ),
          },
        ],
      ],
    },
    {
      number: "3",
      name: "Run",
      accent: "emerald",
      chain: true,
      chainLabels: ["+ agent =", "runs inside"],
      cards: [
        [
          {
            key: "environment",
            icon: <ServerIcon className={iconSm} strokeWidth={2} />,
            accent: "emerald",
            title: "Environment",
            badges: ["cloudflare"],
            onActivate: () =>
              open(
                "Environment",
                "Defines the execution sandbox: which provider runs it (Cloudflare, Kubernetes, OpenShell, E2B, …), what packages are preinstalled, and what networking is allowed. Reusable across agents and sessions.",
                {
                flow: [
                  { stack: ["provider", "packages", "networking"] },
                  { label: "environment", hero: true },
                  { label: "sandbox per session" },
                ],
                points: [
                  "Cloudflare, Kubernetes, OpenShell, E2B, Daytona, Docker, your own machine.",
                  "pip / npm / apt / cargo preinstalls, allow-listed networking.",
                  "Reusable across agents and sessions.",
                ],
                resources: [
                  { id: "cloudflare", label: "Cloudflare", href: `${DOCS}/deploy/cloudflare/` },
                  { id: "kubernetes", label: "Kubernetes", href: `${DOCS}/deploy/kubernetes/` },
                  { id: "docker-compose", label: "Docker", href: `${DOCS}/deploy/docker/` },
                ],
                links: [
                  { label: "Deploy overview", href: `${DOCS}/deploy/` },
                  { label: "Configuration reference", href: `${DOCS}/reference/configuration/` },
                ],
                image: { src: "/screenshots/sandbox-add-provider.jpg", alt: "Add sandbox provider dialog in the OMA Console" },
              },
              ),
          },
          {
            key: "vaults",
            icon: <LockIcon className={iconSm} strokeWidth={2} />,
            accent: "amber",
            title: "Keys (Vault)",
            badges: ["prod-secrets"],
            providerMarks: ["github", "firecrawl", "slack", "linear"],
            onActivate: () =>
              open(
                "Keys (Vault)",
                "Secrets the agent calls out with — API tokens, OAuth credentials. Injected by an outbound proxy at the network layer, so raw credentials never enter the sandbox the agent controls.",
                {
                flow: [
                  { label: "sandbox request" },
                  { label: "outbound proxy + auth", hero: true },
                  { label: "api.github.com" },
                ],
                points: [
                  "The proxy injects the right credential by URL match.",
                  "Raw tokens never enter the sandbox the agent controls.",
                  "Static bearer, OAuth (auto-refresh), and CLI-tool credentials.",
                ],
                links: [
                  { label: "Vault & MCP guide", href: `${DOCS}/build/vault-and-mcp/` },
                ],
              },
              ),
          },
        ],
        {
          key: "session",
          icon: <MessagesSquareIcon className={iconSm} strokeWidth={2} />,
          accent: "sky",
          title: "Session",
          note: "One conversation or task — streamed, resumable event log.",
          onActivate: () =>
            open(
              "Session",
              "One conversation or task: session = agent + env + vaults. An append-only, durably-stored event log — streamed over SSE, resumable after crashes, pausable to stop paying for idle compute.",
              {
                flow: [
                  { stack: ["agent", "env", "vaults"] },
                  { label: "session", hero: true },
                  { label: "append-only event log" },
                ],
                points: [
                  "Streamed over SSE; resumable after crashes.",
                  "Pausable — snapshot the workspace, stop paying for idle compute.",
                  "Events are durably written before being broadcast.",
                ],
                links: [
                  { label: "How it works", href: `${DOCS}/how-it-works/` },
                  { label: "Recovery & idempotency", href: `${DOCS}/contribute/recovery-and-idempotency/` },
                  { label: "Architecture deep-dive", href: "/blog/architecture-durable-objects-r2-brain-sandbox-split/" },
                ],
                image: { src: "/screenshots/new-session.jpg", alt: "New Session dialog in the OMA Console" },
              },
            ),
        },
        {
          key: "sandbox",
          icon: <BoxIcon className={iconSm} strokeWidth={2} />,
          accent: "emerald",
          title: "Sandbox",
          note: "Set by your environment.",
          providerMarks: sandboxProviderIds,
          onActivate: () =>
            open(
              "Sandbox",
              "The isolated container or micro-VM where the agent's tools actually execute — bash, files, browsers. Provisioned per session by whichever provider the environment selects: Cloudflare, Kubernetes, NVIDIA OpenShell, E2B, Daytona, Docker, and more.",
              {
                flow: [
                  { label: "session" },
                  { label: "sandbox", hero: true },
                  { stack: ["bash + files", "browsers", "your code"] },
                ],
                points: [
                  "An isolated container or micro-VM per session.",
                  "Provider set by the environment — same agent, any substrate.",
                ],
                resources: [
                  { id: "cloudflare", label: "Cloudflare", href: `${DOCS}/deploy/cloudflare/` },
                  { id: "kubernetes", label: "Kubernetes", href: `${DOCS}/deploy/kubernetes/` },
                  { id: "openshell", label: "NVIDIA OpenShell", href: `${DOCS}/deploy/k8s-bridge/` },
                  { id: "e2b", label: "E2B", href: `${DOCS}/reference/configuration/` },
                  { id: "daytona", label: "Daytona", href: `${DOCS}/reference/configuration/` },
                  { id: "docker-compose", label: "Docker", href: `${DOCS}/deploy/docker/` },
                  { id: "subprocess", label: "Your own machine", href: `${DOCS}/quickstart/` },
                ],
                links: [
                  { label: "Deploy overview", href: `${DOCS}/deploy/` },
                  { label: "Architecture deep-dive", href: "/blog/architecture-durable-objects-r2-brain-sandbox-split/" },
                ],
                image: { src: "/screenshots/sandbox-runtime.jpg", alt: "Sandbox Runtimes page in the OMA Console" },
              },
            ),
        },
      ],
    },
    {
      number: "4",
      name: "Reach",
      accent: "violet",
      optional: true,
      cards: [
        {
          key: "triggers",
          icon: <ClockIcon className={iconSm} strokeWidth={2} />,
          accent: "rose",
          title: "Triggers",
          note: "Manual · schedule · webhook",
          dashed: true,
          onActivate: () =>
            open(
              "Triggers",
              "How a session fires without someone typing. A deployment bundles an agent version, environment, vaults, and memory stores behind a trigger — run it manually, on a cron schedule, or from a signed webhook. Agent schedules do the cron-only, prompt-only variant.",
              {
                flow: [
                  { stack: ["manual", "schedule", "webhook"] },
                  { label: "deployment", hero: true },
                  { label: "fresh session" },
                ],
                points: [
                  "Deployment = pinned agent version + env + vaults + memory + trigger.",
                  "Cron schedules are DST-correct and never double-fire across replicas.",
                  "Webhooks are token-secured and can override the initial message.",
                ],
                links: [
                  { label: "Console getting started", href: `${DOCS}/console/getting-started/` },
                  { label: "Configuration reference", href: `${DOCS}/reference/configuration/` },
                ],
              },
            ),
        },
        {
          key: "channels",
          icon: <MessageCircleIcon className={iconSm} strokeWidth={2} />,
          accent: "sky",
          title: "Channels",
          providerMarks: ["telegram", "slack", "github", "linear"],
          dashed: true,
          onActivate: () =>
            open(
              "Channels",
              "Wire the agent into where work already happens: Telegram chats, Slack workspaces, GitHub issues and PRs. Each message in becomes a session turn; replies flow back to the channel.",
              {
                flow: [
                  { stack: ["Telegram", "Slack", "GitHub"] },
                  { label: "session turn", hero: true },
                  { label: "reply flows back" },
                ],
                points: [
                  "Each incoming message becomes a session turn.",
                  "GitHub issues/PRs, Slack threads, Telegram chats.",
                ],
                resources: [
                  { id: "github", label: "GitHub", href: `${DOCS}/build/integrations/` },
                  { id: "slack", label: "Slack", href: `${DOCS}/console/integrations/` },
                  { id: "telegram", label: "Telegram", href: `${DOCS}/build/integrations/` },
                  { id: "linear", label: "Linear", href: `${DOCS}/console/integrations/` },
                ],
                links: [
                  { label: "Integrations guide", href: `${DOCS}/build/integrations/` },
                  { label: "Console integrations", href: `${DOCS}/console/integrations/` },
                ],
                image: { src: "/screenshots/github-integration.jpg", alt: "GitHub integrations page in the OMA Console" },
              },
            ),
        },
        {
          key: "publications",
          icon: <GlobeIcon className={iconSm} strokeWidth={2} />,
          accent: "violet",
          title: "Publications",
          note: "Public chat page or widget",
          dashed: true,
          onActivate: () =>
            open(
              "Publications",
              "Publish the agent as a consumer-facing bot: a hosted chat page, an embeddable widget, guest access, and optional per-message billing — no OMA account needed for end users.",
              {
                flow: [
                  { label: "agent" },
                  { label: "/p/<slug>", hero: true },
                  { stack: ["chat page", "embed widget", "QR / share"] },
                ],
                points: [
                  "Guest access — end users need no OMA account.",
                  "Optional per-message or per-token billing via Stripe credits.",
                ],
                links: [
                  { label: "Console getting started", href: `${DOCS}/console/getting-started/` },
                  { label: "An open-source Claude Tag", href: "/blog/claude-tag-open-source-alternative/" },
                  { label: "Self-hosted Claude Tag", href: "/blog/self-hosted-claude-tag-open-source/" },
                ],
              },
            ),
        },
      ],
    },
  ], [open]);

  // Text panel of the dialog. Rendered bare when there's no screenshot, or as
  // the left column of a two-up grid alongside the image when there is — so a
  // no-image dialog never carries an empty grid wrapper.
  const dialogBody = (
    <div className="p-[1.1rem_1.25rem_1.25rem]">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 id="fits-dialog-title" className="text-base font-semibold tracking-tight">
          {dialog?.title}
        </h3>
        <button
          type="button"
          aria-label="Close"
          className="px-1 text-sm text-fg-subtle hover:text-fg"
          onClick={() => dialogRef.current?.close()}
        >
          ✕
        </button>
      </div>
      <p className="text-[0.85rem] leading-relaxed text-fg-muted">{dialog?.desc}</p>
      {dialog?.flow && <FlowDiagram items={dialog.flow} />}
      {dialog?.resources && (
        <>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-subtle">
            Supported
          </p>
          <ResourceGrid items={dialog.resources} />
        </>
      )}
      {dialog?.points && (
        <ul className="mt-2 space-y-1.5">
          {dialog.points.map((pt) => (
            <li key={pt} className="flex gap-2 text-[0.8rem] leading-relaxed text-fg-muted">
              <span className="mt-[1px] text-brand" aria-hidden="true">
                ›
              </span>
              {pt}
            </li>
          ))}
        </ul>
      )}
      {dialog?.links && (
        <div className="mt-4 border-t border-border pt-3">
          <p className="mb-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-fg-subtle">
            Learn more
          </p>
          <ul className="space-y-1">
            {dialog.links.map((l) => (
              <li key={l.href + l.label}>
                <a
                  href={l.href}
                  target={l.href.startsWith("http") ? "_blank" : undefined}
                  rel={l.href.startsWith("http") ? "noreferrer" : undefined}
                  className="text-[0.8rem] text-brand hover:underline"
                >
                  {l.label} →
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );

  return (
    <div aria-label="How it fits together">
      <FitDiagram
        steps={steps}
        collapsible
        formula={[
          { lhs: "agent", parts: ["model", "skills", "mcp"] },
          { lhs: "session", parts: ["agent", "env", "vaults"] },
        ]}
      />

      {/* Native <dialog> — ESC and backdrop click close it for free. */}
      <dialog
        ref={dialogRef}
        aria-labelledby="fits-dialog-title"
        className={`fixed inset-0 m-auto h-fit max-h-[calc(100dvh-3rem)] w-[calc(100vw-2.5rem)] ${
          dialog?.image ? "max-w-4xl" : "max-w-lg"
        } overflow-y-auto rounded-[10px] border border-border bg-bg p-0 text-fg backdrop:bg-bg/60 backdrop:backdrop-blur-[10px]`}
        onClick={(e) => {
          if (e.target === dialogRef.current) dialogRef.current?.close();
        }}
      >
        {dialog?.image ? (
          <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            {dialogBody}
            <div className="hidden overflow-hidden md:block">
              <img
                src={dialog.image.src}
                alt={dialog.image.alt}
                loading="lazy"
                className="h-full w-full object-cover object-left-top"
              />
            </div>
          </div>
        ) : (
          dialogBody
        )}
      </dialog>
    </div>
  );
}

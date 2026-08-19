// "How it fits together" — one panel that is BOTH the conceptual map and the
// setup tracker, drawn as a left-to-right flow so the *relations* between the
// pieces are the thing you read first:
//
//   1 · CONFIGURE  →  2 · COMPOSE  →  3 · RUN  →  4 · REACH
//   (the pieces)      (the agent)     (env+vaults  (channels &
//                                      ↓ session    publications)
//                                      ↓ sandbox)
//
// The flow mirrors the page's own header copy — "configure the pieces, compose
// them into an agent, and every conversation runs as a session inside a
// sandbox". Steps 1/2 are required; 3 is what happens once they're done; 4 is
// optional. Pointers between steps are plain divs (no SVG/diagram lib) so the
// whole thing reflows to a vertical stack on narrow screens.
//
// Each card's title is a component TYPE, its body the actual created
// instances as badges — an empty/dashed card *is* the to-do item, so nothing
// needs a second checklist. RUN's cards describe runtime behaviour rather
// than instances you create, so they carry a `description` instead.
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { FitDiagram, ProviderMark, type FitCardStatus, type FitProviderMark, type FitStep } from "@duyet/oma-fit-diagram";
import { FormDialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useApiQuery } from "../lib/useApiQuery";
import { IntegrationsApi } from "../integrations/api/client";
import { friendlyHostingDescription } from "../lib/hostingTypes";
import {
  AgentIcon,
  ApiKeysIcon,
  FilesIcon,
  MemoryIcon,
  ModelCardsIcon,
  SessionsIcon,
  SkillsIcon,
  EnvIcon,
  VaultIcon,
  RuntimesIcon,
} from "./icons";
import { MessageCircleIcon, GlobeIcon } from "lucide-react";

interface AgentRecord {
  id: string;
  name: string;
}
interface ModelCard {
  id: string;
  model_id: string;
}
interface SkillEntry {
  id: string;
  name: string;
}
interface EnvEntry {
  id: string;
  name: string;
  config: Record<string, unknown>;
  status?: string;
}
interface VaultEntry {
  id: string;
  name: string;
}
interface PublicationEntry {
  id: string;
  title: string;
  status: "draft" | "live" | "paused";
}
interface ApiKeyEntry {
  id: string;
  name: string;
}
interface SessionEntry {
  id: string;
}
interface MemoryStoreEntry {
  id: string;
  name: string;
}
interface FileEntry {
  id: string;
  filename: string;
}
interface Page<T> {
  data: T[];
  next_cursor?: string;
}
/** Subset of /v1/hosting_types — just what the sandbox card needs to color
 *  a provider mark by live health and describe it in the quick-view. */
interface HostingType {
  id: string;
  label: string;
  capabilities?: string[];
  health: { status: "healthy" | "unhealthy" | "not_configured"; latency_ms?: number } | null;
}

/** Single source of the provider-id fallback chain — keeps labels and
 *  provider marks derived from the same resolution. */
function providerId(env: EnvEntry): string {
  return (
    (env.config?.sandbox_provider as string | undefined) ??
    (env.config?.type as string | undefined) ??
    "cloud"
  );
}

function providerLabel(env: EnvEntry): string {
  const id = providerId(env);
  const desc = friendlyHostingDescription({ id, label: id });
  return desc?.split(" — ")[0] ?? id;
}

// ── Quick-view dialog ───────────────────────────────────────────────────
// Clicking a card no longer navigates straight away — it opens a compact
// dialog with the live rows the dashboard already fetched (table for list
// resources, a mark grid for sandbox providers) plus a link to the full page.

interface QuickRow {
  primary: string;
  secondary?: string;
  tag?: string;
  /** Health tone for the provider-mark grid — drives the status dot color. */
  tone?: "ok" | "warn" | "idle";
}

interface QuickView {
  title: string;
  desc: string;
  href: string;
  linkLabel: string;
  rows: QuickRow[];
  /** Renders a provider-mark grid instead of the row table. Object marks may
   *  be flagged inactive to render grayed-out (idle providers). */
  marks?: FitProviderMark[];
  emptyText: string;
  /** Shown in the empty state as a primary action (e.g. "+ Add provider"). */
  emptyAction?: { label: string; onClick: () => void };
}

const TONE_DOT: Record<NonNullable<QuickRow["tone"]>, string> = {
  ok: "bg-success",
  warn: "bg-destructive",
  idle: "bg-fg-subtle",
};

const QUICK_ROW_CAP = 8;

function QuickViewBody({ view }: { view: QuickView }) {
  if (view.marks && view.marks.length > 0) {
    return (
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {view.marks.map((m, i) => {
          const id = typeof m === "string" ? m : m.id;
          const active = typeof m === "string" ? true : m.active !== false;
          const row = view.rows[i];
          return (
            <div
              key={id}
              className="flex items-center gap-2.5 rounded-md border border-border bg-bg-surface/40 px-2.5 py-2"
            >
              <span
                className={cn(
                  "flex size-7 shrink-0 items-center justify-center rounded-full border border-border bg-bg",
                  !active && "opacity-45 grayscale",
                )}
              >
                <ProviderMark id={id} colored={active} className="size-4 text-fg-muted" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-fg">{row?.primary ?? id}</span>
                {row?.tag && (
                  <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-fg-subtle">
                    <span className={cn("size-1.5 rounded-full", TONE_DOT[row.tone ?? "idle"])} />
                    {row.tag}
                    {row.secondary && <span className="font-mono text-fg-subtle">· {row.secondary}</span>}
                  </span>
                )}
              </span>
            </div>
          );
        })}
      </div>
    );
  }
  if (view.rows.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="text-sm text-fg-muted">{view.emptyText}</p>
        {view.emptyAction && (
          <Button size="sm" variant="secondary" onClick={view.emptyAction.onClick}>
            {view.emptyAction.label}
          </Button>
        )}
      </div>
    );
  }
  const shown = view.rows.slice(0, QUICK_ROW_CAP);
  const rest = view.rows.length - shown.length;
  return (
    <div className="rounded-md border border-border">
      <div className="divide-y divide-border">
        {shown.map((r, i) => (
          <div key={`${r.primary}-${i}`} className="flex items-center gap-3 px-3 py-2">
            <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{r.primary}</span>
            {r.tag && (
              <span className="shrink-0 rounded bg-bg-surface px-1.5 py-0.5 text-[11px] text-fg-muted">
                {r.tag}
              </span>
            )}
            {r.secondary && (
              <span className="shrink-0 font-mono text-[11px] text-fg-subtle">{r.secondary}</span>
            )}
          </div>
        ))}
      </div>
      {rest > 0 && (
        <div className="border-t border-border px-3 py-1.5 text-[12px] text-fg-subtle">
          +{rest} more on the full page
        </div>
      )}
    </div>
  );
}

/** `defaultOpen` controls whether the architecture map is expanded on
 *  first paint. New / empty tenants keep it open (the default); set-up
 *  tenants pass `false` so Overview leads with metrics without forcing a
 *  scroll past the map every visit. */
export function StackedAssembly({
  defaultOpen = true,
}: {
  defaultOpen?: boolean;
} = {}) {
  const nav = useNavigate();
  const [quick, setQuick] = useState<QuickView | null>(null);

  const agentsQ = useApiQuery<Page<AgentRecord>>("/v1/agents", { limit: "10" });
  const modelCardsQ = useApiQuery<Page<ModelCard>>("/v1/model_cards", { limit: "10" });
  const skillsQ = useApiQuery<Page<SkillEntry>>("/v1/skills", { limit: "10" });
  const envQ = useApiQuery<Page<EnvEntry>>("/v1/environments", { limit: "10" });
  const vaultsQ = useApiQuery<Page<VaultEntry>>("/v1/vaults", { limit: "10" });
  const pubsQ = useApiQuery<Page<PublicationEntry>>("/v1/publications", { limit: "10" });
  const apiKeysQ = useApiQuery<Page<ApiKeyEntry>>("/v1/api_keys", { limit: "10" });
  const sessionsQ = useApiQuery<Page<SessionEntry>>("/v1/sessions", { limit: "10" });
  const memoryQ = useApiQuery<Page<MemoryStoreEntry>>("/v1/memory_stores", { limit: "10" });
  const filesQ = useApiQuery<Page<FileEntry>>("/v1/files", { limit: "10" });
  // Live provider health drives the sandbox card's colored-vs-gray marks and
  // the quick-view status rows. Same 30s cadence as the Runtimes page.
  const hostingQ = useApiQuery<{ data: HostingType[] }>("/v1/hosting_types", undefined, {
    refetchInterval: 30_000,
  });

  // Channels: reuse the same live-installation counts the Integrations Hub
  // already computes (issue #92) rather than inventing a new endpoint.
  const chatQ = useQuery({
    queryKey: ["dashboard-integration-counts"],
    queryFn: async () => {
      const integrations = new IntegrationsApi();
      const [linear, github, slack] = await Promise.all([
        integrations.linear.listInstallations().catch(() => []),
        integrations.github.listInstallations().catch(() => []),
        integrations.slack.listInstallations().catch(() => []),
      ]);
      return [
        ...linear.map(() => "Linear"),
        ...github.map(() => "GitHub"),
        ...slack.map(() => "Slack"),
      ];
    },
    staleTime: 30_000,
  });

  const agents = agentsQ.data?.data ?? [];
  const modelCards = modelCardsQ.data?.data ?? [];
  const envs = envQ.data?.data ?? [];
  const vaults = vaultsQ.data?.data ?? [];
  const skills = skillsQ.data?.data ?? [];
  const pubs = pubsQ.data?.data ?? [];
  const channels = chatQ.data ?? [];
  const apiKeys = apiKeysQ.data?.data ?? [];
  const sessions = sessionsQ.data?.data ?? [];
  const memoryStores = memoryQ.data?.data ?? [];
  const files = filesQ.data?.data ?? [];

  const envAttention = envs.some((e) => e.status === "building" || e.status === "error");
  const envStatus: FitCardStatus =
    envs.length === 0 ? "empty" : envAttention ? "attention" : "ready";
  const providers = [...new Set(envs.map(providerLabel))];
  const providerIds = [...new Set(envs.map(providerId))];

  // Provider id → live health, keyed for O(1) lookup by the sandbox card.
  const hostingById = new Map((hostingQ.data?.data ?? []).map((h) => [h.id, h]));
  const providerHealthOf = (id: string): { active: boolean; tone: QuickRow["tone"]; label: string; latency?: string } => {
    const status = hostingById.get(id)?.health?.status;
    if (status === "healthy") {
      const ms = hostingById.get(id)?.health?.latency_ms;
      return { active: true, tone: "ok", label: "Healthy", latency: ms != null ? `${ms}ms` : undefined };
    }
    if (status === "unhealthy") return { active: false, tone: "warn", label: "Unhealthy" };
    if (status === "not_configured") return { active: false, tone: "idle", label: "Not configured" };
    return { active: false, tone: "idle", label: "Idle" };
  };
  const sandboxMarks: FitProviderMark[] = providerIds.map((id) => ({ id, active: providerHealthOf(id).active }));

  const countStatus = (n: number): FitCardStatus => (n > 0 ? "ready" : "empty");

  const agentReady = agents.length > 0;

  const configure: FitStep = {
    number: "1",
    name: "Configure",
    done: modelCards.length > 0,
    cards: [
      {
        key: "api-key",
        icon: <ApiKeysIcon className="w-4 h-4" />,
        title: "API key",
        status: countStatus(apiKeys.length),
        badges: apiKeys.map((k) => k.name),
        emptyCta: "+ Auth for the CLI & your agent",
        onActivate: () =>
          setQuick({
            title: "API keys",
            desc: "Authenticate the CLI, SDK, and REST calls against your OMA instance.",
            href: "/api-keys",
            linkLabel: "API Keys",
            rows: apiKeys.map((k) => ({ primary: k.name, secondary: k.id })),
            emptyText: "No API keys yet — create one to use the CLI and SDK.",
          }),
      },
      {
        key: "model",
        icon: <ModelCardsIcon className="w-4 h-4" />,
        title: "Model card",
        status: countStatus(modelCards.length),
        badges: modelCards.map((m) => m.model_id),
        emptyCta: "+ Add a model card — the AI brain",
        onActivate: () =>
          setQuick({
            title: "Model cards",
            desc: "Each card binds a model handle to a provider, key, and base URL.",
            href: "/model-cards",
            linkLabel: "Model Cards",
            rows: modelCards.map((m) => ({ primary: m.model_id, secondary: m.id })),
            emptyText: "No model cards yet — agents fall back to the environment key.",
          }),
      },
      {
        key: "integrations",
        icon: <MessageCircleIcon className="w-4 h-4" />,
        title: "Integrations",
        status: countStatus(channels.length),
        badges: channels,
        emptyCta: "+ Set up GitHub, Slack, Linear",
        onActivate: () =>
          setQuick({
            title: "Integrations",
            desc: "Wire agents into GitHub, Slack, and Linear — messages become session turns.",
            href: "/integrations",
            linkLabel: "Integrations",
            rows: channels.map((c) => ({ primary: c })),
            emptyText: "Nothing connected yet — set up GitHub, Slack, or Linear.",
          }),
      },
    ],
  };

  const compose: FitStep = {
    number: "2",
    name: "Compose",
    done: agentReady,
    wide: true,
    cards: [
      {
        key: "agent",
        hero: true,
        icon: <AgentIcon className="w-5 h-5" />,
        title: "Agent",
        status: agentReady ? "ready" : "empty",
        badges: agents.map((a) => a.name),
        emptyCta: "+ Create your first agent — it composes everything in step 1",
        onActivate: () =>
          agentReady
            ? setQuick({
                title: "Agents",
                desc: "agent = model + skills + mcp — a versioned configuration; every conversation with it runs as a session.",
                href: "/agents",
                linkLabel: "Agents",
                rows: agents.map((a) => ({ primary: a.name, secondary: a.id })),
                emptyText: "No agents yet.",
              })
            : nav("/agents/new"),
      },
      // Skills is the only piece of `agent = model + skills + mcp` that is
      // also a resource with its own page, so it's the only one that earns a
      // card inside the agent's box. Model lives in step 1 (you create a model
      // card), and MCP has no page at all — it's a tab inside the agent form,
      // so a card for it would link back to the very agent above it. The
      // formula states both relations instead.
      {
        key: "skills",
        icon: <SkillsIcon className="w-4 h-4" />,
        title: "Skills",
        status: countStatus(skills.length),
        badges: skills.map((s) => s.name),
        emptyCta: "+ Prompts & know-how",
        onActivate: () =>
          setQuick({
            title: "Skills",
            desc: "Reusable prompts and files mounted into the sandbox and injected into the system prompt.",
            href: "/skills",
            linkLabel: "Skills",
            rows: skills.map((k) => ({ primary: k.name, secondary: k.id })),
            emptyText: "No skills yet — write one once, attach it to any agent.",
          }),
      },
      // Optional knowledge + data the agent works with — grouped with the
      // agent it augments; sessions mount them at runtime.
      [
        {
          key: "memory",
          icon: <MemoryIcon className="w-4 h-4" />,
          title: "Memory",
          status: countStatus(memoryStores.length),
          badges: memoryStores.map((m) => m.name),
          emptyCta: "+ Notes it keeps",
          onActivate: () =>
            setQuick({
              title: "Memory stores",
              desc: "Mounted at /mnt/memory/<name> — knowledge that survives across sessions, versioned and auditable.",
              href: "/memory",
              linkLabel: "Memory Stores",
              rows: memoryStores.map((m) => ({ primary: m.name, secondary: m.id })),
              emptyText: "No memory stores yet.",
            }),
        },
        {
          key: "files",
          icon: <FilesIcon className="w-4 h-4" />,
          title: "Files",
          status: countStatus(files.length),
          badges: files.map((f) => f.filename),
          emptyCta: "+ Data to mount",
          onActivate: () =>
            setQuick({
              title: "Files",
              desc: "Uploaded once, mounted into any session's sandbox at a path you choose.",
              href: "/files",
              linkLabel: "Files",
              rows: files.map((f) => ({ primary: f.filename, secondary: f.id })),
              emptyText: "No files yet.",
            }),
        },
      ],
    ],
  };

  const run: FitStep = {
    number: "3",
    name: "Run",
    done: sessions.length > 0,
    chain: true,
    // Completes the formula in place: env + vaults (+ the agent arriving
    // from step 2) compose into a session, which runs inside the sandbox.
    chainLabels: ["+ agent =", "runs inside"],
    cards: [
      // `session = agent + env + vaults` — the agent arrives from step 2's
      // pointer; env + vaults are the session-scoped pieces, so they sit
      // here as the chain's inputs, mirroring Skills-under-Agent in COMPOSE.
      [
        {
          key: "env",
          icon: <EnvIcon className="w-4 h-4" />,
          title: "Environment",
          status: envStatus,
          badges: envs.map((e) => e.name),
          emptyCta: "+ Create a sandbox environment",
          onActivate: () =>
            setQuick({
              title: "Environments",
              desc: "Which sandbox provider runs the session, what's preinstalled, and what networking is allowed.",
              href: "/environments",
              linkLabel: "Environments",
              rows: envs.map((e) => ({ primary: e.name, secondary: providerLabel(e), tag: e.status })),
              emptyText: "No environments yet.",
            }),
        },
        {
          key: "vaults",
          icon: <VaultIcon className="w-4 h-4" />,
          title: "Keys (Vault)",
          status: countStatus(vaults.length),
          badges: vaults.map((v) => v.name),
          emptyCta: "+ Secrets it calls out with",
          onActivate: () =>
            setQuick({
              title: "Credential vaults",
              desc: "Secrets injected by the outbound proxy at the network layer — raw credentials never enter the sandbox.",
              href: "/vaults",
              linkLabel: "Credential Vaults",
              rows: vaults.map((v) => ({ primary: v.name, secondary: v.id })),
              emptyText: "No vaults yet.",
            }),
        },
      ],
      {
        key: "session",
        icon: <SessionsIcon className="w-4 h-4" />,
        title: "Session",
        status: countStatus(sessions.length),
        badges: [],
        emptyCta: "",
        description: "One conversation or task — streamed, resumable event log.",
        onActivate: () =>
          setQuick({
            title: "Sessions",
            desc: "session = agent + env + vaults — an append-only, resumable event log per conversation.",
            href: "/sessions",
            linkLabel: "Sessions",
            rows: sessions.map((s) => ({ primary: s.id })),
            emptyText: "No sessions yet.",
          }),
      },
      {
        key: "runtime",
        icon: <RuntimesIcon className="w-4 h-4" />,
        title: "Sandbox",
        status: envStatus,
        badges: providers,
        emptyCta: "+ Where sandboxes run — set by your environment",
        description:
          providers.length > 0 ? "Where tools execute — set by your environment." : undefined,
        providerMarks: sandboxMarks,
        onActivate: () =>
          setQuick({
            title: "Sandbox providers",
            desc: "Where tools execute — the isolated container or micro-VM each session runs inside, set by its environment. Colored = live and healthy; gray = idle or unreachable.",
            href: "/runtimes",
            linkLabel: "Sandbox providers",
            rows: providerIds.map((id, i) => {
              const h = providerHealthOf(id);
              return { primary: providers[i] ?? id, tag: h.label, tone: h.tone, secondary: h.latency };
            }),
            marks: sandboxMarks,
            emptyText: "No environments yet, so no sandbox providers in use.",
            emptyAction: { label: "+ Add a sandbox provider", onClick: () => nav("/runtimes") },
          }),
      },
    ],
  };

  const reach: FitStep = {
    number: "4",
    name: "Reach",
    optional: true,
    done: channels.length > 0 || pubs.length > 0,
    cards: [
      {
        key: "channels",
        icon: <MessageCircleIcon className="w-4 h-4" />,
        title: "Channels",
        status: countStatus(channels.length),
        badges: channels,
        emptyCta: "+ Connect Telegram, Slack, or GitHub",
        onActivate: () =>
          setQuick({
            title: "Channels",
            desc: "Where the agent meets users: Telegram, Slack, GitHub — replies flow back to the channel.",
            href: "/integrations",
            linkLabel: "Integrations",
            rows: channels.map((c) => ({ primary: c })),
            emptyText: "No channels connected yet.",
          }),
      },
      {
        key: "publications",
        icon: <GlobeIcon className="w-4 h-4" />,
        title: "Publications",
        status: countStatus(pubs.length),
        badges: pubs.map((p) => p.title),
        emptyCta: "+ Publish a public chat page or widget",
        onActivate: () =>
          setQuick({
            title: "Publications",
            desc: "The agent as a consumer-facing bot: hosted chat page, embeddable widget, optional billing.",
            href: "/my-bots",
            linkLabel: "My Bots",
            rows: pubs.map((p) => ({ primary: p.title, tag: p.status })),
            emptyText: "Nothing published yet.",
          }),
      },
    ],
  };

  const steps = [configure, compose, run, reach];
  const requiredDone = [configure.done, agentReady].filter(Boolean).length;

  const intro = (
    <p className="mt-1 mb-3 text-[13px] text-fg-muted">
      Configure the pieces, compose them into an agent, and every conversation
      runs as a session inside a sandbox. Reach is optional. Click any card to
      manage that piece.
    </p>
  );

  const diagram = (
    <FitDiagram
      steps={steps}
      collapsible
      formula={[
        { lhs: "agent", parts: ["model", "skills", "mcp"] },
        { lhs: "session", parts: ["agent", "env", "vaults"] },
      ]}
    />
  );

  const progressLabel = `${requiredDone} of 2 required steps complete`;

  return (
    <section
      className="border border-border rounded-lg"
      data-testid="stacked-assembly"
      data-open={defaultOpen ? "true" : "false"}
    >
      {defaultOpen ? (
        <div className="p-5 md:p-6">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
            <h2 className="font-display text-lg font-semibold text-fg">
              How it fits together
            </h2>
            <span className="text-[12px] tabular-nums text-fg-subtle">
              {progressLabel}
            </span>
          </div>
          {intro}
          {diagram}
        </div>
      ) : (
        // Returning / set-up tenants: start closed so Overview doesn't force
        // a scroll past the architecture map. Native <details> keeps this
        // free of extra state and accessible out of the box.
        <details className="group">
          <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-x-4 gap-y-1 p-5 md:p-6 outline-none marker:content-none [&::-webkit-details-marker]:hidden">
            <h2 className="font-display text-lg font-semibold text-fg">
              How it fits together
            </h2>
            <span className="text-[12px] tabular-nums text-fg-subtle">
              {progressLabel}
              <span className="ml-2 text-fg-muted group-open:hidden">
                · Show map
              </span>
              <span className="ml-2 text-fg-muted hidden group-open:inline">
                · Hide map
              </span>
            </span>
          </summary>
          <div className="border-t border-border px-5 pb-5 pt-3 md:px-6 md:pb-6">
            {intro}
            {diagram}
          </div>
        </details>
      )}

      {quick && (
        <FormDialog
          open
          onClose={() => setQuick(null)}
          title={quick.title}
          subtitle={quick.desc}
          footer={
            <>
              <Button variant="ghost" onClick={() => setQuick(null)}>
                Close
              </Button>
              <Button
                onClick={() => {
                  setQuick(null);
                  nav(quick.href);
                }}
              >
                Open {quick.linkLabel} →
              </Button>
            </>
          }
        >
          <QuickViewBody view={quick} />
        </FormDialog>
      )}
    </section>
  );
}

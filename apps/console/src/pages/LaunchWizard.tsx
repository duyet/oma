// Guided first-run path: Agent → Sandbox → Credentials → Session.
// Same four steps as Overview Getting started. Composes existing list/create
// routes rather than duplicating forms — same control plane on Cloudflare
// Workers and self-host (k3s / main-node). Once any session exists this
// page collapses to a pointer back to Overview / Sessions.
import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router";
import {
  ArrowRightIcon,
  CheckIcon,
  RocketIcon,
  ServerIcon,
  ShieldIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { useApiQuery } from "../lib/useApiQuery";
import { cn } from "@/lib/utils";
import { AgentIcon, EnvIcon, SessionsIcon, VaultIcon } from "../components/icons";

interface StatsShape {
  agents: number;
  sessions: number;
  environments: number;
  vaults: number;
  model_cards: number;
  api_keys: number;
}

interface WizardStep {
  id: string;
  title: string;
  body: string;
  done: boolean;
  optional?: boolean;
  to: string;
  cta: string;
  icon: (props: { className?: string }) => React.ReactElement;
}

export function LaunchWizard() {
  const nav = useNavigate();
  const statsQ = useApiQuery<StatsShape>("/v1/stats");
  const agentsQ = useApiQuery<{ data: Array<{ id: string; name: string }> }>("/v1/agents", {
    limit: "5",
  });
  const stats = statsQ.data;
  const firstAgentId = agentsQ.data?.data?.[0]?.id;
  const agentCount = Math.max(stats?.agents ?? 0, agentsQ.data?.data?.length ?? 0);
  const sessionCount = stats?.sessions ?? 0;

  const steps: WizardStep[] = useMemo(() => {
    const envs = stats?.environments ?? 0;
    const vaults = stats?.vaults ?? 0;

    // Same four steps as Overview Getting started so the two first-run
    // surfaces cannot disagree on n/m. Foundation (model cards / API keys)
    // is not a separate row — creating an agent covers it.
    return [
      {
        id: "agent",
        title: "Create agent",
        body: "Name, model, system prompt, tools, skills, and MCP. Templates speed this up.",
        done: agentCount > 0,
        to: agentCount > 0 ? "/agents" : "/agents/new",
        cta: agentCount > 0 ? "View agents" : "New agent",
        icon: AgentIcon,
      },
      {
        id: "environment",
        title: "Sandbox environment",
        body: "Define packages, networking, and provider (Cloudflare Containers, k3s, boxrun, bridge, …). Required for cloud sessions.",
        done: envs > 0,
        to: "/environments",
        cta: envs > 0 ? "Manage environments" : "Create environment",
        icon: EnvIcon,
      },
      {
        id: "vault",
        title: "Credential vault",
        body: "Store tokens for MCP and git hosts. Injected at the network layer — never into the sandbox. Optional if the agent only uses public tools.",
        done: vaults > 0,
        to: "/vaults",
        cta: vaults > 0 ? "Manage vaults" : "Create vault",
        icon: VaultIcon,
      },
      {
        id: "session",
        title: "Start a session",
        body: "Attach environment + vaults, send a first message, watch tools run in the sandbox.",
        done: sessionCount > 0,
        to: firstAgentId
          ? `/sessions?new=1&agent=${encodeURIComponent(firstAgentId)}`
          : "/sessions?new=1",
        cta: "New session",
        icon: SessionsIcon,
      },
    ];
  }, [stats, agentCount, sessionCount, firstAgentId]);

  const nextIdx = steps.findIndex((s) => !s.done && !s.optional);
  const nextOptionalIdx = steps.findIndex((s) => !s.done);
  const focusIdx = nextIdx >= 0 ? nextIdx : nextOptionalIdx;
  const doneRequired = steps.filter((s) => s.done || s.optional).length;
  const allRequiredDone = steps.every((s) => s.done || s.optional);
  const allDone = steps.every((s) => s.done);

  const [dismissedOptional, setDismissedOptional] = useState(false);

  // Hide the checklist once a session exists — Overview then leads with
  // recent work, not a second wizard. Wait for stats so a loading zero
  // doesn't flash the compact state on a brand-new tenant.
  if (!statsQ.isLoading && sessionCount > 0) {
    return (
      <div className="flex-1 overflow-y-auto">
        <div
          className="mx-auto w-full max-w-2xl px-4 py-8 space-y-4"
          data-testid="launch-wizard-complete"
        >
          <header className="space-y-2">
            <div className="inline-flex items-center gap-2 text-brand">
              <RocketIcon className="size-5" aria-hidden />
              <span className="text-[11px] font-semibold uppercase tracking-[0.1em]">
                Launch
              </span>
            </div>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-fg">
              You're ready
            </h1>
            <p className="text-[14px] text-fg-muted max-w-xl leading-relaxed">
              A session already exists in this workspace. Open it from Overview or
              start another from Sessions.
            </p>
          </header>
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={() => nav("/")}>Back to Overview</Button>
            <Button variant="secondary" onClick={() => nav("/sessions")}>
              View sessions
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl px-4 py-8 space-y-6">
        <header className="space-y-2">
          <div className="inline-flex items-center gap-2 text-brand">
            <RocketIcon className="size-5" aria-hidden />
            <span className="text-[11px] font-semibold uppercase tracking-[0.1em]">
              Launch
            </span>
          </div>
          <h1 className="font-display text-2xl font-semibold tracking-tight text-fg">
            {allDone ? "You're ready" : "Launch your first agent session"}
          </h1>
          <p className="text-[14px] text-fg-muted max-w-xl leading-relaxed">
            Ordered for how the platform works: sandbox and credentials before the first
            cloud run. Control plane is the same on{" "}
            <span className="text-fg">Cloudflare Workers</span> and{" "}
            <span className="text-fg">self-host k3s</span> — only the sandbox provider
            differs.
          </p>
        </header>

        <div
          className="flex items-center gap-3"
          role="progressbar"
          aria-valuenow={steps.filter((s) => s.done).length}
          aria-valuemin={0}
          aria-valuemax={steps.length}
        >
          <div className="flex flex-1 gap-1" aria-hidden>
            {steps.map((s) => (
              <span
                key={s.id}
                className={cn(
                  "h-1 flex-1 rounded-full",
                  s.done ? "bg-brand" : "bg-border",
                )}
              />
            ))}
          </div>
          <span className="text-[12px] tabular-nums text-fg-subtle">
            {steps.filter((s) => s.done).length}/{steps.length}
          </span>
        </div>

        <ol className="space-y-2" data-testid="launch-wizard-steps">
          {steps.map((step, i) => {
            const Icon = step.icon;
            const isFocus = i === focusIdx && !allDone;
            return (
              <li
                key={step.id}
                data-testid={`launch-step-${step.id}`}
                data-done={step.done ? "true" : "false"}
                className={cn(
                  "flex items-start gap-3 rounded-xl border p-4 transition-colors",
                  step.done
                    ? "border-border/60 bg-transparent"
                    : isFocus
                      ? "border-brand/40 bg-brand/[0.04] ring-1 ring-brand/15"
                      : "border-border bg-bg-surface/50",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg",
                    step.done
                      ? "bg-success/15 text-success"
                      : isFocus
                        ? "bg-brand/15 text-brand"
                        : "bg-bg-surface text-fg-muted ring-1 ring-border",
                  )}
                >
                  {step.done ? (
                    <CheckIcon className="size-4" aria-label="done" />
                  ) : (
                    <Icon className="size-4" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    {isFocus ? (
                      <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-brand">
                        Next
                      </span>
                    ) : null}
                    <span
                      className={cn(
                        "text-[14px] font-medium",
                        step.done ? "text-fg-muted line-through" : "text-fg",
                      )}
                    >
                      {step.title}
                    </span>
                    {step.optional ? (
                      <span className="text-[10px] text-fg-subtle uppercase tracking-wide">
                        optional
                      </span>
                    ) : null}
                  </div>
                  <p className="mt-1 text-[12px] text-fg-subtle leading-relaxed">{step.body}</p>
                </div>
                {!step.done && (
                  <Button
                    size="sm"
                    variant={isFocus ? "default" : "outline"}
                    className="shrink-0"
                    onClick={() => nav(step.to)}
                  >
                    {step.cta}
                    <ArrowRightIcon className="size-3.5" />
                  </Button>
                )}
              </li>
            );
          })}
        </ol>

        <div className="flex flex-wrap items-center gap-3 pt-2">
          {allRequiredDone && !allDone && !dismissedOptional ? (
            <Button
              variant="secondary"
              onClick={() =>
                nav(
                  firstAgentId
                    ? `/sessions?new=1&agent=${encodeURIComponent(firstAgentId)}`
                    : "/sessions?new=1",
                )
              }
            >
              Skip optionals — start session
            </Button>
          ) : null}
          {allDone ? (
            <Button onClick={() => nav(firstAgentId ? `/agents/${firstAgentId}` : "/agents")}>
              Open agent
            </Button>
          ) : null}
          <Link
            to="/"
            className="text-[13px] text-fg-muted hover:text-fg"
            onClick={() => setDismissedOptional(true)}
          >
            Back to Overview
          </Link>
        </div>

        <aside className="rounded-xl border border-border bg-bg-surface/40 p-4 text-[12px] text-fg-muted space-y-2">
          <div className="flex items-center gap-2 font-medium text-fg">
            <ShieldIcon className="size-3.5 text-brand" aria-hidden />
            Security boundary
          </div>
          <p className="leading-relaxed">
            Vault credentials and MCP OAuth tokens never enter the agent sandbox. The
            outbound proxy injects auth by host. Environment networking (limited hosts,
            allow_mcp_servers) is configured on the environment detail page — same on CF
            and k3s.
          </p>
          <div className="flex items-center gap-2 pt-1 text-fg-subtle">
            <ServerIcon className="size-3.5" aria-hidden />
            <span>
              Sandbox providers: Settings → Sandbox providers (availability differs by
              deployment; unavailable ones show a reason, not a silent fallback).
            </span>
          </div>
        </aside>

        {/* keep doneRequired referenced for a11y live region */}
        <span className="sr-only">{doneRequired} steps complete including optionals</span>
      </div>
    </div>
  );
}

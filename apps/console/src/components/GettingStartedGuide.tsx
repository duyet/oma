// "Getting started" — a state-aware onboarding checklist for the dashboard.
//
// StackedAssembly (right below it) answers "how do the pieces fit together";
// this panel answers the narrower first-run question "what do I do NOW". It
// reads the counts the dashboard already fetches (/v1/stats, /v1/sessions and
// the integration-installation counts StackedAssembly caches under the
// `dashboard-integration-counts` key), so it costs no extra round-trip and
// checks a step off the moment the real resource exists.
//
// Dismissal is persisted in localStorage — a returning user shouldn't have to
// re-dismiss it on every page load — and long-form explanation lives in a
// multi-step tour dialog rather than inline, so the panel stays four rows tall.
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { CheckIcon, ArrowRightIcon, XIcon, SparklesIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useApiQuery } from "../lib/useApiQuery";
import { Modal } from "./Modal";
import { AgentIcon, SessionsIcon, EnvIcon, VaultIcon } from "./icons";

export const GETTING_STARTED_DISMISSED_KEY = "oma.dashboard.getting-started.dismissed";
/** Marks that every setup step was complete on a prior visit. Combined with
 *  `allDone` on a later load, the guide auto-hides so a fully set-up
 *  tenant doesn't re-see "You're all set up" every Overview visit. The
 *  first time every step completes, the completion banner still shows. */
export const GETTING_STARTED_COMPLETED_KEY = "oma.dashboard.getting-started.completed";
/** Per page-load snapshot of COMPLETED_KEY — sessionStorage so React Strict
 *  Mode remounts re-read the same "before this load" value instead of the
 *  value this load just wrote (which would auto-hide the first completion). */
const COMPLETED_SNAPSHOT_KEY = "oma.dashboard.getting-started.completed-snapshot";

function readDismissed(): boolean {
  try {
    return localStorage.getItem(GETTING_STARTED_DISMISSED_KEY) === "1";
  } catch {
    // localStorage unavailable (private mode / quota) — show the guide.
    return false;
  }
}

function persistDismissed(): void {
  try {
    localStorage.setItem(GETTING_STARTED_DISMISSED_KEY, "1");
  } catch {
    // Non-fatal: the guide just reappears next load.
  }
}

function readCompletedSeen(): boolean {
  try {
    return localStorage.getItem(GETTING_STARTED_COMPLETED_KEY) === "1";
  } catch {
    return false;
  }
}

function persistCompletedSeen(): void {
  try {
    localStorage.setItem(GETTING_STARTED_COMPLETED_KEY, "1");
  } catch {
    // Non-fatal.
  }
}

/** Whether COMPLETED_KEY was already set *before* this page load. Cached in
 *  sessionStorage so a mid-load write to COMPLETED_KEY (or a Strict Mode
 *  remount) can't flip the decision for the first completion visit. */
function completedBeforeThisPageLoad(): boolean {
  try {
    const cached = sessionStorage.getItem(COMPLETED_SNAPSHOT_KEY);
    if (cached === "1" || cached === "0") return cached === "1";
    const v = readCompletedSeen();
    sessionStorage.setItem(COMPLETED_SNAPSHOT_KEY, v ? "1" : "0");
    return v;
  } catch {
    return readCompletedSeen();
  }
}

interface StatsShape {
  agents: number;
  sessions: number;
  environments: number;
  vaults: number;
}

interface GuideStep {
  id: string;
  title: string;
  body: string;
  cta: string;
  to: string;
  done: boolean;
  icon: (props: { className?: string }) => React.ReactElement;
}

/** Tour copy — the long-form version of each checklist row. Kept next to the
 *  steps so the two can't drift, but rendered only inside the dialog.
 *  Order matches the checklist: agent → environment → vault → session
 *  (cloud sessions need an environment before they can run). */
const TOUR_STEPS: {
  id: string;
  title: string;
  paragraphs: string[];
  to?: string;
  ctaLabel?: string;
  illustration: React.ReactElement;
}[] = [
  {
    id: "agent",
    title: "1 · Create an agent",
    paragraphs: [
      "An agent is a configuration, not a process: a model, a system prompt, and the tools it may use. Nothing runs until you start a session with it.",
      "Agents are versioned — every edit creates a new version, and sessions stay pinned to the version they started on.",
    ],
    to: "/agents/new",
    ctaLabel: "Create an agent",
    illustration: <AgentArt />,
  },
  {
    id: "environment",
    title: "2 · Shape the sandbox",
    paragraphs: [
      "An environment declares what the sandbox has: packages to install, which hosts it may reach, and which sandbox provider runs it (Cloudflare Containers, k3s, bridge daemon, …).",
      "Cloud sessions require an environment at create time — set one up before your first run. One environment is reusable across agents.",
    ],
    to: "/environments",
    ctaLabel: "Open environments",
    illustration: <EnvArt />,
  },
  {
    id: "vault",
    title: "3 · Add credentials safely",
    paragraphs: [
      "Vault credentials never enter the sandbox. An outbound proxy matches the request host and injects the auth header on the way out, so the agent can call an API it can never read the token for.",
      "Attach vaults when you start a session so MCP servers and git hosts authenticate. Channel integrations (GitHub, Slack, …) are separate — they live under Integrations.",
    ],
    to: "/vaults",
    ctaLabel: "Open vaults",
    illustration: <VaultArt />,
  },
  {
    id: "session",
    title: "4 · Start a session",
    paragraphs: [
      "A session is one conversation with an agent. It owns an append-only event log, so it can be streamed live, replayed, and resumed after a crash.",
      "Every tool the agent calls runs inside the session's sandbox — an isolated container with its own /workspace. Pick environment + vaults on create.",
    ],
    to: "/sessions?new=1",
    ctaLabel: "Start a session",
    illustration: <SessionArt />,
  },
];

export function GettingStartedGuide() {
  const nav = useNavigate();
  const [dismissed, setDismissed] = useState(readDismissed);
  const [tourOpen, setTourOpen] = useState(false);
  // Snapshot of "completed on a prior visit" for this page load. See
  // completedBeforeThisPageLoad — must not flip when we write COMPLETED_KEY
  // mid-session (first "You're all set up" visit must still show).
  const completedBefore = useRef(completedBeforeThisPageLoad()).current;

  // Same query keys the dashboard/StackedAssembly already use — TanStack
  // dedupes, so mounting this panel adds no network request.
  const statsQuery = useApiQuery<StatsShape>("/v1/stats");
  const sessionsQuery = useApiQuery<{ data: { id: string }[] }>("/v1/sessions", {
    limit: "5",
  });

  const stats = statsQuery.data;
  const hasSessions =
    (stats?.sessions ?? 0) > 0 || (sessionsQuery.data?.data.length ?? 0) > 0;

  // Order: agent → environment → vault → session. Cloud sessions need an
  // environment at create time; vaults are optional but must not complete
  // solely via channel integrations (those don't inject outbound creds).
  const steps: GuideStep[] = useMemo(
    () => [
      {
        id: "agent",
        title: "Create your first agent",
        body: "Pick a model, write a system prompt, choose the toolset.",
        cta: "New agent",
        to: "/agents/new",
        done: (stats?.agents ?? 0) > 0,
        icon: AgentIcon,
      },
      {
        id: "environment",
        title: "Shape the sandbox",
        body: "An environment sets packages, networking, and provider (CF, k3s, …).",
        cta: "Environments",
        to: "/environments",
        done: (stats?.environments ?? 0) > 0,
        icon: EnvIcon,
      },
      {
        id: "vault",
        title: "Add credentials safely",
        body: "Vaults inject tokens at the network layer — never into the sandbox.",
        cta: "Vaults",
        to: "/vaults",
        done: (stats?.vaults ?? 0) > 0,
        icon: VaultIcon,
      },
      {
        id: "session",
        title: "Start a session",
        body: "Talk to the agent with env + vaults attached — tools run in the sandbox.",
        cta: "New session",
        to: "/sessions?new=1",
        done: hasSessions,
        icon: SessionsIcon,
      },
    ],
    [stats?.agents, stats?.environments, stats?.vaults, hasSessions],
  );

  const doneCount = steps.filter((s) => s.done).length;
  const allDone = doneCount === steps.length;
  // First incomplete step is the only "do this next" target — visual
  // emphasis + a stronger CTA so operators don't scan four equal-weight rows.
  const nextStepId = steps.find((s) => !s.done)?.id ?? null;

  // Once every step is complete, remember it for the next visit. Returning
  // visits that already saw full completion auto-hide (no re-show). The
  // first visit that reaches allDone still shows "You're all set up".
  useEffect(() => {
    if (!allDone || dismissed) return;
    // Wait until stats have resolved so we don't act on a still-loading
    // zero-count snapshot.
    if (statsQuery.isLoading && !stats) return;
    if (completedBefore) {
      persistDismissed();
      setDismissed(true);
      return;
    }
    persistCompletedSeen();
  }, [allDone, dismissed, stats, statsQuery.isLoading, completedBefore]);

  if (dismissed) return null;

  function dismiss() {
    persistDismissed();
    if (allDone) persistCompletedSeen();
    setDismissed(true);
  }

  return (
    <section data-testid="getting-started-guide" aria-labelledby="getting-started-heading">
      <div className="relative overflow-hidden rounded-xl border border-border bg-bg-surface/40">
        {/* Decorative corner glyph — theme-aware via currentColor + opacity,
            so it reads as a faint watermark in both light and dark. */}
        <CornerArt className="pointer-events-none absolute -top-6 -right-6 hidden h-40 w-40 text-brand opacity-[0.07] sm:block" />

        <div className="relative p-5">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-lg bg-brand/10 text-brand">
              <SparklesIcon className="size-4" aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <h2
                id="getting-started-heading"
                className="font-display text-lg font-semibold text-fg"
              >
                {allDone ? "You're all set up" : "Getting started"}
              </h2>
              <p className="mt-0.5 text-[13px] text-fg-muted">
                {allDone
                  ? "Every setup step is done. Dismiss this panel anytime — you can keep working from Overview."
                  : "Four steps in dependency order: agent, sandbox, credentials, then a session. Steps tick off as you create things."}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {!allDone && (
                <>
                  <Button variant="secondary" size="sm" onClick={() => nav("/launch")}>
                    Launch wizard
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setTourOpen(true)}>
                    Take the tour
                  </Button>
                </>
              )}
              {allDone ? (
                <Button variant="secondary" size="sm" onClick={dismiss}>
                  Dismiss
                </Button>
              ) : (
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={dismiss}
                  aria-label="Dismiss getting started"
                >
                  <XIcon />
                </Button>
              )}
            </div>
          </div>

          {/* Progress — a plain segmented bar, one segment per step. */}
          <div
            className="mt-4 flex items-center gap-3"
            role="progressbar"
            aria-valuenow={doneCount}
            aria-valuemin={0}
            aria-valuemax={steps.length}
            aria-label={`${doneCount} of ${steps.length} setup steps complete`}
          >
            <div className="flex flex-1 gap-1" aria-hidden="true">
              {steps.map((s) => (
                <span
                  key={s.id}
                  className={cn(
                    "h-1 flex-1 rounded-full transition-colors",
                    s.done ? "bg-brand" : "bg-border",
                  )}
                />
              ))}
            </div>
            <span className="text-[12px] tabular-nums text-fg-subtle">
              {doneCount}/{steps.length} done
            </span>
          </div>

          <ol className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {steps.map((step) => {
              const Icon = step.icon;
              const isNext = !step.done && step.id === nextStepId;
              return (
                <li
                  key={step.id}
                  data-testid={`guide-step-${step.id}`}
                  data-done={step.done ? "true" : "false"}
                  data-next={isNext ? "true" : "false"}
                  className={cn(
                    "flex items-start gap-3 rounded-lg border p-3 transition-colors",
                    step.done
                      ? "border-border/60 bg-transparent"
                      : isNext
                        ? "border-brand/40 bg-brand/[0.04] ring-1 ring-brand/15"
                        : "border-border bg-bg-surface/60",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-md",
                      step.done
                        ? "bg-success/15 text-success"
                        : isNext
                          ? "bg-brand/15 text-brand"
                          : "bg-bg-surface text-fg-muted ring-1 ring-border",
                    )}
                  >
                    {step.done ? (
                      <CheckIcon className="size-3.5" aria-label="done" />
                    ) : (
                      <Icon className="size-3.5" />
                    )}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div
                      className={cn(
                        "text-[13px] font-medium",
                        step.done ? "text-fg-muted line-through" : "text-fg",
                      )}
                    >
                      {isNext ? (
                        <span className="mr-1.5 text-[10px] font-semibold uppercase tracking-[0.08em] text-brand">
                          Next
                        </span>
                      ) : null}
                      {step.title}
                    </div>
                    <p className="mt-0.5 text-[12px] text-fg-subtle">{step.body}</p>
                  </div>
                  {!step.done && (
                    <Button
                      variant={isNext ? "secondary" : "ghost"}
                      size="xs"
                      onClick={() => nav(step.to)}
                      className="shrink-0"
                    >
                      {step.cta}
                      <ArrowRightIcon />
                    </Button>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      <TourDialog
        open={tourOpen}
        onClose={() => setTourOpen(false)}
        onNavigate={(to) => {
          setTourOpen(false);
          nav(to);
        }}
      />
    </section>
  );
}

// ── Tour dialog ─────────────────────────────────────────────────────────
// Multi-step walkthrough. One step visible at a time with back/next so the
// reader isn't handed four screens of prose at once; the final step's
// primary button closes the tour instead of advancing.

function TourDialog({
  open,
  onClose,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  onNavigate: (to: string) => void;
}) {
  const [index, setIndex] = useState(0);
  const step = TOUR_STEPS[index];
  const isLast = index === TOUR_STEPS.length - 1;

  function close() {
    setIndex(0);
    onClose();
  }

  return (
    <Modal
      open={open}
      onClose={close}
      title="How oma works"
      subtitle={`Step ${index + 1} of ${TOUR_STEPS.length}`}
      maxWidth="max-w-xl"
      footer={
        <>
          <span className="mr-auto flex items-center gap-1.5" aria-hidden="true">
            {TOUR_STEPS.map((s, i) => (
              <span
                key={s.id}
                className={cn(
                  "size-1.5 rounded-full",
                  i === index ? "bg-brand" : "bg-border",
                )}
              />
            ))}
          </span>
          <Button
            variant="outline"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={index === 0}
          >
            Back
          </Button>
          {isLast ? (
            <Button onClick={close}>Done</Button>
          ) : (
            <Button onClick={() => setIndex((i) => Math.min(TOUR_STEPS.length - 1, i + 1))}>
              Next
            </Button>
          )}
        </>
      }
    >
      <div data-testid={`tour-step-${step.id}`} className="space-y-4">
        <div className="flex justify-center rounded-lg bg-bg-surface/60 py-4">
          {step.illustration}
        </div>
        <h3 className="font-display text-base font-semibold text-fg">{step.title}</h3>
        {step.paragraphs.map((p) => (
          <p key={p} className="text-[13px] leading-relaxed text-fg-muted">
            {p}
          </p>
        ))}
        {step.to && step.ctaLabel && (
          <Button variant="outline" size="sm" onClick={() => onNavigate(step.to!)}>
            {step.ctaLabel}
            <ArrowRightIcon />
          </Button>
        )}
      </div>
    </Modal>
  );
}

// ── Inline illustrations ────────────────────────────────────────────────
// Hand-rolled SVG, stroked with `currentColor` and tinted via Tailwind text
// colors, so both themes work with no per-theme asset. Deliberately small
// and schematic — they label the step, they don't explain it.

const artProps = {
  width: 132,
  height: 72,
  viewBox: "0 0 132 72",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  role: "presentation" as const,
};

function AgentArt() {
  return (
    <svg {...artProps} className="text-brand">
      <rect x="46" y="18" width="40" height="32" rx="8" />
      <circle cx="58" cy="32" r="2.5" />
      <circle cx="74" cy="32" r="2.5" />
      <path d="M58 41h16" />
      <path d="M66 18v-8M62 10h8" />
      <path d="M30 34h16M86 34h16" className="opacity-40" />
      <rect x="14" y="26" width="16" height="16" rx="4" className="opacity-40" />
      <rect x="102" y="26" width="16" height="16" rx="4" className="opacity-40" />
    </svg>
  );
}

function SessionArt() {
  return (
    <svg {...artProps} className="text-brand">
      <rect x="16" y="12" width="46" height="18" rx="6" />
      <rect x="70" y="30" width="46" height="18" rx="6" className="opacity-60" />
      <rect x="16" y="48" width="46" height="14" rx="6" className="opacity-40" />
      <path d="M62 21h8M70 39h-4" className="opacity-40" />
    </svg>
  );
}

function EnvArt() {
  return (
    <svg {...artProps} className="text-brand">
      <rect x="26" y="14" width="80" height="44" rx="8" />
      <path d="M26 26h80" />
      <circle cx="34" cy="20" r="1.5" />
      <circle cx="40" cy="20" r="1.5" />
      <circle cx="46" cy="20" r="1.5" />
      <path d="M38 38l-6 6 6 6" className="opacity-60" />
      <path d="M56 50l10-16" className="opacity-60" />
    </svg>
  );
}

function VaultArt() {
  return (
    <svg {...artProps} className="text-brand">
      <rect x="34" y="14" width="64" height="44" rx="8" />
      <circle cx="66" cy="36" r="10" />
      <path d="M66 30v6l4 3" />
      <path d="M18 36h16M98 36h16" className="opacity-40" />
    </svg>
  );
}

function CornerArt({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 120 120"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      className={className}
      role="presentation"
    >
      <circle cx="60" cy="60" r="46" />
      <circle cx="60" cy="60" r="30" />
      <circle cx="60" cy="60" r="14" />
      <path d="M60 0v120M0 60h120" />
    </svg>
  );
}

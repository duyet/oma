import { useCallback, useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import {
  ChevronDownIcon,
  PlusIcon,
  SettingsIcon,
  TerminalIcon,
  TimerIcon,
} from "lucide-react";
import { toast } from "sonner";
import { useApi } from "../lib/api";
import { formatQueryError, useApiQuery } from "../lib/useApiQuery";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Modal } from "../components/Modal";
import { ProviderMark } from "../components/ProviderMark";
import { RuntimesIcon } from "../components/icons";
import { ConnectMachineDialog } from "../components/ConnectMachineInstructions";
import { CopyButton } from "../components/CopyButton";
import { RegisterK8sClusterDialog } from "../components/RegisterK8sClusterDialog";
import { AddSandboxProviderDialog } from "./AddSandboxProviderDialog";
import { cn, rowActivateKeyDown } from "@/lib/utils";
import { useConfirm } from "@/hooks/useConfirm";
import {
  providerAvailabilityView,
  runtimeLabel,
} from "../lib/providerAvailability";
import type { ProviderAvailability } from "../lib/providerAvailability";
import { openSandboxTab } from "../lib/sandboxTab";

interface LocalSkill {
  id: string;
  name?: string;
  description?: string;
  source?: "global" | "plugin" | "project";
  source_label?: string;
}

interface Runtime {
  id: string;
  machine_id: string;
  hostname: string;
  os: string;
  agents: Array<{ id: string; binary?: string; version?: string }>;
  local_skills?: Record<string, LocalSkill[]>;
  version: string;
  status: "online" | "offline";
  last_heartbeat: number | null;
  created_at: number;
}

interface CapacityMetric {
  used: number;
  total: number;
  unit?: string;
}

interface ProviderCapacity {
  cpu?: CapacityMetric;
  memory?: CapacityMetric;
  pods?: CapacityMetric;
}

interface HostingType {
  id: string;
  label: string;
  description: string;
  type: "system" | "byok";
  provider: string;
  external: boolean;
  capabilities: string[];
  health: {
    status: "healthy" | "unhealthy" | "not_configured";
    latency_ms: number;
    last_checked: string;
    reason?: string;
    capacity?: ProviderCapacity;
  } | null;
  /**
   * Can this deployment run the provider at all — and if not, why. Optional
   * because an older backend won't send it; the view helper then falls back
   * to the neutral "available" rendering.
   */
  availability?: ProviderAvailability | null;
}

const HEALTH_REFRESH_INTERVAL_MS = 30_000;

const CAP_DISPLAY: Record<string, string> = {
  pause_resume: "Pause/Resume",
  cf_compatible: "CF Compatible",
  exec: "Exec",
  files: "Files",
};

const SYSTEM_PROVIDER_ENVS = [
  { env: "LITEBOX_MEMORY_MIB", label: "LiteBox (local micro-VM)", providerId: "litebox" },
  { env: "BOXRUN_URL", label: "BoxRun (remote micro-VM)", providerId: "boxrun" },
  { env: "DAYTONA_API_KEY", label: "Daytona SaaS", providerId: "daytona" },
  { env: "E2B_API_KEY", label: "E2B Firecracker microVM", providerId: "e2b" },
  { env: "OMA_K8S_NAMESPACE", label: "Kubernetes", providerId: "k8s" },
  { env: "K8S_BRIDGE_URL", label: "K8s Bridge (remote)", providerId: "k8s-bridge" },
  { env: "DOCKER_COMPOSE_PROJECT_DIR", label: "Docker Compose", providerId: "docker-compose" },
  { env: "GITHUB_ACTIONS_OWNER", label: "GitHub Actions sandbox", providerId: "github-actions" },
  { env: "REMOTE_AGENT_URL", label: "Remote Agent (BYOK)", providerId: "remote-agent" },
  { env: "OPENSHELL_GATEWAY_ENDPOINT", label: "NVIDIA OpenShell gateway", providerId: "openshell" },
];

// Command to bring an offline machine back — shown on offline machine cards
// and their detail dialog. `bridge restart` restarts the installed daemon
// service; if the machine was never set up it prints a hint to run
// `bridge setup` instead.
import { RECONNECT_CMD } from "../lib/bridge-commands";

function formatHeartbeat(unixSeconds: number): string {
  const ago = Math.floor(Date.now() / 1000) - unixSeconds;
  if (ago < 60) return `${ago}s ago`;
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  return `${Math.floor(ago / 86400)}d ago`;
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatCapacityValue(v: number, unit?: string): string {
  const rounded = Number.isInteger(v) ? v : Math.round(v * 10) / 10;
  return unit ? `${rounded}${unit === "cores" ? " vCPU" : ` ${unit}`}` : `${rounded}`;
}

function CapacityBar({ label, metric }: { label: string; metric: CapacityMetric }) {
  const pct = metric.total > 0 ? Math.min(100, Math.round((metric.used / metric.total) * 100)) : 0;
  const barColor = pct >= 90 ? "bg-destructive" : pct >= 70 ? "bg-warning" : "bg-success";
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between text-[10px] text-fg-subtle">
        <span>{label}</span>
        <span className="font-mono">
          {formatCapacityValue(metric.used, metric.unit)} / {formatCapacityValue(metric.total, metric.unit)}
        </span>
      </div>
      <div className="h-1 w-full rounded-full bg-bg-surface overflow-hidden">
        <div className={cn("h-full rounded-full", barColor)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function CapacityGauges({ capacity }: { capacity: ProviderCapacity }) {
  const entries: Array<[string, CapacityMetric | undefined]> = [
    ["CPU", capacity.cpu],
    ["Memory", capacity.memory],
    ["Pods", capacity.pods],
  ];
  const present = entries.filter((e): e is [string, CapacityMetric] => e[1] !== undefined);
  if (present.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      {present.map(([label, metric]) => (
        <CapacityBar key={label} label={label} metric={metric} />
      ))}
    </div>
  );
}

// OS brand marks for connected machines, keyed by the platform prefix of
// `runtime.os` (e.g. "darwin/arm64" → darwin). Single-path, currentColor —
// same convention as ProviderMark. Apple + Windows are Simple Icons marks
// (simple-icons.org, CC0-1.0); Linux uses a terminal glyph (lucide.dev, ISC)
// since Tux is a dense multi-curve path that doesn't reduce to one clean
// single-path mark.
function OsMark({ os, className }: { os: string; className?: string }) {
  const platform = os.split("/")[0]?.trim().toLowerCase() ?? "";
  if (platform === "darwin" || platform === "mac" || platform === "macos") {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
        <path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701" />
      </svg>
    );
  }
  if (platform === "win32" || platform === "windows" || platform === "win") {
    return (
      <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
        <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.9-1.801" />
      </svg>
    );
  }
  if (platform === "linux") {
    return (
      <svg
        viewBox="0 0 24 24"
        className={className}
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="m4 17 6-6-6-6M12 19h8" />
      </svg>
    );
  }
  // Unknown platform still gets a mark — a monitor glyph (lucide.dev, ISC) —
  // so the machine card's icon slot never collapses and the grid stays aligned.
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 5a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1ZM8 21h8M12 17v4" />
    </svg>
  );
}

// Shared "how do I actually use this provider" block for the detail dialogs.
// Sandbox providers aren't picked directly — an environment selects a
// sandbox provider and sessions select an environment — so the actionable
// next step is always "go configure an environment". Links to /environments
// (no /environments/new route exists; the list page owns the create dialog).
function UseInEnvironmentSection({
  providerId,
  onGo,
}: {
  providerId?: string;
  onGo: () => void;
}) {
  return (
    <div className="rounded-md border border-border bg-bg-surface/50 p-3 space-y-2">
      <div className="text-sm font-medium text-fg">Use in an environment</div>
      <p className="text-xs text-fg-muted leading-relaxed">
        Sandbox providers aren&rsquo;t selected directly. An{" "}
        <span className="text-fg">environment</span> picks a sandbox provider, and a session picks
        an environment. Create or edit an environment and set its sandbox provider
        {providerId ? (
          <>
            {" "}to{" "}
            <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">{providerId}</code>
          </>
        ) : null}{" "}to route work here.
      </p>
      <Button size="sm" variant="secondary" onClick={onGo}>
        Go to Environments →
      </Button>
    </div>
  );
}

// Health dot color + human label for a provider's current health status.
// Shared by the card and the detail dialog so the ternary ladder lives once.
function providerHealth(p: HostingType): {
  dot: string;
  label: string;
  status: "healthy" | "unhealthy" | "not_configured" | "na";
} {
  const status = p.health?.status ?? "na";
  const dot =
    status === "healthy"
      ? "bg-success"
      : status === "unhealthy"
        ? "bg-destructive"
        : "bg-fg-subtle";
  const label =
    status === "healthy"
      ? "Healthy"
      : status === "unhealthy"
        ? "Unhealthy"
        : status === "not_configured"
          ? "Not configured"
          : "N/A";
  return { dot, label, status };
}

// Env vars / secrets that would unblock a provider, as copy-friendly chips.
function MissingEnvChips({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {names.map((n) => (
        <code
          key={n}
          className="rounded bg-bg-surface px-1.5 py-0.5 font-mono text-[10px] text-fg-muted"
        >
          {n}
        </code>
      ))}
    </div>
  );
}

// Why a provider can't (or can't yet) be used on this deployment. Rendered on
// both the card and the detail dialog — the diagnostic is the whole point of
// this page, so it never hides behind a hover or a tooltip.
function AvailabilityNote({ p }: { p: HostingType }) {
  const view = providerAvailabilityView(p.availability);
  if (!view.reason) return null;
  return (
    <div
      className={cn(
        "rounded-md px-2 py-1.5 text-[11px] leading-relaxed space-y-1",
        view.state === "unavailable"
          ? "bg-bg-surface text-fg-muted"
          : "bg-warning-subtle/40 text-fg-muted",
      )}
    >
      <p>{view.reason}</p>
      <MissingEnvChips names={view.missingEnv} />
    </div>
  );
}

/**
 * Whether a sandbox provider belongs on the Online tab.
 * Healthy → online. Usable with no probe (or N/A health) → online — e.g.
 * Cloudflare Sandbox often has no live probe. Unhealthy / not_configured /
 * unavailable → offline so operators see what still needs setup.
 */
function isProviderOnline(p: HostingType): boolean {
  const availability = providerAvailabilityView(p.availability);
  if (!availability.usable) return false;
  const status = p.health?.status;
  if (status === "unhealthy" || status === "not_configured") return false;
  return true;
}

// Provider grid card — scannable summary + primary CTA only. Capabilities,
// capacity gauges, external flag, last-checked clock, and full ids live in
// ProviderDetailDialog (open on click). Diagnostics that block use
// (availability reason, unhealthy/not-configured reason) stay on the card
// so the grid answers "why isn't this ready?" without a click.
function ProviderCard({ p, onSetup, onRemove, onOpenDetail, onOpenSandboxTab }: { p: HostingType; onSetup?: (p: HostingType) => void; onRemove?: (p: HostingType) => void; onOpenDetail?: (p: HostingType) => void; onOpenSandboxTab?: () => void }) {
  const health = p.health;
  const { dot: healthDot, label: healthLabel, status } = providerHealth(p);
  const isBrowserVm = p.provider === "browser-vm";
  const availability = providerAvailabilityView(p.availability);
  const clickable = !!onOpenDetail;

  return (
    <Card
      size="sm"
      className={cn(
        "flex flex-col",
        !availability.usable && "opacity-70",
        clickable &&
          "cursor-pointer transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
      onClick={clickable ? () => onOpenDetail!(p) : undefined}
      onKeyDown={clickable ? rowActivateKeyDown(() => onOpenDetail!(p)) : undefined}
      tabIndex={clickable ? 0 : undefined}
      role={clickable ? "button" : undefined}
      title={clickable ? `${p.label} — open details` : p.label}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2.5">
          {/* Brand color = healthy; monochrome otherwise so working providers
              scan out of the grid without reading labels. */}
          <ProviderMark
            id={p.id}
            colored={status === "healthy"}
            className={cn(
              "size-4 shrink-0",
              status === "healthy" ? "text-fg" : "text-fg-subtle opacity-60",
            )}
          />
          <div className="flex-1 min-w-0">
            <CardTitle className="truncate text-[13px]">{p.label}</CardTitle>
          </div>
          <span className={cn("shrink-0 w-2 h-2 rounded-full", healthDot)} title={healthLabel} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 flex-1 pt-0">
        <p className="text-[11px] text-fg-muted leading-relaxed line-clamp-2">{p.description}</p>

        <div className="flex flex-wrap gap-1">
          <Badge
            variant={p.type === "system" ? "outline" : "secondary"}
            className="text-[10px] gap-1"
          >
            <ProviderMark
              id={p.provider || p.id}
              colored={status === "healthy"}
              className="size-2.5 shrink-0"
            />
            {p.type === "system" ? "System" : "BYOK"}
          </Badge>
          {p.external && (
            <Badge variant="outline" className="text-[10px]">External</Badge>
          )}
          {availability.badge && (
            <Badge
              variant={availability.usable ? "secondary" : "outline"}
              className={cn(
                "text-[10px]",
                availability.usable ? "text-warning" : "text-fg-subtle",
              )}
            >
              {availability.badge}
            </Badge>
          )}
        </div>

        <AvailabilityNote p={p} />

        <div className="mt-auto flex flex-col gap-2">
          {/* Compact health line — latency when healthy; no clock (detail has it). */}
          <div className="flex items-center gap-2 text-[11px] text-fg-subtle">
            {health ? (
              <span className="inline-flex items-center gap-1">
                <span className={cn("w-1.5 h-1.5 rounded-full", healthDot)} />
                {healthLabel}
                {status === "healthy" && (
                  <>
                    <span className="text-fg-muted mx-0.5">·</span>
                    <span className="inline-flex items-center gap-0.5">
                      <TimerIcon className="size-2.5" />
                      {formatLatency(health.latency_ms)}
                    </span>
                  </>
                )}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-fg-subtle" />
                Health N/A
              </span>
            )}
          </div>

          {status === "unhealthy" && health?.reason && (
            <p className="text-[11px] text-destructive leading-relaxed rounded-md bg-destructive/10 px-2 py-1.5">
              {health.reason}
            </p>
          )}

          {/* Browser VM → open a pairing tab (not a CLI setup flow). Keep the
              CTA on the card so first-run doesn't require opening details. */}
          {isBrowserVm && onOpenSandboxTab && availability.usable && (
            <div className="flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
              {status === "not_configured" && health?.reason && (
                <p className="text-[11px] text-fg-muted leading-relaxed">
                  {health.reason}
                </p>
              )}
              <Button
                size="sm"
                variant="secondary"
                className="w-full"
                onClick={onOpenSandboxTab}
              >
                Open sandbox tab
              </Button>
            </div>
          )}

          {status === "not_configured" && !isBrowserVm && availability.usable && (
            <div className="flex flex-col gap-2" onClick={(e) => e.stopPropagation()}>
              {health?.reason && (
                <p className="text-[11px] text-fg-muted leading-relaxed">
                  {health.reason}
                </p>
              )}
              {onSetup && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="w-full"
                  onClick={() => onSetup(p)}
                >
                  Set up
                </Button>
              )}
            </div>
          )}

          {p.type === "byok" && onRemove && (
            <Button
              size="sm"
              variant="ghost"
              className="w-full text-destructive hover:text-destructive"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(p);
              }}
            >
              Remove
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// Connected bridge-daemon machine. Same density rules as ProviderCard: one
// meta line + offline reconnect; agents list / skills / absolute timestamps
// live in MachineDetailDialog.
function MachineCard({ r, onRevoke, onOpenDetail, copied, onCopy }: { r: Runtime; onRevoke: (id: string) => void; onOpenDetail?: (r: Runtime) => void; copied: string | null; onCopy: (text: string, key: string) => void }) {
  const online = r.status === "online";
  const totalSkills = Object.values(r.local_skills ?? {}).reduce(
    (n, arr) => n + (arr?.length ?? 0),
    0,
  );
  const clickable = !!onOpenDetail;
  const agentSummary =
    r.agents.length === 0
      ? "No agents"
      : r.agents.length <= 2
        ? r.agents.map((a) => a.id).join(", ")
        : `${r.agents.length} agents`;

  return (
    <Card
      size="sm"
      className={cn(
        "flex flex-col",
        clickable &&
          "cursor-pointer transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
      onClick={clickable ? () => onOpenDetail!(r) : undefined}
      onKeyDown={clickable ? rowActivateKeyDown(() => onOpenDetail!(r)) : undefined}
      tabIndex={clickable ? 0 : undefined}
      role={clickable ? "button" : undefined}
      title={clickable ? `${r.hostname} — open details` : r.hostname}
    >
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2.5">
          <OsMark
            os={r.os}
            className={cn(
              "size-4 shrink-0",
              online ? "text-fg" : "text-fg-subtle opacity-60",
            )}
          />
          <div className="flex-1 min-w-0">
            <CardTitle className="truncate text-[13px]">{r.hostname}</CardTitle>
          </div>
          <span
            className={cn("shrink-0 w-2 h-2 rounded-full", online ? "bg-success" : "bg-fg-subtle")}
            title={r.status}
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-2 flex-1 pt-0">
        <div className="flex flex-wrap gap-1">
          <Badge variant="default" className="text-[10px]">Machine</Badge>
          <Badge variant="outline" className="text-[10px] inline-flex items-center gap-1">
            <OsMark os={r.os} className="size-2.5 shrink-0" />
            <span className="truncate max-w-[120px]">{r.os}</span>
          </Badge>
        </div>

        <div className="text-[11px] text-fg-muted leading-relaxed">
          <span className="font-mono text-fg">{agentSummary}</span>
          <span className="text-fg-subtle mx-1">·</span>
          <span>
            {r.last_heartbeat ? formatHeartbeat(r.last_heartbeat) : "No heartbeat"}
          </span>
          {totalSkills > 0 && (
            <>
              <span className="text-fg-subtle mx-1">·</span>
              <span>
                {totalSkills} skill{totalSkills === 1 ? "" : "s"}
              </span>
            </>
          )}
        </div>

        {/* Offline → show the reconnect command on-card; stopPropagation so
            copy/focus don't open the detail dialog. */}
        {!online && (
          <div
            className="rounded-md border border-border bg-bg-surface/50 p-2"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1">
              Reconnect — run on that machine
            </div>
            <CopyButton
              id={`reconnect-${r.id}`}
              text={RECONNECT_CMD}
              copied={copied}
              onCopy={onCopy}
              className="group w-full text-left rounded border border-border bg-bg px-2 py-1.5 flex items-center gap-2 hover:border-border-strong transition-colors"
              preClassName="flex-1 min-w-0 overflow-x-auto font-mono text-[11px] text-fg whitespace-nowrap"
            />
          </div>
        )}

        <div className="mt-auto flex items-center gap-2 text-[11px] text-fg-subtle">
          <span className="inline-flex items-center gap-1">
            <span className={cn("w-1.5 h-1.5 rounded-full", online ? "bg-success" : "bg-fg-subtle")} />
            {r.status}
          </span>
          {r.version && <span className="font-mono">v{r.version}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

// Label/value row for the detail dialogs — value right-aligned, allowed to
// wrap/break so long UUIDs don't force a horizontal scroll.
function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4">
      <span className="text-xs text-fg-subtle shrink-0 pt-0.5">{label}</span>
      <span className="text-sm text-fg text-right min-w-0 break-words">{children}</span>
    </div>
  );
}

// Everything known about a connected machine, plus its Revoke action mirrored
// from the card's row menu and the "use in an environment" next step.
function MachineDetailDialog({
  machine,
  onClose,
  onRevoke,
  onUseInEnvironment,
  copied,
  onCopy,
}: {
  machine: Runtime | null;
  onClose: () => void;
  onRevoke: (id: string) => void;
  onUseInEnvironment: () => void;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  if (!machine) return null;
  const r = machine;
  const online = r.status === "online";
  const skillGroups = Object.entries(r.local_skills ?? {}).filter(
    ([, s]) => s?.length,
  );
  return (
    <Modal
      open
      onClose={onClose}
      title={r.hostname}
      subtitle="Connected machine running the bridge daemon"
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => {
              onClose();
              onRevoke(r.id);
            }}
          >
            Revoke machine
          </Button>
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <DetailRow label="Runtime ID">
          <span className="font-mono text-xs text-fg break-all" title={r.id}>
            {r.id}
          </span>
        </DetailRow>
        <DetailRow label="Kind">Machine (bridge daemon)</DetailRow>
        <DetailRow label="Platform">
          <span className="inline-flex items-center gap-1.5">
            <OsMark os={r.os} className="size-3.5 shrink-0 text-fg-muted" />
            <span className="font-mono text-xs">{r.os}</span>
          </span>
        </DetailRow>
        <DetailRow label="Status">
          <span className="inline-flex items-center gap-1.5">
            <span className={cn("w-2 h-2 rounded-full", online ? "bg-success" : "bg-fg-subtle")} />
            {r.status}
          </span>
        </DetailRow>

        {!online && (
          <div className="rounded-md border border-border bg-bg-surface/50 p-3 space-y-2">
            <div className="text-sm font-medium text-fg">Reconnect this machine</div>
            <p className="text-xs text-fg-muted leading-relaxed">
              The daemon isn't attached right now. On{" "}
              <span className="text-fg">{r.hostname}</span>, run this to restart it (if it was
              never set up, it'll point you to <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">bridge setup</code>):
            </p>
            <CopyButton
              id={`reconnect-detail-${r.id}`}
              text={RECONNECT_CMD}
              copied={copied}
              onCopy={onCopy}
            />
          </div>
        )}
        {r.version && (
          <DetailRow label="Version">
            <span className="font-mono text-xs">v{r.version}</span>
          </DetailRow>
        )}
        <DetailRow label="Heartbeat">
          {r.last_heartbeat ? formatHeartbeat(r.last_heartbeat) : "—"}
        </DetailRow>
        <DetailRow label="Connected">
          {new Date(r.created_at * 1000).toLocaleString()}
        </DetailRow>

        <div>
          <div className="text-xs text-fg-subtle mb-1">Agents ({r.agents.length})</div>
          {r.agents.length === 0 ? (
            <p className="text-xs text-fg-muted">
              No ACP agents detected on this machine's $PATH.
            </p>
          ) : (
            <ul className="space-y-1">
              {r.agents.map((a) => (
                <li key={a.id} className="font-mono text-xs text-fg">
                  {a.id}
                  {a.binary && <span className="text-fg-subtle ml-1">({a.binary})</span>}
                  {a.version && <span className="text-fg-subtle ml-1">v{a.version}</span>}
                </li>
              ))}
            </ul>
          )}
        </div>

        {skillGroups.length > 0 && (
          <div>
            <div className="text-xs text-fg-subtle mb-1">Local skills</div>
            <div className="space-y-1.5">
              {skillGroups.map(([acpId, skills]) => (
                <div key={acpId}>
                  <div className="text-fg-subtle text-[10px] uppercase tracking-wider mb-0.5">
                    for {acpId}
                  </div>
                  <ul className="space-y-0.5">
                    {skills!.map((s) => (
                      <li
                        key={`${acpId}/${s.source_label ?? ""}/${s.id}`}
                        className="font-mono text-xs"
                      >
                        <span className="text-fg">{s.id}</span>
                        <span className="text-fg-subtle ml-1">
                          ({s.source ?? "global"}
                          {s.source_label ? `:${s.source_label}` : ""})
                        </span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        )}

        <UseInEnvironmentSection providerId="subprocess" onGo={onUseInEnvironment} />
      </div>
    </Modal>
  );
}

// Everything known about a sandbox provider, plus its Set up / Remove actions
// mirrored from the card and the "use in an environment" next step.
function ProviderDetailDialog({
  provider,
  onClose,
  onSetup,
  onRemove,
  onUseInEnvironment,
  onOpenSandboxTab,
}: {
  provider: HostingType | null;
  onClose: () => void;
  onSetup: (p: HostingType) => void;
  onRemove: (p: HostingType) => void;
  onUseInEnvironment: () => void;
  onOpenSandboxTab: () => void;
}) {
  if (!provider) return null;
  const p = provider;
  const health = p.health;
  const { dot: healthDot, label: healthLabel, status } = providerHealth(p);
  const isBrowserVm = p.provider === "browser-vm";
  const availability = providerAvailabilityView(p.availability);
  return (
    <Modal
      open
      onClose={onClose}
      title={p.label}
      subtitle={p.id}
      maxWidth="max-w-2xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          {isBrowserVm && availability.usable && (
            <Button variant="secondary" onClick={onOpenSandboxTab}>
              Open sandbox tab
            </Button>
          )}
          {status === "not_configured" && !isBrowserVm && availability.usable && (
            <Button
              variant="secondary"
              onClick={() => {
                onClose();
                onSetup(p);
              }}
            >
              Set up
            </Button>
          )}
          {p.type === "byok" && (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive"
              onClick={() => {
                onClose();
                onRemove(p);
              }}
            >
              Remove provider
            </Button>
          )}
        </>
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-fg-muted leading-relaxed">{p.description}</p>

        <DetailRow label="Provider ID">
          <span className="font-mono text-xs" title={p.id}>
            {p.id}
          </span>
        </DetailRow>
        <DetailRow label="Kind">
          {p.type === "system" ? "System provider" : "BYOK (bring your own key)"}
        </DetailRow>
        <DetailRow label="Provider">
          <span className="font-mono text-xs">{p.provider}</span>
        </DetailRow>
        <DetailRow label="External">
          {p.external ? "Yes — off-host service" : "No — runs on this host"}
        </DetailRow>
        <DetailRow label="Availability">
          {availability.state === "unavailable"
            ? "Not available on this deployment"
            : availability.state === "needs_config"
              ? "Supported — needs configuration"
              : "Available"}
        </DetailRow>
        <AvailabilityNote p={p} />
        <DetailRow label="Health">
          <span className="inline-flex items-center gap-1.5">
            <span className={cn("w-2 h-2 rounded-full", healthDot)} />
            {healthLabel}
            {status === "healthy" && health && (
              <span className="text-fg-subtle ml-1">· {formatLatency(health.latency_ms)}</span>
            )}
          </span>
        </DetailRow>
        {status === "healthy" && health?.last_checked && (
          <DetailRow label="Last checked">
            <span className="font-mono text-xs">
              {new Date(health.last_checked).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </DetailRow>
        )}
        {status === "unhealthy" && health?.reason && (
          <p className="text-[12px] text-destructive leading-relaxed rounded-md bg-destructive/10 px-2 py-1.5">
            {health.reason}
          </p>
        )}
        {status === "not_configured" && health?.reason && (
          <p className="text-[12px] text-fg-muted leading-relaxed">{health.reason}</p>
        )}

        <div>
          <div className="text-xs text-fg-subtle mb-1">Capabilities</div>
          {p.capabilities.length === 0 ? (
            <p className="text-xs text-fg-muted">None reported.</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {p.capabilities.map((cap) => (
                <Badge key={cap} variant="secondary" className="text-[10px]">
                  {CAP_DISPLAY[cap] ?? cap}
                </Badge>
              ))}
            </div>
          )}
        </div>

        {status === "healthy" && health?.capacity && (
          <div>
            <div className="text-xs text-fg-subtle mb-1.5">Capacity</div>
            <CapacityGauges capacity={health.capacity} />
          </div>
        )}

        <UseInEnvironmentSection providerId={p.id} onGo={onUseInEnvironment} />
      </div>
    </Modal>
  );
}

function SkeletonCard() {
  return (
    <Card size="sm">
      <CardHeader className="pb-2">
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-4 shrink-0 rounded" />
          <Skeleton className="h-4 w-32 flex-1" />
          <Skeleton className="shrink-0 w-2 h-2 rounded-full" />
        </div>
      </CardHeader>
      <CardContent className="space-y-2 pt-0">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
        <div className="flex gap-1">
          <Skeleton className="h-5 w-14 rounded-2xl" />
          <Skeleton className="h-5 w-16 rounded-2xl" />
        </div>
        <Skeleton className="h-3 w-24 mt-2" />
      </CardContent>
    </Card>
  );
}

// K8s provider ids — the family that routes to the register-cluster dialog
// rather than the bridge-daemon or env-var setup path. Matches the provider
// table in AGENTS.md § Sandbox Provider on the Cloudflare Deployment.
const K8S_PROVIDER_IDS = new Set(["k8s", "k8s-bridge", "k8s-remote", "openshell"]);

function isK8sProvider(p: HostingType): boolean {
  return K8S_PROVIDER_IDS.has(p.id) || K8S_PROVIDER_IDS.has(p.provider);
}

// Provider-specific setup content. Replaces the old hardcoded `bridge setup`
// modal that fired for EVERY not-configured provider (C8). Three branches:
//   - subprocess → bridge daemon instructions (the one case the old modal
//     was actually correct for)
//   - BYOK → reconfigure hint (BYOK providers are user-added; "Set up" only
//     surfaces when one is misconfigured)
//   - system (env-gated) → the env var(s) to set on the host
// K8s-family providers never reach this modal — `handleSetup` routes them
// straight to the RegisterK8sClusterDialog. This modal still handles a K8s
// provider defensively (bounce-to-register) in case the detail dialog's
// Set up button slips through.
function SetupProviderModal({
  provider,
  onClose,
  onOpenAddK8s,
  onOpenAddProvider,
}: {
  provider: HostingType | null;
  onClose: () => void;
  onOpenAddK8s: () => void;
  onOpenAddProvider: () => void;
}) {
  if (!provider) return null;
  const p = provider;

  if (isK8sProvider(p)) {
    return (
      <Modal
        open
        onClose={onClose}
        title={`Set up ${p.label}`}
        subtitle="Register a Kubernetes cluster"
        maxWidth="max-w-lg"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button
              onClick={() => {
                onClose();
                onOpenAddK8s();
              }}
            >
              Register a cluster
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-muted leading-relaxed">
          Pair a cluster by installing{" "}
          <span className="text-fg">oma-bridge-daemon</span> (outbound
          WebSocket worker — not the older{" "}
          <span className="text-fg">oma-k8s-bridge</span>). Default mode runs
          tools inside the daemon pod; OpenShell mode isolates each session.
        </p>
      </Modal>
    );
  }

  if (p.provider === "subprocess") {
    return (
      <Modal
        open
        onClose={onClose}
        title={`Set up ${p.label}`}
        subtitle="Run this on the machine you want to connect."
        maxWidth="max-w-3xl"
        footer={<Button onClick={onClose}>Done</Button>}
      >
        <div className="space-y-4 text-sm">
          <p className="text-fg-muted">
            Connect this host by starting the bridge daemon:
          </p>
          <div className="bg-bg-surface border border-border rounded-lg p-3 font-mono text-xs space-y-1">
            <div className="text-fg select-all">npx @getoma/cli bridge setup</div>
          </div>
          <p className="text-fg-muted text-xs">
            Setup opens this browser for OAuth, writes credentials to{" "}
            <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">~/.oma/bridge/</code>, and (on macOS) installs a launchd job
            that keeps the daemon running across reboots. Once connected, this provider flips to{" "}
            <span className="text-success">Healthy</span> and any ACP agents on <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">$PATH</code> appear as
            machines in the list behind this dialog.
          </p>
        </div>
      </Modal>
    );
  }

  if (p.type === "byok") {
    return (
      <Modal
        open
        onClose={onClose}
        title={`Set up ${p.label}`}
        subtitle="This is a provider you added."
        maxWidth="max-w-lg"
        footer={
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                onClose();
                onOpenAddProvider();
              }}
            >
              Add another provider
            </Button>
          </>
        }
      >
        <p className="text-sm text-fg-muted leading-relaxed">
          This sandbox provider was added with your own credentials. To change
          its configuration, remove it from its card&rsquo;s menu and add a new
          one with the updated details.
        </p>
      </Modal>
    );
  }

  // System provider gated by an env var. Find the matching env var name(s)
  // from the seed table so the operator sees exactly what to set.
  const envVars = SYSTEM_PROVIDER_ENVS.filter(
    (e) => e.providerId === p.id || e.providerId === p.provider,
  );
  return (
    <Modal
      open
      onClose={onClose}
      title={`Set up ${p.label}`}
      subtitle="Set the matching env var on the host and restart."
      maxWidth="max-w-lg"
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <div className="space-y-3 text-sm">
        <p className="text-fg-muted leading-relaxed">
          System sandbox providers are seeded from environment variables at
          startup. Set the matching variable(s) on the host and restart:
        </p>
        {envVars.length > 0 ? (
          <div className="bg-bg border border-border rounded-lg p-3 font-mono text-xs space-y-1 overflow-x-auto">
            {envVars.map(({ env }) => (
              <div key={env} className="text-fg whitespace-nowrap">{env}</div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-fg-subtle">
            See the &ldquo;How to enable additional sandbox providers&rdquo;
            section below for the full env-var list.
          </p>
        )}
        <p className="text-xs text-fg-subtle leading-relaxed">
          On Cloudflare, set these with{" "}
          <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">wrangler secret put</code>{" "}
          instead of a <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">.env</code> file.
        </p>
      </div>
    </Modal>
  );
}

export function RuntimesList() {
  const { api } = useApi();
  const navigate = useNavigate();
  // Single "Add" dropdown lists every setup path — connect machine, register
  // BYOK provider, register k8s cluster, open browser-vm tab. Dedicated
  // dialogs stay separate so close/reopen never restores a stale tab.
  const [connectOpen, setConnectOpen] = useState(false);
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const [setupProvider, setSetupProvider] = useState<HostingType | null>(null);
  const [registerK8sOpen, setRegisterK8sOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [tab, setTab] = useState<"online" | "offline">("online");
  const [detailProvider, setDetailProvider] = useState<HostingType | null>(null);
  const [detailMachine, setDetailMachine] = useState<Runtime | null>(null);
  const confirm = useConfirm();

  const goToEnvironments = () => {
    setDetailProvider(null);
    setDetailMachine(null);
    navigate("/environments");
  };

  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    toast.success("Copied");
    setTimeout(() => setCopied(null), 1600);
  };

  const openBrowserVmTab = useCallback(async () => {
    await openSandboxTab(api);
  }, [api]);

  const [providers, setProviders] = useState<HostingType[]>([]);
  const [deploymentRuntime, setDeploymentRuntime] = useState<string | null>(null);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);

  const loadProviders = useCallback(async (isBackground = false) => {
    if (!isBackground) setProvidersLoading(true);
    setProvidersError(null);
    try {
      const res = await api<{ data: HostingType[]; runtime?: string }>("/v1/hosting_types");
      if (Array.isArray(res.data)) setProviders(res.data);
      setDeploymentRuntime(res.runtime ?? null);
    } catch (err) {
      setProvidersError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      if (!isBackground) setProvidersLoading(false);
    }
  }, [api]);

  useEffect(() => {
    void loadProviders();
    const interval = setInterval(() => void loadProviders(true), HEALTH_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [loadProviders]);

  const {
    data: runtimesRes,
    isLoading: runtimesLoading,
    error: runtimesQueryError,
    refetch,
  } = useApiQuery<{ runtimes: Runtime[] }>(
    "/v1/runtimes",
    undefined,
    { refetchInterval: 15_000 },
  );
  const runtimes = runtimesRes?.runtimes ?? [];
  const runtimesError = formatQueryError(runtimesQueryError);

  const remove = async (id: string) => {
    if (
      !(await confirm({
        title: "Revoke this machine?",
        description: "The bridge daemon on that machine will stop being able to attach.",
        confirmLabel: "Revoke",
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/v1/runtimes/${id}`, { method: "DELETE" });
      void refetch();
    } catch { /* ignore */ }
  };

  const removeProvider = async (p: HostingType) => {
    if (
      !(await confirm({
        title: "Remove this sandbox provider?",
        description: "Environments pinned to it will fail to provision.",
        confirmLabel: "Remove",
        destructive: true,
      }))
    )
      return;
    try {
      await api(`/v1/sandbox_providers/${p.id}`, { method: "DELETE" });
      void loadProviders();
    } catch { /* ignore */ }
  };

  const deploymentLabel = runtimeLabel(deploymentRuntime);

  // One flat list: machines + providers, split only by Online / Offline.
  // No "Your machines" vs "Built-in providers" sections.
  const { onlineProviders, offlineProviders } = useMemo(() => {
    const online: HostingType[] = [];
    const offline: HostingType[] = [];
    for (const p of providers) {
      (isProviderOnline(p) ? online : offline).push(p);
    }
    return { onlineProviders: online, offlineProviders: offline };
  }, [providers]);

  const { onlineMachines, offlineMachines } = useMemo(() => {
    const online: Runtime[] = [];
    const offline: Runtime[] = [];
    for (const r of runtimes) (r.status === "online" ? online : offline).push(r);
    return { onlineMachines: online, offlineMachines: offline };
  }, [runtimes]);

  const onlineCount = onlineMachines.length + onlineProviders.length;
  const offlineCount = offlineMachines.length + offlineProviders.length;

  // Prefer the tab that has something to show on first paint.
  useEffect(() => {
    if (providersLoading || runtimesLoading) return;
    if (onlineCount === 0 && offlineCount > 0) setTab("offline");
  }, [providersLoading, runtimesLoading, onlineCount, offlineCount]);

  const loading = providersLoading || runtimesLoading;
  const isEmpty =
    !loading &&
    !providersError &&
    !runtimesError &&
    providers.length === 0 &&
    runtimes.length === 0;

  const handleSetup = useCallback((p: HostingType) => {
    if (isK8sProvider(p)) {
      setRegisterK8sOpen(true);
    } else {
      setSetupProvider(p);
    }
  }, []);

  function renderGrid(machines: Runtime[], providerList: HostingType[], emptyLabel: string) {
    if (machines.length === 0 && providerList.length === 0) {
      return (
        <div className="rounded-lg border border-dashed border-border bg-bg-surface/40 px-4 py-10 text-center">
          <p className="text-sm text-fg-muted">{emptyLabel}</p>
        </div>
      );
    }
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {machines.map((r) => (
          <MachineCard
            key={r.id}
            r={r}
            onRevoke={(id) => void remove(id)}
            onOpenDetail={setDetailMachine}
            copied={copied}
            onCopy={copy}
          />
        ))}
        {providerList.map((p) => (
          <ProviderCard
            key={p.id}
            p={p}
            onSetup={handleSetup}
            onRemove={removeProvider}
            onOpenDetail={setDetailProvider}
            onOpenSandboxTab={() => void openBrowserVmTab()}
          />
        ))}
      </div>
    );
  }

  return (
    <div role="main" aria-label="Sandbox providers" className="-m-3 p-4 space-y-6">
      <section>
        <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-lg font-semibold text-fg">Runtimes</h1>
              {deploymentLabel && (
                <Badge variant="outline" className="text-[10px] font-mono gap-1">
                  <ProviderMark
                    id={deploymentRuntime === "node" ? "subprocess" : "cloud"}
                    colored
                    className="size-3 shrink-0"
                  />
                  {deploymentLabel}
                </Badge>
              )}
              {!loading && onlineCount > 0 && (
                <Badge variant="secondary" className="text-[10px] gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-success" />
                  {onlineCount} online
                </Badge>
              )}
            </div>
            <p className="text-sm text-fg-subtle max-w-2xl">
              Everything that can host a sandbox — managed providers, BYOK backends,
              and paired machines — in one list. Filter by online or offline.
            </p>
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" className="gap-1.5 shrink-0">
                <PlusIcon className="size-3.5 shrink-0" />
                Add
                <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-64">
              <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-fg-subtle font-medium">
                Add a runtime
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="gap-2.5 py-2"
                onClick={() => setConnectOpen(true)}
              >
                <span className="flex size-7 items-center justify-center rounded-md bg-bg-surface border border-border shrink-0">
                  <TerminalIcon className="size-3.5 text-fg" />
                </span>
                <span className="flex flex-col min-w-0">
                  <span className="text-sm font-medium">Connect machine</span>
                  <span className="text-[11px] text-fg-muted truncate">
                    Pair a laptop via <span className="font-mono">oma bridge</span>
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2"
                onClick={() => setAddProviderOpen(true)}
              >
                <span className="flex size-7 items-center justify-center rounded-md bg-bg-surface border border-border shrink-0">
                  <ProviderMark id="e2b" colored className="size-3.5" />
                </span>
                <span className="flex flex-col min-w-0">
                  <span className="text-sm font-medium">Register provider</span>
                  <span className="text-[11px] text-fg-muted truncate">
                    E2B, Daytona, BoxRun, OpenShell, …
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2"
                onClick={() => setRegisterK8sOpen(true)}
              >
                <span className="flex size-7 items-center justify-center rounded-md bg-bg-surface border border-border shrink-0">
                  <ProviderMark id="k8s" colored className="size-3.5" />
                </span>
                <span className="flex flex-col min-w-0">
                  <span className="text-sm font-medium">Register k8s cluster</span>
                  <span className="text-[11px] text-fg-muted truncate">
                    Install bridge-daemon in-cluster
                  </span>
                </span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="gap-2.5 py-2"
                onClick={() => void openBrowserVmTab()}
              >
                <span className="flex size-7 items-center justify-center rounded-md bg-bg-surface border border-border shrink-0">
                  <ProviderMark id="browser-vm" colored className="size-3.5" />
                </span>
                <span className="flex flex-col min-w-0">
                  <span className="text-sm font-medium">Open sandbox tab</span>
                  <span className="text-[11px] text-fg-muted truncate">
                    Browser VM (WASM) host tab
                  </span>
                </span>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </section>

      <div className="rounded-md border border-border bg-bg-surface/50 px-3 py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
        <p className="text-xs text-fg-muted leading-relaxed">
          <span className="text-fg font-medium">Environment</span> picks a sandbox
          provider · <span className="text-fg font-medium">Session</span> picks that
          environment.
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="shrink-0 text-[12px] h-7"
          onClick={goToEnvironments}
        >
          Environments →
        </Button>
      </div>

      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {Array.from({ length: 4 }).map((_, i) => <SkeletonCard key={i} />)}
        </div>
      )}

      {providersError && (
        <div className="rounded-lg border border-border bg-bg-surface p-4 text-sm text-fg-muted flex items-center justify-between gap-3">
          <span>Failed to load providers: {providersError}</span>
          <Button size="sm" variant="outline" onClick={() => void loadProviders()}>
            Retry
          </Button>
        </div>
      )}

      {runtimesError && (
        <div className="rounded-lg border border-border bg-bg-surface p-4 text-sm text-fg-muted flex items-center justify-between gap-3">
          <span>Failed to load machines: {runtimesError}</span>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      )}

      {isEmpty && (
        <div className="rounded-lg border border-border bg-bg-surface p-6 text-center space-y-2">
          <p className="text-sm text-fg-muted">
            No runtimes yet. Use <span className="text-fg font-medium">Add</span> to
            connect a machine, register a provider, or open a browser sandbox tab.
          </p>
        </div>
      )}

      {!loading && !isEmpty && (
        <Tabs
          value={tab}
          onValueChange={(v) => setTab(v === "offline" ? "offline" : "online")}
        >
          <TabsList variant="line" className="w-full sm:w-auto">
            <TabsTrigger value="online" className="gap-2 px-4">
              <span className="w-2 h-2 rounded-full bg-success shrink-0" />
              Online
              <Badge variant="outline" className="text-[10px] font-mono tabular-nums">
                {onlineCount}
              </Badge>
            </TabsTrigger>
            <TabsTrigger value="offline" className="gap-2 px-4">
              <span className="w-2 h-2 rounded-full bg-fg-subtle shrink-0" />
              Offline
              <Badge variant="outline" className="text-[10px] font-mono tabular-nums">
                {offlineCount}
              </Badge>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="online" className="mt-4">
            {renderGrid(
              onlineMachines,
              onlineProviders,
              "Nothing online yet — connect a machine or wait for a provider health check.",
            )}
          </TabsContent>
          <TabsContent value="offline" className="mt-4">
            {renderGrid(
              offlineMachines,
              offlineProviders,
              "Nothing offline. Healthy providers and online machines live on the Online tab.",
            )}
          </TabsContent>
        </Tabs>
      )}

      <p className="text-xs text-fg-subtle">
        Sandboxes on Kubernetes? See{" "}
        <a
          href="https://docs.oma.duyet.net/deploy/k8s-sandbox-backends"
          target="_blank"
          rel="noreferrer"
          className="underline hover:text-brand"
        >
          docs.oma.duyet.net/deploy/k8s-sandbox-backends
        </a>{" "}
        or use{" "}
        <button
          type="button"
          onClick={() => setRegisterK8sOpen(true)}
          className="underline hover:text-brand"
        >
          Register a Kubernetes cluster
        </button>
        .
      </p>

      <details className="rounded-lg border border-border bg-bg-surface/50">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-fg select-none hover:text-fg">
          <span className="inline-flex items-center gap-2">
            <RuntimesIcon className="size-4 shrink-0 text-fg-subtle" />
            How to enable additional sandbox providers
          </span>
        </summary>
        <div className="px-4 pb-4 space-y-3 text-sm text-fg-muted">
          <p>
            System providers are seeded from environment variables at startup. Set the
            corresponding env var on the host and restart to enable the provider:
          </p>
          <div className="bg-bg border border-border rounded-lg p-3 font-mono text-xs space-y-1 overflow-x-auto">
            {SYSTEM_PROVIDER_ENVS.map(({ env, label, providerId }) => (
              <div key={env} className="flex items-center gap-2 whitespace-nowrap">
                <ProviderMark id={providerId} colored className="size-3.5 shrink-0 text-fg-subtle" />
                <span className="text-fg">{env}</span>
                <span className="text-fg-subtle">— {label}</span>
              </div>
            ))}
          </div>
          <p>For BYOK providers, use <span className="text-fg">Add → Register provider</span>.</p>
          <p className="text-xs text-fg-subtle">
            Docs:{" "}
            <a href="https://docs.oma.duyet.net/build/sandbox-providers" target="_blank" rel="noreferrer" className="underline hover:text-brand">
              docs.oma.duyet.net/build/sandbox-providers
            </a>
          </p>
        </div>
      </details>

      <SetupProviderModal
        provider={setupProvider}
        onClose={() => setSetupProvider(null)}
        onOpenAddK8s={() => setRegisterK8sOpen(true)}
        onOpenAddProvider={() => setAddProviderOpen(true)}
      />
      <ProviderDetailDialog
        provider={detailProvider}
        onClose={() => setDetailProvider(null)}
        onSetup={handleSetup}
        onRemove={removeProvider}
        onUseInEnvironment={goToEnvironments}
        onOpenSandboxTab={() => void openBrowserVmTab()}
      />
      <MachineDetailDialog
        machine={detailMachine}
        onClose={() => setDetailMachine(null)}
        onRevoke={(id) => void remove(id)}
        onUseInEnvironment={goToEnvironments}
        copied={copied}
        onCopy={copy}
      />
      <ConnectMachineDialog
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
        copied={copied}
        onCopy={copy}
      />
      <AddSandboxProviderDialog
        open={addProviderOpen}
        onClose={() => setAddProviderOpen(false)}
        onCreated={() => void loadProviders()}
      />
      <RegisterK8sClusterDialog
        open={registerK8sOpen}
        onClose={() => setRegisterK8sOpen(false)}
        copied={copied}
        onCopy={copy}
        onConnected={() => void refetch()}
      />
    </div>
  );
}

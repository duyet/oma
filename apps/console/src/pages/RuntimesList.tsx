import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { useNavigate } from "react-router";
import { XCircleIcon, TimerIcon } from "lucide-react";
import { toast } from "sonner";
import { useApi } from "../lib/api";
import { formatQueryError, useApiQuery } from "../lib/useApiQuery";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Modal } from "../components/Modal";
import { AddSandboxProviderDialog } from "./AddSandboxProviderDialog";
import { RowActionsMenu } from "../components/RowActionsMenu";
import { ProviderMark } from "../components/ProviderMark";
import { RuntimesIcon } from "../components/icons";
import { cn, rowActivateKeyDown } from "@/lib/utils";
import { useConfirm } from "@/hooks/useConfirm";

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
const RECONNECT_CMD = "npx @getoma/cli bridge restart";

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
      <div className="h-1.5 w-full rounded-full bg-bg-surface overflow-hidden">
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
    <div className="flex flex-col gap-1.5">
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

// Shared "how do I actually use this runtime" block for the detail dialogs.
// Runtimes aren't picked directly — an environment selects a sandbox
// provider and sessions select an environment — so the actionable next step
// is always "go configure an environment". Links to /environments (no
// /environments/new route exists; the list page owns the create dialog).
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
        Runtimes aren't selected directly. An{" "}
        <span className="text-fg">environment</span> picks a sandbox provider, and a session picks
        an environment. Create or edit an environment and set its sandbox provider
        {providerId ? (
          <>
            {" "}
            to{" "}
            <code className="bg-bg-surface px-1 rounded font-mono text-[11px]">{providerId}</code>
          </>
        ) : null}{" "}
        to route work here.
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

function ProviderCard({ p, onSetup, onRemove, onOpenDetail, onOpenSandboxTab }: { p: HostingType; onSetup?: (p: HostingType) => void; onRemove?: (p: HostingType) => void; onOpenDetail?: (p: HostingType) => void; onOpenSandboxTab?: () => void }) {
  const health = p.health;
  const { dot: healthDot, label: healthLabel, status } = providerHealth(p);
  const isBrowserVm = p.provider === "browser-vm";

  const clickable = !!onOpenDetail;

  return (
    <Card
      size="sm"
      className={cn(
        "flex flex-col",
        clickable &&
          "cursor-pointer transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
      )}
      onClick={clickable ? () => onOpenDetail!(p) : undefined}
      onKeyDown={clickable ? rowActivateKeyDown(() => onOpenDetail!(p)) : undefined}
      tabIndex={clickable ? 0 : undefined}
      role={clickable ? "button" : undefined}
    >
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-start gap-2.5">
            {/* Brand color reads as "this is live". Anything not healthy —
                unhealthy, not configured, no health reported — drops to the
                monochrome glyph so the grid can be scanned for working
                runtimes without reading a single word. */}
            <ProviderMark
              id={p.id}
              colored={status === "healthy"}
              className={cn(
                "mt-0.5 size-5 shrink-0",
                status === "healthy" ? "text-fg" : "text-fg-subtle opacity-60",
              )}
            />
            <div className="min-w-0">
              <CardTitle className="truncate">{p.label}</CardTitle>
              <div className="text-xs text-fg-subtle font-mono mt-0.5 truncate" title={p.id}>{p.id}</div>
            </div>
          </div>
          <span className={cn("shrink-0 w-2.5 h-2.5 rounded-full mt-1.5", healthDot)} title={healthLabel} />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 flex-1">
        <p className="text-xs text-fg-muted leading-relaxed">{p.description}</p>

        <div className="flex flex-wrap gap-1">
          {p.type === "system" ? (
            <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
              System provider
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px]">BYOK</Badge>
          )}
          {p.external && (
            <Badge variant="outline" className="text-[10px]">External</Badge>
          )}
        </div>

        {p.capabilities.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {p.capabilities.map((cap) => (
              <Badge key={cap} variant="secondary" className="text-[10px]">
                {CAP_DISPLAY[cap] ?? cap}
              </Badge>
            ))}
          </div>
        )}

        <div className="mt-auto flex flex-col gap-2">
          {/* Status line */}
          <div className="flex items-center gap-3 text-[11px] text-fg-subtle">
            {health && (
              <>
                <span className="inline-flex items-center gap-1">
                  <span className={cn("w-1.5 h-1.5 rounded-full", healthDot)} />
                  {healthLabel}
                </span>
                {status === "healthy" && (
                  <>
                    <span className="inline-flex items-center gap-1">
                      <TimerIcon className="size-3" />
                      {formatLatency(health.latency_ms)}
                    </span>
                    <span className="font-mono">
                      {new Date(health.last_checked).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    </span>
                  </>
                )}
              </>
            )}
            {!health && (
              <span className="inline-flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-fg-subtle" />
                Health N/A
              </span>
            )}
          </div>

          {/* Capacity gauges (only when the provider reports them) */}
          {status === "healthy" && health?.capacity && (
            <CapacityGauges capacity={health.capacity} />
          )}

          {/* Unhealthy reason */}
          {status === "unhealthy" && health?.reason && (
            <p className="text-[11px] text-destructive leading-relaxed rounded-md bg-destructive/10 px-2 py-1.5">
              {health.reason}
            </p>
          )}

          {/* Browser VM → a pairing code + a new tab, not a CLI daemon.
              Shown regardless of health so a user can open another tab
              (or reopen a closed one) at any time. */}
          {isBrowserVm && onOpenSandboxTab && (
            <div className="flex flex-col gap-2">
              {status === "not_configured" && health?.reason && (
                <p className="text-[11px] text-fg-muted leading-relaxed">
                  {health.reason}
                </p>
              )}
              <Button
                size="sm"
                variant="secondary"
                className="w-full"
                onClick={(e) => {
                  e.stopPropagation();
                  onOpenSandboxTab();
                }}
              >
                Open sandbox tab
              </Button>
            </div>
          )}

          {/* Not configured → offer setup */}
          {status === "not_configured" && !isBrowserVm && (
            <div className="flex flex-col gap-2">
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
                  onClick={(e) => {
                    e.stopPropagation();
                    onSetup(p);
                  }}
                >
                  Set up
                </Button>
              )}
            </div>
          )}

          {/* BYOK → allow removal */}
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

// A user-connected machine running `oma bridge daemon`, rendered in the
// same grid as sandbox providers so the page reads as one unified list of
// "places an agent can run".
function MachineCard({ r, onRevoke, onOpenDetail, copied, onCopy }: { r: Runtime; onRevoke: (id: string) => void; onOpenDetail?: (r: Runtime) => void; copied: string | null; onCopy: (text: string, key: string) => void }) {
  const online = r.status === "online";
  const totalSkills = Object.values(r.local_skills ?? {}).reduce(
    (n, arr) => n + (arr?.length ?? 0),
    0,
  );
  const clickable = !!onOpenDetail;
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
    >
      <CardHeader>
        {/* min-w-0 on this flex row + the left column lets the UUID id truncate
            instead of forcing the card wider. */}
        <div className="flex items-start justify-between gap-2 min-w-0">
          {/* Machines get an icon slot too, so they line up with the provider
              cards in the same grid instead of starting flush left. The OS
              mark is the identifying logo here (a Mac is a Mac); it goes
              full-color-ish when online and dims when the daemon is gone. */}
          <div className="flex min-w-0 items-start gap-2.5">
            <OsMark
              os={r.os}
              className={cn(
                "mt-0.5 size-5 shrink-0",
                online ? "text-fg" : "text-fg-subtle opacity-60",
              )}
            />
            <div className="min-w-0">
            <CardTitle className="truncate">{r.hostname}</CardTitle>
            <div className="text-xs text-fg-subtle font-mono mt-0.5 truncate" title={r.id}>{r.id}</div>
            </div>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <span
              className={cn("w-2.5 h-2.5 rounded-full", online ? "bg-success" : "bg-fg-subtle")}
              title={r.status}
            />
            <RowActionsMenu
              label={`Actions for ${r.hostname}`}
              actions={[
                {
                  label: "Revoke",
                  icon: <XCircleIcon className="size-4" />,
                  destructive: true,
                  onSelect: () => onRevoke(r.id),
                },
              ]}
            />
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 flex-1">
        <div className="flex flex-wrap gap-1">
          <Badge variant="default" className="text-[10px] uppercase tracking-wider">
            Machine
          </Badge>
          <Badge variant="outline" className="text-[10px] inline-flex items-center gap-1">
            <OsMark os={r.os} className="size-3 shrink-0" />
            {r.os}
          </Badge>
        </div>

        <div className="text-xs text-fg-muted space-y-1">
          <div>
            <span className="text-fg-subtle">Agents:</span>{" "}
            <span className="font-mono">
              {r.agents.length === 0 ? "—" : r.agents.map((a) => a.id).join(", ")}
            </span>
          </div>
          <div>
            <span className="text-fg-subtle">Heartbeat:</span>{" "}
            {r.last_heartbeat ? formatHeartbeat(r.last_heartbeat) : "—"}
          </div>
        </div>

        {totalSkills > 0 && (
          <details className="text-xs" onClick={(e) => e.stopPropagation()}>
            <summary className="cursor-pointer text-fg-muted hover:text-fg select-none">
              {totalSkills} local skill{totalSkills === 1 ? "" : "s"} detected
            </summary>
            <div className="mt-1.5 ml-2 space-y-1.5">
              {Object.entries(r.local_skills ?? {}).map(([acpId, skills]) =>
                !skills?.length ? null : (
                  <div key={acpId}>
                    <div className="text-fg-subtle text-[10px] uppercase tracking-wider mb-0.5">
                      for {acpId}
                    </div>
                    <ul className="space-y-0.5">
                      {skills.map((s) => (
                        <li key={`${acpId}/${s.source_label ?? ""}/${s.id}`} className="font-mono">
                          <span className="text-fg">{s.id}</span>
                          <span className="text-fg-subtle ml-1">
                            ({s.source ?? "global"}{s.source_label ? `:${s.source_label}` : ""})
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ),
              )}
            </div>
          </details>
        )}

        {/* Offline → the daemon isn't attached; show the one command that brings
            it back. stopPropagation so copying doesn't open the detail dialog. */}
        {!online && (
          <div className="rounded-md border border-border bg-bg-surface/50 p-2" onClick={(e) => e.stopPropagation()}>
            <div className="text-[10px] uppercase tracking-wider text-fg-subtle mb-1">Reconnect — run on that machine</div>
            <button
              onClick={() => onCopy(RECONNECT_CMD, `reconnect-${r.id}`)}
              aria-label={`Copy reconnect command for ${r.hostname}`}
              className="group w-full text-left rounded border border-border bg-bg px-2 py-1.5 flex items-center gap-2 hover:border-border-strong transition-colors"
            >
              <span className="flex-1 min-w-0 overflow-x-auto font-mono text-[11px] text-fg whitespace-nowrap">{RECONNECT_CMD}</span>
              <span className="shrink-0 text-fg-subtle group-hover:text-fg"><ClipboardIcon ok={copied === `reconnect-${r.id}`} /></span>
            </button>
          </div>
        )}

        <div className="mt-auto flex items-center gap-3 text-[11px] text-fg-subtle">
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
            <CopyBlock id={`reconnect-detail-${r.id}`} text={RECONNECT_CMD} copied={copied} onCopy={onCopy} />
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
          {isBrowserVm && (
            <Button variant="secondary" onClick={onOpenSandboxTab}>
              Open sandbox tab
            </Button>
          )}
          {status === "not_configured" && !isBrowserVm && (
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
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="space-y-2 flex-1">
            <Skeleton className="h-4 w-32" />
            <Skeleton className="h-3 w-20" />
          </div>
          <Skeleton className="shrink-0 w-2.5 h-2.5 rounded-full mt-1.5" />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-3/4" />
        <div className="flex gap-1">
          <Skeleton className="h-5 w-14 rounded-2xl" />
          <Skeleton className="h-5 w-16 rounded-2xl" />
        </div>
        <Skeleton className="h-3 w-24" />
      </CardContent>
    </Card>
  );
}

function ClipboardIcon({ ok }: { ok: boolean }) {
  return ok ? (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>
  ) : (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
  );
}

/** Click-to-copy shell block. Multi-line commands scroll rather than wrap —
 *  a wrapped `\` continuation is easy to mis-copy by hand. */
function CopyBlock({
  id,
  text,
  copied,
  onCopy,
}: {
  id: string;
  text: string;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  return (
    <button
      onClick={() => onCopy(text, id)}
      aria-label={`Copy: ${text.split("\n")[0]}`}
      className="group w-full text-left rounded-md border border-border bg-bg p-3 flex items-start gap-3 hover:border-border-strong transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
    >
      <pre className="flex-1 min-w-0 overflow-x-auto font-mono text-xs leading-relaxed text-fg">
        {text}
      </pre>
      <span className="shrink-0 mt-0.5 text-fg-subtle group-hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">
        <ClipboardIcon ok={copied === id} />
      </span>
    </button>
  );
}

// Quickstart moved here from the Dashboard — installing the CLI and minting a
// key is what you do right before connecting a runtime. Lives inside the
// provider set-up dialog rather than on the page, so `onNavigate` lets the
// host dismiss that dialog before a step routes away from it.
function CliQuickstart({ onNavigate }: { onNavigate?: () => void }) {
  const nav = useNavigate();
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string, key: string) => {
    navigator.clipboard.writeText(text);
    setCopied(key);
    toast.success("Copied");
    setTimeout(() => setCopied(null), 1600);
  };

  const cmd = "npx -y -p @getoma/cli oma";
  const cmdGlobal = "npm i -g @getoma/cli";
  const examplePrompt =
    "Use oma to create a research agent that monitors arXiv for new ML papers daily";

  const CopyIcon = ({ ok }: { ok: boolean }) =>
    ok ? (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>
    ) : (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" /></svg>
    );

  return (
    <section role="region" aria-label="CLI quickstart" className="border border-border rounded-lg overflow-hidden">
      {/* Step 1 */}
      <div className="grid md:grid-cols-[180px_1fr] gap-x-6 gap-y-2 p-5 md:p-6 border-b border-border">
        <div>
          <div className="font-mono text-[11px] tracking-wider text-brand">STEP 01</div>
          <div className="mt-1 font-medium text-fg text-[15px]">Install the CLI</div>
        </div>
        <div className="space-y-2.5 min-w-0">
          <p className="text-sm text-fg-muted">
            The <code className="font-mono text-[13px] text-fg">oma</code> CLI lets your
            agent (or you) drive the platform from the terminal.
          </p>
          <button
            onClick={() => copy(cmd, "cmd")}
            className="group w-full sm:w-auto sm:inline-flex items-center gap-3 pl-3 pr-2 py-2 rounded-md border border-border bg-bg-surface/50 hover:border-border-strong transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] text-left"
          >
            <span className="text-fg-subtle select-none font-mono text-xs">›</span>
            <span className="font-mono text-[13px] text-fg flex-1 truncate">{cmd}</span>
            <span className="shrink-0 text-fg-subtle group-hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] p-1">
              <CopyIcon ok={copied === "cmd"} />
            </span>
          </button>
          <p className="text-[12px] text-fg-subtle">
            or globally:{" "}
            <button
              onClick={() => copy(cmdGlobal, "cmd-global")}
              className="inline-flex items-center min-h-11 sm:min-h-0 font-mono text-fg-muted hover:text-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
            >
              {cmdGlobal}
            </button>
          </p>
        </div>
      </div>

      {/* Step 2 */}
      <div className="grid md:grid-cols-[180px_1fr] gap-x-6 gap-y-2 p-5 md:p-6 border-b border-border">
        <div>
          <div className="font-mono text-[11px] tracking-wider text-brand">STEP 02</div>
          <div className="mt-1 font-medium text-fg text-[15px]">Mint an API key</div>
        </div>
        <div className="space-y-2.5">
          <p className="text-sm text-fg-muted">
            Your agent needs this to authenticate. Keep it somewhere it can read.
          </p>
          <button
            onClick={() => {
              onNavigate?.();
              nav("/api-keys");
            }}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 bg-brand text-brand-fg rounded-md text-[13px] font-medium hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            Generate API key
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
          </button>
        </div>
      </div>

      {/* Step 3 */}
      <div className="grid md:grid-cols-[180px_1fr] gap-x-6 gap-y-2 p-5 md:p-6">
        <div>
          <div className="font-mono text-[11px] tracking-wider text-brand">STEP 03</div>
          <div className="mt-1 font-medium text-fg text-[15px]">Hand it the reins</div>
        </div>
        <div className="space-y-2.5 min-w-0">
          <p className="text-sm text-fg-muted">
            Point your agent at the <code className="font-mono text-[13px] text-fg">oma-cli</code>{" "}
            or <code className="font-mono text-[13px] text-fg">oma-api</code> skill, then
            ask for what you want:
          </p>
          <button
            onClick={() => copy(examplePrompt, "prompt")}
            className="group w-full text-left rounded-md border border-border bg-bg-surface/50 hover:border-border-strong transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] p-3 flex items-start gap-3"
          >
            <span className="shrink-0 mt-0.5 font-mono text-[10px] tracking-wider text-fg-subtle">
              PROMPT
            </span>
            <span className="flex-1 text-[13px] text-fg leading-snug">{examplePrompt}</span>
            <span className="shrink-0 text-fg-subtle group-hover:text-fg transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)] mt-0.5">
              <CopyIcon ok={copied === "prompt"} />
            </span>
          </button>
        </div>
      </div>
    </section>
  );
}

export function RuntimesList() {
  const { api } = useApi();
  const navigate = useNavigate();
  const [showInstructions, setShowInstructions] = useState(false);
  const [setupProvider, setSetupProvider] = useState<HostingType | null>(null);
  const [showAddProvider, setShowAddProvider] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  // Click-through detail dialogs — one card at a time (providers and machines
  // never both open at once, but each has its own state so their content
  // components stay simple).
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

  // Browser VM's "runtime" is a paired browser tab, not a CLI daemon — so
  // instead of showing setup instructions, mint a one-time pairing code
  // (same endpoint + state semantics as ConnectRuntime.tsx, just generated
  // client-side since there's no loopback CLI to originate it here) and
  // open the host page directly. `api()` already toasts unauthenticated /
  // network failures, so a thrown error needs no further handling here.
  const openBrowserVmTab = useCallback(async () => {
    try {
      const state = crypto.randomUUID().replace(/-/g, "");
      const { code } = await api<{ code: string; expires_at: number }>(
        "/v1/runtimes/connect-runtime",
        { method: "POST", body: JSON.stringify({ state }) },
      );
      const url = new URL("/sandbox-tab", window.location.origin);
      url.searchParams.set("code", code);
      url.searchParams.set("state", state);
      window.open(url.toString(), "_blank", "noopener,noreferrer");
    } catch {
      // Already surfaced via toast by useApi().
    }
  }, [api]);

  const [providers, setProviders] = useState<HostingType[]>([]);
  const [providersLoading, setProvidersLoading] = useState(true);
  const [providersError, setProvidersError] = useState<string | null>(null);

  // `isBackground` suppresses the loading skeleton for the periodic
  // health/capacity refresh so the cards don't flash every 30s — only the
  // initial load (and manual retries) show the skeleton state.
  const loadProviders = useCallback(async (isBackground = false) => {
    if (!isBackground) setProvidersLoading(true);
    setProvidersError(null);
    try {
      const res = await api<{ data: HostingType[] }>("/v1/hosting_types");
      if (Array.isArray(res.data)) setProviders(res.data);
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
        title: "Revoke this runtime?",
        description: "Daemon on that machine will stop being able to attach.",
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

  const loading = providersLoading || runtimesLoading;
  const isEmpty =
    !loading &&
    !providersError &&
    !runtimesError &&
    providers.length === 0 &&
    runtimes.length === 0;

  return (
    <div role="main" aria-label="Sandbox Runtime" className="-m-3 p-4 space-y-10">
      {/* Unified: sandbox providers + connected machines in one grid.
          System providers come from host env vars, BYOK providers from
          the API, machines from `oma bridge daemon` — but to a user they
          are all just "where can my agent's sandbox run". */}
      <section role="region" aria-label="Runtimes">
        <div className="mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold text-fg">Runtimes</h2>
            <p className="text-sm text-fg-subtle mt-0.5">
              Everywhere a sandbox can run — system providers on this host,
              BYOK providers, and machines you connected via{" "}
              <code className="text-xs bg-bg-surface px-1 py-0.5 rounded font-mono">oma bridge daemon</code>
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <Button size="sm" variant="secondary" onClick={() => setShowAddProvider(true)}>
              + Add provider
            </Button>
            <Button size="sm" onClick={() => setShowInstructions(true)}>
              + Connect machine
            </Button>
          </div>
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
          <div className="mt-3 rounded-lg border border-border bg-bg-surface p-4 text-sm text-fg-muted flex items-center justify-between gap-3">
            <span>Failed to load runtimes: {runtimesError}</span>
            <Button size="sm" variant="outline" onClick={() => void refetch()}>
              Retry
            </Button>
          </div>
        )}

        {isEmpty && (
          <div className="rounded-lg border border-border bg-bg-surface p-4 text-sm text-fg-muted">
            No runtimes yet. Add a sandbox provider, or run{" "}
            <code className="text-xs bg-bg px-1 py-0.5 rounded">npx @getoma/cli bridge setup</code>{" "}
            on a machine you want to connect.
          </div>
        )}

        {!loading && (providers.length > 0 || runtimes.length > 0) && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {providers.map((p) => (
              <ProviderCard
                key={p.id}
                p={p}
                onSetup={setSetupProvider}
                onRemove={removeProvider}
                onOpenDetail={setDetailProvider}
                onOpenSandboxTab={() => void openBrowserVmTab()}
              />
            ))}
            {runtimes.map((r) => (
              <MachineCard
                key={r.id}
                r={r}
                onRevoke={(id) => void remove(id)}
                onOpenDetail={setDetailMachine}
                copied={copied}
                onCopy={copy}
              />
            ))}
          </div>
        )}
      </section>

      {/* Kubernetes install help. Steps mirror charts/oma-k8s-bridge/README.md
          — keep them in sync if the chart's install flow changes. Deliberately
          shows the create-Secret-out-of-band path rather than `--set
          secret.token=...`: the latter lands a real token in `helm history`
          and shell history, and is for local testing only. */}
      <details className="rounded-lg border border-border bg-bg-surface/50">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-fg select-none hover:text-fg">
          <span className="inline-flex items-center gap-2">
            <ProviderMark id="k8s" colored className="size-4 shrink-0 text-fg-subtle" />
            Run sandboxes on Kubernetes (Helm)
          </span>
        </summary>
        <div className="px-4 pb-4 space-y-3 text-sm text-fg-muted">
          <p>
            A Cloudflare Worker can't load a kubeconfig, so sandboxes on Kubernetes
            run behind the <span className="text-fg">oma-k8s-bridge</span> — a small
            token-gated HTTP service you install in the cluster. Deploy the bridge,
            point OMA at it, and{" "}
            <span className="text-fg">K8s Bridge (remote)</span> turns{" "}
            <span className="text-success">Healthy</span> above.
          </p>
          <p className="text-xs text-fg-subtle">
            This is the <code className="bg-bg-surface px-1 rounded">k8s-bridge</code>{" "}
            provider. Not to be confused with{" "}
            <code className="bg-bg-surface px-1 rounded">k8s</code>, which needs a local
            kubeconfig and only runs on the self-host Node runtime.
          </p>

          <div>
            <div className="text-xs text-fg-subtle mb-1.5">
              1 · Create the bearer token the bridge requires, as a Secret
            </div>
            <CopyBlock
              id="k8s-secret"
              copied={copied}
              onCopy={copy}
              text={
                "kubectl create namespace sandboxes\n" +
                "kubectl -n sandboxes create secret generic oma-k8s-bridge-token \\\n" +
                '  --from-literal=K8S_BRIDGE_TOKEN="$(openssl rand -base64 32)"'
              }
            />
          </div>

          <div>
            <div className="text-xs text-fg-subtle mb-1.5">
              2 · Install the chart, pointing at that Secret
            </div>
            <CopyBlock
              id="k8s-helm"
              copied={copied}
              onCopy={copy}
              text={
                "helm install oma-k8s-bridge ./charts/oma-k8s-bridge \\\n" +
                "  --namespace sandboxes \\\n" +
                "  --set secret.existingSecret=oma-k8s-bridge-token \\\n" +
                "  --set config.namespace=sandboxes"
              }
            />
          </div>

          <div>
            <div className="text-xs text-fg-subtle mb-1.5">
              3 · Wait for rollout, then check it answers
            </div>
            <CopyBlock
              id="k8s-verify"
              copied={copied}
              onCopy={copy}
              text={
                "kubectl -n sandboxes rollout status deployment/oma-k8s-bridge\n" +
                "kubectl -n sandboxes port-forward svc/oma-k8s-bridge 8100:8100 &\n" +
                'curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \\\n' +
                "  http://localhost:8100/api/v1/health"
              }
            />
          </div>

          <div>
            <div className="text-xs text-fg-subtle mb-1.5">
              4 · Point OMA at the bridge, then restart the host
            </div>
            <CopyBlock
              id="k8s-env"
              copied={copied}
              onCopy={copy}
              text={
                "K8S_BRIDGE_URL=http://oma-k8s-bridge.sandboxes.svc.cluster.local:8100\n" +
                "K8S_BRIDGE_TOKEN=<the token from step 1>"
              }
            />
            <p className="mt-1.5 text-xs text-fg-subtle">
              On Cloudflare, set these with{" "}
              <code className="bg-bg-surface px-1 rounded">wrangler secret put</code> instead
              of a <code className="bg-bg-surface px-1 rounded">.env</code> file.
            </p>
          </div>

          <div className="pt-1 border-t border-border">
            <div className="text-xs text-fg-subtle mb-1.5">
              5 · Point an environment at it
            </div>
            <p>
              On the <span className="text-fg">self-host Node</span> runtime, set{" "}
              <code className="bg-bg-surface px-1 rounded">sandbox_provider: "k8s"</code> — it talks
              to the cluster directly via <code className="bg-bg-surface px-1 rounded">KubernetesSandboxExecutor</code>,
              no bridge needed:
            </p>
            <CopyBlock
              id="k8s-env-self-host"
              copied={copied}
              onCopy={copy}
              text={'{\n  "sandbox_provider": "k8s",\n  "namespace": "sandboxes"\n}'}
            />
            <p className="mt-2">
              On the <span className="text-fg">Cloudflare</span> deployment, a Worker has no
              kubeconfig, so use <code className="bg-bg-surface px-1 rounded">k8s-remote</code>{" "}
              instead — it speaks the same boxrun-shaped HTTP API as the bridge above, but to an
              in-cluster <span className="text-fg">k8s-sandbox-gateway</span> service (create /
              exec+SSE / files-as-tar / destroy) rather than to oma-k8s-bridge directly:
            </p>
            <CopyBlock
              id="k8s-env-remote"
              copied={copied}
              onCopy={copy}
              text={'{\n  "sandbox_provider": "k8s-remote"\n}'}
            />
            <p className="mt-1.5 text-xs text-fg-subtle">
              Requires <code className="bg-bg-surface px-1 rounded">K8S_SANDBOX_GATEWAY_URL</code>{" "}
              (<code className="bg-bg-surface px-1 rounded">wrangler secret put</code>) pointing at
              that gateway — missing it fails the session clearly rather than silently falling
              back. No Helm chart ships for the gateway itself yet; it implements the same HTTP
              contract as oma-k8s-bridge (see{" "}
              <code className="bg-bg-surface px-1 rounded">
                packages/sandbox/src/adapters/kubernetes-remote.ts
              </code>
              ) — you deploy your own gateway implementing that contract in-cluster.{" "}
              <span className="text-fg">Known limitation:</span> memory-store and
              session-outputs bind-mounts aren't available over the gateway's HTTP tar API, same
              as BoxRun.
            </p>
          </div>

          <p className="text-xs text-fg-subtle">
            Full reference — values, ingress/TLS, RBAC, and troubleshooting — at{" "}
            <a
              href="https://docs.oma.duyet.net/deploy/k8s-bridge/"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-fg"
            >
              docs.oma.duyet.net/deploy/k8s-bridge
            </a>
            ; the 10-minute path is{" "}
            <a
              href="https://docs.oma.duyet.net/deploy/kubernetes/"
              target="_blank"
              rel="noreferrer"
              className="underline hover:text-fg"
            >
              deploy/kubernetes
            </a>
            .
          </p>
        </div>
      </details>

      {/* Provider registration help */}
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
          <p>
            For BYOK (bring-your-own-key) providers, register via the API:
          </p>
          <div className="bg-bg border border-border rounded-lg p-3 font-mono text-xs whitespace-pre overflow-x-auto">
            <div className="text-fg select-all">{"curl -X POST /v1/sandbox_providers \\\n  -H \"x-api-key: $KEY\" \\\n  -d '{\"name\":\"My K8s\",\"type\":\"k8s\",\"config\":{\"base_url\":\"https://...\"}}'"}</div>
          </div>
          <p className="text-xs text-fg-subtle">
            The full provider API is documented at{" "}
            <a href="https://docs.oma.duyet.net/build/sandbox-providers" target="_blank" rel="noreferrer" className="underline hover:text-fg">
              docs.oma.duyet.net/build/sandbox-providers
            </a>
            .
          </p>
        </div>
      </details>

      {/* Connect-machine instructions */}
      <Modal
        open={showInstructions}
        onClose={() => setShowInstructions(false)}
        title="Connect a local machine"
        footer={<Button onClick={() => setShowInstructions(false)}>Done</Button>}
      >
        <div className="space-y-4 text-sm">
          <p className="text-fg-muted">
            On the machine you want to connect, run:
          </p>
          <div className="bg-bg-surface border border-border rounded-lg p-3 font-mono text-xs space-y-1">
            <div className="text-fg select-all">npx @getoma/cli bridge setup</div>
          </div>
          <p className="text-fg-muted text-xs">
            Setup opens this browser for OAuth, writes credentials to{" "}
            <code className="bg-bg-surface px-1 rounded">~/.oma/bridge/</code>, and (on macOS) installs a launchd job
            that keeps the daemon running across reboots. The daemon scans your <code className="bg-bg-surface px-1 rounded">$PATH</code> for
            ACP-compatible agents and reports them here.
          </p>
          <div>
            <p className="text-fg-muted text-xs mb-1.5">
              <strong>★ Featured agents</strong> — OMA's recommended set:
            </p>
            <ul className="text-xs text-fg-muted space-y-1 ml-4 list-disc font-mono">
              <li><span className="text-fg">claude-acp</span> · <code className="bg-bg-surface px-1 rounded">npx -y @agentclientprotocol/claude-agent-acp</code> (auto-installed if <code className="bg-bg-surface px-1 rounded">claude</code> is on PATH)</li>
              <li><span className="text-fg">codex-acp</span> · download from <a href="https://github.com/zed-industries/codex-acp/releases" target="_blank" rel="noreferrer" className="underline">zed-industries/codex-acp releases</a></li>
              <li><span className="text-fg">openclaw</span> · <code className="bg-bg-surface px-1 rounded">npm i -g openclaw</code> (uses <code className="bg-bg-surface px-1 rounded">openclaw acp</code> bridge)</li>
              <li><span className="text-fg">hermes</span> · <code className="bg-bg-surface px-1 rounded">curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash</code></li>
            </ul>
          </div>
          <div>
            <p className="text-fg-muted text-xs mb-1.5">
              Setup auto-installs an ACP wrapper when an upstream binary is on <code className="bg-bg-surface px-1 rounded">$PATH</code>:
            </p>
            <ul className="text-xs text-fg-muted space-y-1 ml-4 list-disc">
              <li><code className="bg-bg-surface px-1 rounded">claude</code> → installs <code className="bg-bg-surface px-1 rounded">@agentclientprotocol/claude-agent-acp</code></li>
              <li><code className="bg-bg-surface px-1 rounded">codex</code> → installs <code className="bg-bg-surface px-1 rounded">@normahq/codex-acp-bridge</code> (drives codex over ACP)</li>
              <li><code className="bg-bg-surface px-1 rounded">gemini</code> missing → installs <code className="bg-bg-surface px-1 rounded">@google/gemini-cli</code> (ships ACP natively)</li>
            </ul>
          </div>
          <p className="text-fg-muted text-xs">
            30+ other agents (gemini, opencode, cline, cursor, kimi, qwen-code, …) come from the
            <a href="https://agentclientprotocol.com/get-started/registry" target="_blank" rel="noreferrer" className="underline hover:text-fg ml-1">
              official ACP Registry
            </a> — daemon fetches the manifest at startup and any installed binary becomes selectable.
          </p>
        </div>
      </Modal>

      {/* Add sandbox provider (BYOK) dialog */}
      <AddSandboxProviderDialog
        open={showAddProvider}
        onClose={() => setShowAddProvider(false)}
        onCreated={() => void loadProviders()}
      />

      {/* Set-up dialog for a not-configured provider (e.g. Local subprocess).
          Holds the CLI quickstart too — installing the CLI and minting a key
          is the same job as connecting the runtime, so the steps live where
          you actually do them instead of taking up the page at all times.
          Hence the wider shell: three step rows need more than max-w-lg. */}
      <Modal
        open={setupProvider !== null}
        onClose={() => setSetupProvider(null)}
        title={`Set up ${setupProvider?.label ?? "provider"}`}
        subtitle="Run this on the machine you want to connect."
        maxWidth="max-w-3xl"
        footer={<Button onClick={() => setSetupProvider(null)}>Done</Button>}
      >
        <div className="space-y-5 text-sm">
          <div className="space-y-4">
            <p className="text-fg-muted">
              Connect this host's local runtime by starting the bridge daemon:
            </p>
            <div className="bg-bg-surface border border-border rounded-lg p-3 font-mono text-xs space-y-1">
              <div className="text-fg select-all">npx @getoma/cli bridge setup</div>
            </div>
            <p className="text-fg-muted text-xs">
              Setup opens this browser for OAuth, writes credentials to{" "}
              <code className="bg-bg-surface px-1 rounded">~/.oma/bridge/</code>, and (on macOS) installs a launchd job
              that keeps the daemon running across reboots. Once connected, this provider flips to{" "}
              <span className="text-success">Healthy</span> and any ACP agents on <code className="bg-bg-surface px-1 rounded">$PATH</code> appear as
              machines in the list behind this dialog.
            </p>
          </div>

          <CliQuickstart onNavigate={() => setSetupProvider(null)} />
        </div>
      </Modal>

      {/* Click-through detail dialogs for a provider / machine card. Mirror the
          card's own actions (Set up / Remove / Revoke) plus a "use in an
          environment" next step. */}
      <ProviderDetailDialog
        provider={detailProvider}
        onClose={() => setDetailProvider(null)}
        onSetup={setSetupProvider}
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
    </div>
  );
}

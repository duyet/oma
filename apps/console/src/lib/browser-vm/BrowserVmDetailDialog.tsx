import { useEffect, useRef, useState, type JSX } from "react";

import { Modal } from "../../components/Modal";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { browserVmStatusMeta, useBrowserVm } from "./BrowserVmProvider";

/**
 * Overview / Processes / Bash / Logs inspector for the embedded browser-vm
 * sandbox. Follows the project's `Modal` convention (shadcn `Dialog`
 * underneath) rather than introducing a new dialog primitive; tabs reuse
 * the shared `@/components/ui/tabs` already used by RuntimesList.
 */

const STATS_REFRESH_MS = 5000;

function formatKb(kb: number | null): string {
  if (kb === null) return "—";
  if (kb >= 1024 * 1024) return `${(kb / (1024 * 1024)).toFixed(1)} GB`;
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${kb} KB`;
}

function formatUptime(seconds: number | null): string {
  if (seconds === null) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function StatDot({ tone }: { tone: "ok" | "warn" | "off" | "error" }) {
  const cls =
    tone === "ok"
      ? "bg-success"
      : tone === "warn"
        ? "bg-warning"
        : tone === "error"
          ? "bg-destructive"
          : "bg-fg-subtle";
  return <span className={cn("inline-block size-1.5 rounded-full", cls)} aria-hidden />;
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5 border-b border-border last:border-0">
      <span className="text-xs text-fg-muted">{label}</span>
      <span className="text-sm text-fg text-right">{children}</span>
    </div>
  );
}

export function BrowserVmDetailDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): JSX.Element | null {
  const { status, runtimeId, engine, detail, logs, ops, stats, requestStats, runShell, stop } =
    useBrowserVm();
  const [bashInput, setBashInput] = useState("");
  const [bashRunning, setBashRunning] = useState(false);
  const [scrollback, setScrollback] = useState<string[]>([]);
  const logsEndRef = useRef<HTMLDivElement | null>(null);

  // Auto-refresh stats every 5s while the dialog is open; stop on close.
  useEffect(() => {
    if (!open) return;
    void requestStats().catch(() => {});
    const interval = setInterval(() => {
      void requestStats().catch(() => {});
    }, STATS_REFRESH_MS);
    return () => clearInterval(interval);
    // requestStats is a stable identity from context; open is the only
    // input that should restart the interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) logsEndRef.current?.scrollIntoView({ block: "end" });
  }, [logs, open]);

  if (!open) return null;

  const runCommand = async () => {
    const command = bashInput.trim();
    if (!command || bashRunning) return;
    setScrollback((prev) => [...prev, `$ ${command}`]);
    setBashInput("");
    setBashRunning(true);
    try {
      const output = await runShell(command);
      setScrollback((prev) => [...prev, output || "(no output)"]);
    } catch (err) {
      setScrollback((prev) => [
        ...prev,
        `error: ${err instanceof Error ? err.message : String(err)}`,
      ]);
    } finally {
      setBashRunning(false);
    }
  };

  const { label: statusLabel, tone } = browserVmStatusMeta(status);

  return (
    <Modal open={open} onClose={onClose} title="Browser VM" subtitle={runtimeId ?? undefined} maxWidth="max-w-2xl">
      <Tabs defaultValue="overview">
        <TabsList variant="line">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="processes">Processes</TabsTrigger>
          <TabsTrigger value="bash">Bash</TabsTrigger>
          <TabsTrigger value="logs">Logs</TabsTrigger>
        </TabsList>

        <TabsContent value="overview" className="pt-3">
          <div className="space-y-0.5">
            <DetailRow label="Status">
              <span className="inline-flex items-center gap-1.5">
                <StatDot tone={tone} />
                {statusLabel}
              </span>
            </DetailRow>
            <DetailRow label="Engine">{engine ?? "—"}</DetailRow>
            <DetailRow label="Runtime ID">
              <span className="font-mono text-xs">{runtimeId ?? "—"}</span>
            </DetailRow>
            <DetailRow label="CPU">
              {stats?.cpu_pct !== undefined && stats?.cpu_pct !== null
                ? `${stats.cpu_pct.toFixed(1)}%`
                : "—"}
            </DetailRow>
            <DetailRow label="Memory">
              {stats
                ? `${formatKb(stats.mem_used_kb)} / ${formatKb(stats.mem_total_kb)}`
                : "—"}
            </DetailRow>
            <DetailRow label="Uptime">{stats ? formatUptime(stats.uptime_s) : "—"}</DetailRow>
            {detail && <DetailRow label="Detail">{detail}</DetailRow>}
          </div>
          {status !== "off" && (
            <div className="pt-3">
              <Button size="sm" variant="ghost" onClick={() => stop()}>
                Stop VM
              </Button>
            </div>
          )}
          {ops.length > 0 && (
            <div className="mt-4">
              <p className="text-xs font-medium text-fg-muted mb-1.5">Recent ops</p>
              <ul className="space-y-1 text-xs font-mono text-fg-muted max-h-40 overflow-y-auto">
                {ops
                  .slice()
                  .reverse()
                  .map((o, i) => (
                    <li key={`${o.ts}-${i}`} className="flex items-center gap-2">
                      <span
                        className={cn(
                          "shrink-0",
                          o.phase === "error"
                            ? "text-destructive"
                            : o.phase === "done"
                              ? "text-success"
                              : "text-fg-subtle",
                        )}
                      >
                        {o.phase}
                      </span>
                      <span className="truncate">{o.op}</span>
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </TabsContent>

        <TabsContent value="processes" className="pt-3">
          {!stats || stats.processes.length === 0 ? (
            <p className="text-xs text-fg-subtle">No process data yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>PID</TableHead>
                  <TableHead>Command</TableHead>
                  <TableHead>CPU</TableHead>
                  <TableHead>Mem</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.processes.map((p, i) => (
                  <TableRow key={`${p.pid}-${i}`}>
                    <TableCell className="font-mono text-xs">{p.pid}</TableCell>
                    <TableCell className="font-mono text-xs">{p.comm}</TableCell>
                    <TableCell className="font-mono text-xs">{p.cpu ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">{p.mem ?? "—"}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </TabsContent>

        <TabsContent value="bash" className="pt-3 space-y-2">
          <div className="h-64 overflow-y-auto rounded-md border border-border bg-bg-surface p-2 font-mono text-xs whitespace-pre-wrap">
            {scrollback.length === 0 ? (
              <span className="text-fg-subtle">Run a command to see output here.</span>
            ) : (
              scrollback.join("\n")
            )}
          </div>
          <div className="flex gap-2">
            <Input
              value={bashInput}
              disabled={bashRunning}
              onChange={(e) => setBashInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void runCommand();
              }}
              placeholder="ls /workspace"
              className="font-mono text-xs"
            />
            <Button
              size="sm"
              disabled={bashRunning || !bashInput.trim()}
              onClick={() => void runCommand()}
            >
              Run
            </Button>
          </div>
        </TabsContent>

        <TabsContent value="logs" className="pt-3">
          <div className="h-64 overflow-y-auto rounded-md border border-border bg-bg-surface p-2 font-mono text-[11px] whitespace-pre-wrap">
            {logs.length === 0 ? (
              <span className="text-fg-subtle">No logs yet.</span>
            ) : (
              logs.join("\n")
            )}
            <div ref={logsEndRef} />
          </div>
        </TabsContent>
      </Tabs>
    </Modal>
  );
}

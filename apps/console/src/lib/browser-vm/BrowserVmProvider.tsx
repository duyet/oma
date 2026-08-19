import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from "react";

import { useApi } from "../api";
import {
  registerBrowserVmController,
  type BrowserVmControllerStatus,
} from "../sandboxTab";

/**
 * Embedded browser-vm sandbox provider.
 *
 * Replaces the old "open /sandbox-tab in a new browser tab" flow with a
 * hidden, persistent iframe mounted at the app root — the VM is always
 * available without depending on a second tab staying open. Transport is
 * `window.postMessage` between this provider (parent) and `/sandbox-tab`
 * (child, loaded with `?embedded=1`); see the child protocol this consumes
 * in AGENTS.md / the sandbox-tab page itself (owned by another agent — this
 * file only consumes the wire shapes, it never changes them).
 *
 * Registers itself as the `BrowserVmController` in `sandboxTab.ts` on
 * mount, so the existing `openSandboxTab` / `ensureSandboxTabForEnvironment`
 * module functions route through this iframe instead of `window.open`
 * without every call site needing to be rewritten to use the React context.
 */

export type BrowserVmStatus = BrowserVmControllerStatus;

export interface BrowserVmOp {
  op: string;
  phase: "start" | "done" | "error";
  ts: number;
}

export interface BrowserVmStatsProcess {
  pid: string;
  comm: string;
  cpu?: string;
  mem?: string;
}

export interface BrowserVmStats {
  ts: number;
  cpu_pct: number | null;
  mem_used_kb: number | null;
  mem_total_kb: number | null;
  uptime_s: number | null;
  processes: BrowserVmStatsProcess[];
}

interface BrowserVmContextValue {
  status: BrowserVmStatus;
  runtimeId: string | null;
  engine: string | null;
  detail: string | null;
  /** Rolling log buffer, capped at 500 lines. */
  logs: string[];
  /** Recent lifecycle ops, most-recent last. */
  ops: BrowserVmOp[];
  stats: BrowserVmStats | null;
  /** Mint a pairing code and mount the hidden iframe. Idempotent — no-ops
   *  while a boot is already pairing/booting/online. */
  start: () => Promise<void>;
  /** Unmount the iframe and reset state to "off". */
  stop: () => void;
  /** Run a one-shot shell command in the VM. Rejects on timeout or an
   *  explicit error from the child. */
  runShell: (command: string) => Promise<string>;
  /** Request a fresh stats snapshot from the VM. Rejects on timeout. */
  requestStats: () => Promise<BrowserVmStats>;
}

const BrowserVmContext = createContext<BrowserVmContextValue | null>(null);

// Safe fallback for consumers rendered without a mounted BrowserVmProvider
// (unit tests for pages that don't need the VM under test — RuntimesList.tsx,
// Inspector.tsx tests, etc.). In the running app the provider is always
// mounted at the root (see main.tsx), so this path is test-only; throwing
// instead would force every page test to wrap in the provider just to
// render a card that happens to also show VM status.
const OFF_CONTEXT: BrowserVmContextValue = {
  status: "off",
  runtimeId: null,
  engine: null,
  detail: null,
  logs: [],
  ops: [],
  stats: null,
  start: async () => {},
  stop: () => {},
  runShell: async () => {
    throw new Error("Browser VM is not available");
  },
  requestStats: async () => {
    throw new Error("Browser VM is not available");
  },
};

export function useBrowserVm(): BrowserVmContextValue {
  return useContext(BrowserVmContext) ?? OFF_CONTEXT;
}

/** Dot color + human label for a status, shared by every status surface
 *  (Inspector's Sandbox tab, RuntimesList's provider card/dialog). */
export function browserVmStatusMeta(
  status: BrowserVmStatus,
): { label: string; tone: "ok" | "warn" | "off" | "error" } {
  switch (status) {
    case "online":
      return { label: "Online", tone: "ok" };
    case "pairing":
      return { label: "Pairing…", tone: "warn" };
    case "booting":
      return { label: "Booting…", tone: "warn" };
    case "error":
      return { label: "Error", tone: "error" };
    case "offline":
      return { label: "Offline", tone: "off" };
    case "off":
    default:
      return { label: "Not started", tone: "off" };
  }
}

const LOG_CAP = 500;
const OPS_CAP = 50;
const SHELL_TIMEOUT_MS = 30_000;
const STATS_TIMEOUT_MS = 10_000;
// The child posts an `oma-bvm:status` heartbeat at least every ~25s (and on
// every state transition) and explicitly announces "offline" on pagehide —
// but a wedged tab (frozen JS, hard iframe crash) stops posting anything at
// all, including that offline notice. Without a watchdog, `status` would
// stay stuck on "online" forever: hasPendingTab() keeps short-circuiting
// auto-restart, the Start VM button never reappears (vmNeedsStart is
// false), and start() itself early-returns on "online" — an unrecoverable
// dead end for the user. STALE_THRESHOLD_MS gives room for one missed
// heartbeat plus jitter before declaring the VM offline.
const STALE_THRESHOLD_MS = 70_000;
const STALE_CHECK_INTERVAL_MS = 10_000;

const MSG_PREFIX = "oma-bvm:";

interface PendingStats {
  resolve: (stats: BrowserVmStats) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface PendingShell {
  chunks: string[];
  resolve: (output: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export function BrowserVmProvider({ children }: { children: ReactNode }): JSX.Element {
  const { api } = useApi();

  const [status, setStatus] = useState<BrowserVmStatus>("off");
  const [runtimeId, setRuntimeId] = useState<string | null>(null);
  const [engine, setEngine] = useState<string | null>(null);
  const [detail, setDetail] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);
  const [ops, setOps] = useState<BrowserVmOp[]>([]);
  const [stats, setStats] = useState<BrowserVmStats | null>(null);
  const [iframeSrc, setIframeSrc] = useState<string | null>(null);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Mirrors `status` synchronously for the controller's getStatus() — state
  // updates are async, but registerBrowserVmController's caller (sandboxTab.ts
  // dedupe checks) needs the value at call time, not after the next render.
  const statusRef = useRef<BrowserVmStatus>("off");
  // Wall-clock time of the last status we received from (or attributed to,
  // for start()'s own optimistic "pairing") the child — the watchdog effect
  // below compares against this to detect a wedged tab.
  const lastStatusTsRef = useRef<number>(0);

  const statsQueueRef = useRef<PendingStats[]>([]);
  const shellPendingRef = useRef<Map<string, PendingShell>>(new Map());

  const postToChild = useCallback((msg: Record<string, unknown>) => {
    const win = iframeRef.current?.contentWindow;
    if (!win) return;
    win.postMessage(msg, window.location.origin);
  }, []);

  const rejectAllPending = useCallback((reason: string) => {
    for (const entry of statsQueueRef.current.splice(0)) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    for (const entry of shellPendingRef.current.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error(reason));
    }
    shellPendingRef.current.clear();
  }, []);

  const start = useCallback(async () => {
    if (
      statusRef.current === "pairing" ||
      statusRef.current === "booting" ||
      statusRef.current === "online"
    ) {
      return;
    }
    // Flip the guard synchronously, before the first `await`, so a second
    // start() call racing in before the mint request resolves (e.g. two
    // rapid clicks) sees "pairing" immediately instead of also passing the
    // check above and minting a second code / mounting a second iframe.
    statusRef.current = "pairing";
    lastStatusTsRef.current = Date.now();
    setStatus("pairing");
    try {
      const state = crypto.randomUUID().replace(/-/g, "");
      const { code } = await api<{ code: string; expires_at: number }>(
        "/v1/runtimes/connect-runtime",
        { method: "POST", body: JSON.stringify({ state }) },
      );
      const url = new URL("/sandbox-tab", window.location.origin);
      url.searchParams.set("code", code);
      url.searchParams.set("state", state);
      url.searchParams.set("embedded", "1");
      setDetail(null);
      setIframeSrc(url.toString());
    } catch {
      // `api()` already toasted the failure.
      statusRef.current = "error";
      setStatus("error");
      setDetail("Failed to mint a pairing code");
    }
  }, [api]);

  const stop = useCallback(() => {
    rejectAllPending("Browser VM stopped");
    setIframeSrc(null);
    statusRef.current = "off";
    setStatus("off");
    setRuntimeId(null);
    setEngine(null);
    setDetail(null);
  }, [rejectAllPending]);

  const runShell = useCallback(
    (command: string): Promise<string> => {
      return new Promise<string>((resolve, reject) => {
        if (!iframeRef.current?.contentWindow) {
          reject(new Error("Browser VM is not connected"));
          return;
        }
        const id = crypto.randomUUID();
        const timer = setTimeout(() => {
          shellPendingRef.current.delete(id);
          reject(new Error("Shell command timed out"));
        }, SHELL_TIMEOUT_MS);
        shellPendingRef.current.set(id, { chunks: [], resolve, reject, timer });
        postToChild({ type: `${MSG_PREFIX}shell`, id, command });
      });
    },
    [postToChild],
  );

  const requestStats = useCallback((): Promise<BrowserVmStats> => {
    return new Promise<BrowserVmStats>((resolve, reject) => {
      if (!iframeRef.current?.contentWindow) {
        reject(new Error("Browser VM is not connected"));
        return;
      }
      const entry: PendingStats = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = statsQueueRef.current.indexOf(entry);
          if (idx >= 0) statsQueueRef.current.splice(idx, 1);
          reject(new Error("Stats request timed out"));
        }, STATS_TIMEOUT_MS),
      };
      statsQueueRef.current.push(entry);
      postToChild({ type: `${MSG_PREFIX}stats-request` });
    });
  }, [postToChild]);

  // Wire protocol handler — verifies origin + source before touching data,
  // per the shared contract with the /sandbox-tab child page.
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;
      if (!iframeRef.current || event.source !== iframeRef.current.contentWindow) return;
      const data: unknown = event.data;
      if (!data || typeof data !== "object") return;
      const type = (data as { type?: unknown }).type;
      if (typeof type !== "string" || !type.startsWith(MSG_PREFIX)) return;

      switch (type) {
        case `${MSG_PREFIX}status`: {
          const d = data as {
            status: BrowserVmStatus;
            runtime_id: string | null;
            engine: string;
            detail?: string;
          };
          lastStatusTsRef.current = Date.now();
          statusRef.current = d.status;
          setStatus(d.status);
          setRuntimeId(d.runtime_id ?? null);
          setEngine(d.engine ?? null);
          setDetail(d.detail ?? null);
          break;
        }
        case `${MSG_PREFIX}log`: {
          const d = data as { line: string; ts: number };
          setLogs((prev) => {
            const next = [...prev, d.line];
            return next.length > LOG_CAP ? next.slice(next.length - LOG_CAP) : next;
          });
          break;
        }
        case `${MSG_PREFIX}op`: {
          const d = data as { op: string; phase: "start" | "done" | "error"; ts: number };
          setOps((prev) => {
            const next = [...prev, { op: d.op, phase: d.phase, ts: d.ts }];
            return next.length > OPS_CAP ? next.slice(next.length - OPS_CAP) : next;
          });
          break;
        }
        case `${MSG_PREFIX}stats`: {
          const d = data as {
            ts: number;
            cpu_pct: number | null;
            mem_used_kb: number | null;
            mem_total_kb: number | null;
            uptime_s: number | null;
            processes: BrowserVmStatsProcess[];
          };
          const s: BrowserVmStats = {
            ts: d.ts,
            cpu_pct: d.cpu_pct,
            mem_used_kb: d.mem_used_kb,
            mem_total_kb: d.mem_total_kb,
            uptime_s: d.uptime_s,
            processes: d.processes ?? [],
          };
          setStats(s);
          const entry = statsQueueRef.current.shift();
          if (entry) {
            clearTimeout(entry.timer);
            entry.resolve(s);
          }
          break;
        }
        case `${MSG_PREFIX}shell-output`: {
          const d = data as { id: string; chunk: string; done: boolean; error?: string };
          const entry = shellPendingRef.current.get(d.id);
          if (!entry) break;
          if (d.chunk) entry.chunks.push(d.chunk);
          if (d.done) {
            clearTimeout(entry.timer);
            shellPendingRef.current.delete(d.id);
            if (d.error) entry.reject(new Error(d.error));
            else entry.resolve(entry.chunks.join(""));
          }
          break;
        }
        default:
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  // Heartbeat watchdog — see STALE_THRESHOLD_MS above. Only runs while an
  // iframe is actually mounted (iframeSrc set); a wedged/killed tab that
  // stops posting entirely gets declared "offline" instead of leaving
  // status stuck on whatever it last successfully reported.
  useEffect(() => {
    if (!iframeSrc) return;
    const interval = setInterval(() => {
      const current = statusRef.current;
      if (current !== "pairing" && current !== "booting" && current !== "online") return;
      if (Date.now() - lastStatusTsRef.current < STALE_THRESHOLD_MS) return;
      statusRef.current = "offline";
      setStatus("offline");
      setDetail("No response from the VM tab — it may have crashed or been closed");
    }, STALE_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [iframeSrc]);

  // Register/unregister with sandboxTab.ts so the existing module-function
  // call sites (AgentChat.tsx, SessionDetail.tsx, RuntimesList.tsx) route
  // through this provider once it's mounted.
  useEffect(() => {
    registerBrowserVmController({ start, getStatus: () => statusRef.current });
    return () => registerBrowserVmController(null);
  }, [start]);

  // Reject in-flight shell/stats calls if the provider itself unmounts
  // (app teardown) rather than let them ride out their timeouts.
  useEffect(() => {
    return () => rejectAllPending("Browser VM provider unmounted");
  }, [rejectAllPending]);

  const handleIframeLoad = useCallback(() => {
    postToChild({ type: `${MSG_PREFIX}hello` });
  }, [postToChild]);

  const value = useMemo<BrowserVmContextValue>(
    () => ({
      status,
      runtimeId,
      engine,
      detail,
      logs,
      ops,
      stats,
      start,
      stop,
      runShell,
      requestStats,
    }),
    [status, runtimeId, engine, detail, logs, ops, stats, start, stop, runShell, requestStats],
  );

  return (
    <BrowserVmContext.Provider value={value}>
      {children}
      {iframeSrc && (
        <iframe
          ref={iframeRef}
          src={iframeSrc}
          onLoad={handleIframeLoad}
          title="Browser VM sandbox"
          // Not display:none — some VM engines throttle/suspend rendering
          // (and therefore the whole VM) when the frame isn't laid out at
          // all. A 2x2px, zero-opacity, click-through frame stays "visible"
          // to the engine while being invisible to the user.
          style={{
            position: "fixed",
            width: "2px",
            height: "2px",
            opacity: 0,
            pointerEvents: "none",
            bottom: 0,
            right: 0,
            border: 0,
          }}
        />
      )}
    </BrowserVmContext.Provider>
  );
}

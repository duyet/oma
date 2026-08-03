/**
 * Browser-VM sandbox tab helpers.
 *
 * A `browser-vm` environment executes the agent's sandbox ops inside a paired
 * browser tab (`/sandbox-tab`) rather than a server container. Until a tab is
 * paired, the first turn of a session fails with
 * "no browser sandbox tab connected — …" from BrowserVmRelaySandbox.
 *
 * These helpers let the Console open that tab automatically, from inside the
 * click handler that starts the session / sends the message — `window.open`
 * only survives a popup blocker when it runs in the user-gesture task.
 *
 * Dedupe: we check the tenant's runtimes list for an already-online
 * `browser-vm` runtime first, and additionally keep a module-level handle on
 * the tab we opened so two sends in a row don't stack tabs while the first
 * one is still booting its WASM VM (it isn't heartbeating yet, so the API
 * check alone would open a second tab).
 */

const RUNTIME_ONLINE_WINDOW_SEC = 120;
/** How long an opened-but-not-yet-online tab suppresses opening another. */
const RECENT_OPEN_MS = 90_000;

/** Marker the relay sandbox puts in its failure message. */
export const NO_SANDBOX_TAB_MARKER = "no browser sandbox tab connected";

export function isNoSandboxTabError(text: string | undefined | null): boolean {
  return !!text && text.includes(NO_SANDBOX_TAB_MARKER);
}

interface RuntimeRow {
  kind?: string;
  status?: string;
  last_heartbeat?: number | null;
}

/** True when the tenant has a live browser-vm tab paired right now. */
export async function hasOnlineBrowserVmRuntime(
  api: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<boolean> {
  try {
    const res = await api<{ runtimes?: RuntimeRow[] }>("/v1/runtimes");
    const nowSec = Math.floor(Date.now() / 1000);
    return (res.runtimes ?? []).some(
      (r) =>
        r.kind === "browser-vm" &&
        r.status === "online" &&
        typeof r.last_heartbeat === "number" &&
        r.last_heartbeat > nowSec - RUNTIME_ONLINE_WINDOW_SEC,
    );
  } catch {
    // Can't tell — treat as "no tab" so the caller opens one. A spurious
    // extra tab is a far smaller cost than a turn that fails outright.
    return false;
  }
}

/** True when the environment runs on the browser-vm provider. */
export async function isBrowserVmEnvironment(
  api: <T>(path: string, init?: RequestInit) => Promise<T>,
  environmentId: string | undefined,
): Promise<boolean> {
  if (!environmentId) return false;
  try {
    const env = await api<{ config?: { sandbox_provider?: string; type?: string } }>(
      `/v1/environments/${environmentId}`,
    );
    const provider = env.config?.sandbox_provider ?? env.config?.type;
    return provider === "browser-vm";
  } catch {
    return false;
  }
}

let openedTab: Window | null = null;
let openedAt = 0;

/** A tab we opened recently that hasn't been closed — don't open another. */
function hasPendingTab(): boolean {
  if (!openedTab) return false;
  if (openedTab.closed) {
    openedTab = null;
    return false;
  }
  return Date.now() - openedAt < RECENT_OPEN_MS;
}

/** Test seam — reset the module-level dedupe state. */
export function resetSandboxTabDedupe(): void {
  openedTab = null;
  openedAt = 0;
}

/**
 * Mint a one-time pairing code and open `/sandbox-tab` in a new tab.
 * Same code/state semantics as ConnectRuntime.tsx — the browser tab is a
 * runtime like any other, it just has no loopback CLI to originate the code.
 */
export async function openSandboxTab(
  api: <T>(path: string, init?: RequestInit) => Promise<T>,
): Promise<boolean> {
  try {
    const state = crypto.randomUUID().replace(/-/g, "");
    const { code } = await api<{ code: string; expires_at: number }>(
      "/v1/runtimes/connect-runtime",
      { method: "POST", body: JSON.stringify({ state }) },
    );
    const url = new URL("/sandbox-tab", window.location.origin);
    url.searchParams.set("code", code);
    url.searchParams.set("state", state);
    openedTab = window.open(url.toString(), "_blank", "noopener,noreferrer");
    openedAt = Date.now();
    return true;
  } catch {
    // `api()` already toasted the failure.
    return false;
  }
}

/**
 * Open the sandbox tab if — and only if — this session's environment is
 * browser-vm and no tab is paired yet. Call from a click handler so the
 * popup survives the blocker. Never throws: a failure here must not stop
 * the message from being sent (the backend now waits for a tab, and the
 * chat surfaces its own retry prompt if none shows up).
 */
export async function ensureSandboxTabForEnvironment(
  api: <T>(path: string, init?: RequestInit) => Promise<T>,
  environmentId: string | undefined,
): Promise<void> {
  if (!environmentId) return;
  if (hasPendingTab()) return;
  if (!(await isBrowserVmEnvironment(api, environmentId))) return;
  if (await hasOnlineBrowserVmRuntime(api)) return;
  await openSandboxTab(api);
}

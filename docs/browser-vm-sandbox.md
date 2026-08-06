# Browser-VM Sandbox (`browser-vm`)

> A managed-agent sandbox whose Linux/Node runtime lives **inside a user's
> browser tab** — a WASM virtual machine — instead of a cloud container.
> The agent loop runs on the OMA control plane as usual; only the sandbox
> *host* moves to the browser.

Status: **implemented on the Cloudflare deployment**. The `SandboxExecutor`
adapter, the RuntimeRoom relay wiring (`BrowserVmRelaySandbox`), the browser
host page (`GET /sandbox-tab`, COOP/COEP, v86 default engine), runtime
registration with `kind: "browser-vm"`, and the Console "Open sandbox tab"
action are all wired. Self-host Node lists the provider but reports it
not_configured (RuntimeRoom is a Cloudflare-only surface).

---

## 1. Why this exists

Every other OMA sandbox provider (`cloud`, `boxrun`, `daytona`, `e2b`, `k8s`,
`litebox`, …) runs the agent's shell on a machine **we** operate — a
Cloudflare Container, a Firecracker microVM, a k8s pod. That costs money per
active session and requires infrastructure.

A **browser VM** inverts the economics:

- **Zero server-side compute for the sandbox.** The VM is a WASM blob the
  user's own browser downloads and runs. Idle cost is literally zero — when
  the tab closes, the VM is gone.
- **Data locality.** Files the agent touches never leave the user's machine
  unless the agent explicitly uploads them. Good for privacy-sensitive work.
- **Instant, dependency-free trials.** "Try the agent" needs no container
  cold-start, no API key for a sandbox vendor — just a tab.

The tradeoff is that a browser tab is a **hostile execution host**: it can't
be reached directly by the control plane, it can't open raw TCP sockets, it
dies when the user navigates away, and it needs special HTTP headers to run
threads. The entire design is shaped by working around those four facts.

---

## 2. Where it plugs in

OMA's sandbox seam is the transport-agnostic `SandboxExecutor` port
(`packages/sandbox-sdk/src/ports.ts`):

```ts
interface SandboxExecutor {
  exec(command: string, timeout?: number): Promise<string>;
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<string>;
  destroy?(): Promise<void>;
  // …optional: setEnvVars, ping, mounts, backups
}
```

Because the port says nothing about *where* the box lives, we already have
three transport shapes behind it:

| Shape | Host location | Example adapter |
|---|---|---|
| in-process | same Node process | `litebox`, `local-subprocess` |
| remote HTTP | a machine we can `fetch()` | `boxrun`, `e2b`, `daytona`, `k8s-bridge` |
| **relay** | a host we *cannot* reach directly | `subprocess` (bridge daemon) |

A browser VM is the **relay** shape. The precedent is
`BridgeRelaySandbox` (`apps/agent/src/runtime/bridge-relay.ts`): the control
plane forwards each `sandbox.op` frame over the RuntimeRoom Durable Object
WebSocket to a paired `oma bridge daemon` on the user's laptop, which executes
it and streams the result back. **A browser tab is exactly the same kind of
paired-but-unreachable runtime** — we swap the laptop daemon for a tab that
hosts a WASM VM.

```
   ┌──────────────────────┐        model loop, tools, event log
   │  OMA control plane    │        (Worker DO or self-host Node)
   │  SessionDO + harness  │
   └──────────┬───────────┘
              │ BrowserVmSandbox.exec("npm test")
              │   → { type:"sandbox.op", op:"exec", request_id, … }
              ▼
   ┌──────────────────────┐        RuntimeRoom DO relays sandbox.* frames
   │  RuntimeRoom (relay)  │        between the harness WS and the tab WS,
   │  WebSocket fan-out     │        keyed by request_id, tenant-pinned.
   └──────────┬───────────┘
              │ WebSocket frame
              ▼
   ┌──────────────────────┐        the "browser bridge daemon":
   │  Browser tab (host)   │        a page running a WASM VM + a WS client
   │  ┌────────────────┐   │
   │  │ WebContainer / │   │  ← boots Node-in-WASM (or CheerpX x86 Linux)
   │  │ CheerpX WASM VM│   │     services exec/read/write against its own FS
   │  └────────────────┘   │
   └──────────────────────┘
```

The adapter (`BrowserVmSandbox`) is a thin RPC client: serialize the op,
await the correlated reply, translate it back into the string shape the
harness's `bash`/`read`/`write` tools already parse (`exit=N\n<stdout>…`).
It is **not** aware of WASM at all — that's entirely the browser host's job.

---

## 3. Choosing the in-browser VM — licensing decides it

The adapter is **VM-agnostic**: it only speaks the `sandbox.op` protocol, and
the browser host page decides which engine to boot from the `runtime` hint. So
engine choice is a host-side change with no control-plane impact. For an **MIT,
self-hostable** product the deciding axis is not speed or capability — it's the
license.

| Engine | Runs | License | Embeddable in OMA (MIT, self-host)? |
|---|---|---|---|
| WebContainers (StackBlitz) | Node.js + shell, no native ELF | proprietary | **No** — commercial OEM license, not self-hostable |
| CheerpX / WebVM (Leaning) | full x86 Debian, real binaries | proprietary | **No** — Community tier forbids self-host/redistribution |
| **v86** | full 32-bit Linux (emulated) | **BSD-2** | **Yes** — the embeddable full-Linux default |
| Pyodide | CPython, no shell/subprocess | MPL-2.0 | Yes — Python compute only |

- **WebContainers** is the most mature and the only battle-tested "AI agent
  driving a browser VM" (it powers **bolt.new**), but it runs Node + a shell,
  not a distro (no `apt`, no native binaries), and StackBlitz's terms require a
  commercial license and disallow self-hosting.
- **CheerpX / WebVM** is technically the strongest — genuine Debian, real ext2
  streamed on demand, unmodified x86 binaries — but its free Community tier
  forbids self-hosting/redistribution, so legal embedding needs a paid OEM deal.
- **v86** (BSD-2) is the honest open default when the agent needs a real Linux
  shell: a full-CPU emulator booting a real 32-bit kernel. Slower than CheerpX's
  JIT, but the one full-Linux engine we can actually ship. Networking via a WISP
  WebSocket relay gives genuine TCP (see §5.2).
- **Pyodide** (MPL-2.0) fits Python-only compute, with the caveat that WASM has
  no process model — no shell, no `subprocess`, no `pip install` of native tools.

So `browser-vm` ships as a **bring-your-own-engine provider**: v86 as the open
default; WebContainers/CheerpX selectable when the operator supplies their own
license. The platform bundles nothing proprietary.

---

## 4. The wire protocol

Identical framing to the bridge relay, so the RuntimeRoom DO needs no new
routing logic — it already forwards any `sandbox.*` frame by `request_id`.

```jsonc
// control plane → tab
{ "type": "sandbox.op", "op": "exec", "request_id": "42",
  "session_id": "sess_x", "command": "npm test", "timeout_seconds": 120 }

// tab → control plane
{ "type": "sandbox.result", "request_id": "42", "session_id": "sess_x",
  "ok": true, "result": { "exit_code": 0, "stdout": "…", "stderr": "" } }
```

Ops: `exec`, `readFile`, `writeFile`, `setEnvVars`, `destroy`. Correlation is
by monotonic `request_id`; a per-op timeout rejects the pending call if the
tab goes silent (user closed it, laptop slept). On timeout the session gets a
clear `session.error` — never a silent hang.

**Streaming:** long `exec` output streams as intermediate
`sandbox.result.chunk` frames (same idea as boxrun's SSE), coalesced into the
final combined string. For the reference implementation we return the whole
buffer at completion; chunk streaming is a drop-in extension.

---

## 5. The four hostile-host problems

### 5.1 Unreachable host → relay + liveness

The tab has no address. We rely on the RuntimeRoom pairing: the tab registers
as an online `runtime` (heartbeat every ~25 s), and `pickOnlineRuntimeId`
selects the freshest one for the tenant. Because the Console opens the tab from
the send-message click, a fresh session races a tab that is still pairing and
booting its VM, so the relay polls for an online runtime for up to **45 s**
(1.5 s interval, aborted immediately by `destroy()`) before giving up. Still no
online tab → the sandbox op fails loud with "open your browser sandbox tab",
exactly like the bridge daemon's "run bridge setup" message.

### 5.2 No raw TCP → networking is faked, and that's the biggest limitation

Browsers **cannot open raw TCP sockets.** So `git clone`, `pip install`,
`curl https://…` don't Just Work inside the VM. Each engine fakes it:

- **WebContainers**: outbound is proxied through the page's `fetch`; only
  HTTP(S) to CORS-permitting or proxied endpoints works. There is no
  general-purpose socket.
- **CheerpX/WebVM**: a **Tailscale/WISP exit node** tunnels the VM's traffic
  over WebSocket to a real network egress — this gives genuine `apt`/`git`,
  at the cost of running that exit node somewhere.

**How OMA squares this with its credential model:** OMA already MITM-proxies
all sandbox egress to inject vault credentials without the sandbox seeing raw
tokens. For `browser-vm`, outbound is pointed at the **same vault outbound
proxy** — the tab tunnels the VM's HTTP through OMA's proxy (WebSocket → proxy
→ real host), so credential injection still happens control-plane-side and the
agent never sees the token. Reach depends on the engine: v86 over a WISP relay
tunnels genuine TCP (so `git`/`curl`/package installs and even SSH work), while
WebContainers and CORS-bound engines are HTTP(S)-only. Either way a relay server
is required — a browser sandbox removes the *compute* backend, not the
*networking* one. This is called out as a first-class limitation.

### 5.3 Threads need cross-origin isolation → COOP/COEP

WASM VMs that use `SharedArrayBuffer` (both WebContainers and CheerpX, for
threading and the shared VM memory) require the hosting page to be
**cross-origin isolated**: it must be served with

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The OMA-hosted browser-VM page sets both headers. Any asset it embeds must be
CORP-compatible. This is a hard requirement, not a nicety — without it the VM
won't start.

### 5.4 Ephemerality → persistence + workspace backup

Close the tab and the VM's memory FS evaporates. Two layers handle this:

- **Within a session:** the host mirrors `/workspace` into **OPFS (Origin
  Private File System)** or **IndexedDB** so a reload restores state.
- **Across sessions:** OMA's existing `createWorkspaceBackup` /
  `restoreWorkspaceBackup` port methods are implemented by having the tab
  `tar` its workspace and upload it through the control plane to R2/S3 — the
  same durable-snapshot contract every other adapter satisfies, just sourced
  from the browser instead of a container.

---

## 6. Security model

The browser tab **is** the isolation boundary. Site isolation gives each
origin its own OS process; the WASM VM runs untrusted agent code inside that
process's memory, sandboxed by the browser the same way any web page is. Key
points:

- Agent code cannot escape the tab any more than a web page can — no host
  filesystem, no host process access.
- Because the VM runs on the **user's** machine, a malicious agent burns the
  *user's* CPU, not ours — a DoS-on-yourself, not on the platform. Resource
  caps (VM memory, exec timeouts) still apply host-side.
- Credentials never enter the VM (see §5.2). The vault proxy stays the only
  holder of tokens.
- The relay is tenant-pinned by the RuntimeRoom DO, so one tenant's session
  can never be routed to another tenant's tab.

---

## 7. What's implemented vs. deferred

**Implemented (this change):**

- `BrowserVmSandbox` adapter (`packages/sandbox-sdk/src/adapters/browser-vm.ts`) —
  a `SandboxExecutor` speaking the `sandbox.op` protocol over an injectable
  transport, with a factory + registry entry (`type: "browser-vm"`,
  `cfCompatible: true`).
- A reference **browser host page** that boots a WebContainer, connects a
  WebSocket, and services `exec`/`readFile`/`writeFile`.
- Unit tests for op serialization / correlation / timeout against a mock
  transport.

**Implemented (relay wiring follow-up, now landed):**

- `classifyCfSandboxProvider` returns `{ kind: "bridge", type: "browser-vm" }`
  and `resolveCfSandbox` constructs `BrowserVmRelaySandbox`
  (`apps/agent/src/runtime/browser-vm-relay.ts`) — lazy RuntimeRoom sandbox-WS
  attach, `pickOnlineRuntimeId(db, tenant, "browser-vm")` (runtimes rows carry
  a `kind` column: `daemon` | `browser-vm`), fail-loud
  `SandboxProviderUnavailableError` when no tab is online.
- The host page is served by `apps/main` at `GET /sandbox-tab` (must be
  listed under `assets.run_worker_first` in `apps/main/wrangler.jsonc` so
  the Console SPA fallback does not claim the path and redirect to `/agents`)
  (`apps/main/src/routes/browser-vm-host.ts`) with COOP/COEP set; it pairs via
  `POST /agents/runtime/exchange` (`kind: "browser-vm"`), attaches the
  RuntimeRoom WS via `?access_token=` (a browser WebSocket cannot set an
  Authorization header), heartbeats every 25 s, services the five ops against
  the engine seam (v86 serial-console driver as the open default), and mirrors
  `/workspace` writes to OPFS.
- Console: the Runtimes page shows a `browser-vm` provider card with an
  "Open sandbox tab" action (mints a pairing code, opens `/sandbox-tab`).
- Console: the agent form's **Agent runtime** control offers Browser as a
  third mode next to Cloud and Local. It is a sandbox provider, not a
  harness, so the mode selects (or creates) a `browser-vm` environment and
  records it on the agent as `metadata.default_environment_id` plus
  `metadata.runtime_kind: "browser"`; the harness and model are unchanged.
  New sessions for that agent preselect that environment. The marker exists
  because "which sandbox provider" is a property of the environment, so
  without it every surface that shows an agent's runtime kind (agents table,
  detail page, session inspector) would have to fetch the environment list.
- Console: the chat surfaces (`AgentChat`, `SessionDetail`) also open that tab
  **automatically**. On send, if the session's environment is `browser-vm` and
  no `browser-vm` runtime is online for the tenant (`GET /v1/runtimes`), they
  call the same mint-and-open path from inside the click handler so the popup
  blocker allows it, deduped against a tab opened in the last 90 s that hasn't
  been closed yet (a booting tab isn't heartbeating, so the API check alone
  would stack tabs). Helpers: `apps/console/src/lib/sandboxTab.ts`. If a turn
  still fails with the no-tab message, the chat shows an inline "Open sandbox
  tab & retry" prompt that reopens the tab and re-sends the last message.

**VM image configuration.** The host page boots with **public defaults** so
"Open sandbox tab" works without a setup form: `libv86.js` + `v86.wasm` from
jsDelivr (`npm/v86`), a demo Linux ISO from `cdn.jsdelivr.net/gh/copy/images`,
and seabios/vgabios from `cdn.jsdelivr.net/gh/copy/v86` (all CORS + CORP so they
load under COEP). Query params (`?lib=&image=`) win, then `localStorage`, then
those defaults. Operators can still open the setup card to override. Custom
assets must be CORS-accessible (and CORP-friendly) because the page is
cross-origin isolated.

**Serial-console framing constraints.** The v86 driver talks to the guest over
one serial line, which forces three rules the engine encodes:

- *One op at a time.* Agent ops (several sessions can share a tab), the monitor
  poll and the terminal REPL all share that line, so every op is serialized
  through a promise queue — concurrent commands would interleave on the same
  shell.
- *Markers are never typed literally.* A canonical-mode TTY echoes what we
  send, so a sentinel that appears verbatim in the command comes back in the
  echo. Markers are emitted via two adjacent shell-quoted halves
  (`'_''_oma_rc_x_'`), which the guest concatenates but our keystrokes never
  contain contiguously.
- *Lines stay under ~1.8 KB.* The guest's line-discipline buffer is typically
  4096 bytes and silently truncates beyond it, so base64 file payloads are
  split across round trips and over-long commands are staged as a script file.

**Deferred (follow-ups):**

- The Tailscale/WISP exit-node for CheerpX full-network mode, and routing the
  VM's egress through the vault outbound proxy (outbound from the tab is
  currently un-injected, same stance as the subprocess bridge relay).
- Workspace backups (`createWorkspaceBackup` / `restoreWorkspaceBackup`) from
  the tab; `sandbox.result.chunk` streaming for long execs.
- Memory-store / session-outputs mounts (same gap boxrun/k8s-remote have —
  the tab has no bind-mount primitive).
- Console UI: a one-click "open sandbox tab" that registers the runtime.

---

## 8. Comparison to other providers

| | server compute | isolation | native Linux | raw TCP | cold start | credential MITM |
|---|---|---|---|---|---|---|
| `cloud` (CF Container) | yes (ours) | container | yes | yes | seconds | yes |
| `e2b` / `boxrun` | yes (vendor/host) | microVM | yes | yes | ~250 ms–s | yes (proxy) |
| `subprocess` (bridge) | user laptop | none | yes | yes | instant | no |
| **`browser-vm`** | **none** | **browser tab** | WebContainers: no · CheerpX: yes | **no (proxied only)** | **~hundreds ms** | **yes (via tab→proxy)** |

The one-line summary: **`browser-vm` trades native networking and full-distro
tooling for zero server cost and perfect data locality**, and it reuses OMA's
existing relay + vault-proxy seams so it adds no new trust surface.
</content>

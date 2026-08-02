---
title: "Your Browser Tab Is Now an Agent Sandbox"
description: "OMA's new browser-vm provider runs the agent's shell inside a WASM Linux VM in your own browser tab — zero server compute, perfect data locality, one click to start. Here's how it works, how it compares to every other sandbox runtime we support, and what a tab can't do."
publishedAt: 2026-07-24
author: OMA
tags: ["browser-vm", "sandbox", "wasm", "v86", "cloudflare", "announcement"]
draft: false
---

Every OMA session needs somewhere to run `bash` / `read` / `write`. Until
now, that somewhere was always a machine *somebody* operates: a Cloudflare
Container, a Kubernetes pod, a Firecracker micro-VM, an
[OpenShell sandbox](/blog/openshell-sandboxes-local-cli-and-kubernetes), or
[your own laptop](/blog/run-agent-sandbox-local-machine-claude-code-acp)
via the bridge daemon.

The new `browser-vm` provider adds a stranger option: **the sandbox is a
WASM Linux VM running inside a browser tab you keep open.** The agent loop
stays on the control plane; only the shell moves into your browser.

## Why you'd want this

- **Zero server-side compute.** The VM is a WASM blob your browser
  downloads and runs. Idle cost is literally zero — close the tab, the VM
  is gone.
- **Data locality.** Files the agent touches never leave your machine
  unless the agent explicitly uploads them.
- **Instant trials.** No container cold-start, no sandbox-vendor API key.
  Console → Runtimes → **Open sandbox tab**. That's the whole setup.

## How it works

A browser tab can't be reached by the control plane, so `browser-vm`
reuses the same relay seam as the local bridge daemon: the tab pairs with
a one-time code, registers as a runtime (`kind: "browser-vm"`), and holds
a WebSocket open to the RuntimeRoom. Each sandbox op the harness issues —
`exec`, `readFile`, `writeFile` — travels down that socket as a
`sandbox.op` frame, executes against the in-tab VM, and streams back as a
`sandbox.result`. From the platform's point of view the tab is just
another paired-but-unreachable runtime; from yours it's a status page with
a log.

The VM engine is **bring-your-own, with [v86](https://github.com/copy/v86)
(BSD-2) as the open default** — a full 32-bit Linux booted in the tab and
driven over its serial console. WebContainers and CheerpX are technically
stronger but proprietary; the engine seam accepts them if you hold a
license. The platform bundles nothing proprietary. Within a session the
tab mirrors `/workspace` into OPFS, so a reload restores your files.

Credentials follow OMA's usual rule: they **never enter the sandbox** —
which here means they never enter your browser either.

## Where it fits among our sandbox runtimes

| Provider | Compute lives | Isolation | Works on Cloudflare | Works on self-host Node |
|---|---|---|---|---|
| `cloud` (Cloudflare Containers) | our infra | container | default | — |
| `boxrun` / `k8s-remote` / `openshell` | your infra | micro-VM / pod / policy sandbox | yes (plain fetch) | yes |
| `daytona` / `e2b` | vendor cloud | micro-VM | not yet bundled | yes |
| `subprocess` (bridge daemon) | your laptop | none | yes (relay) | yes |
| **`browser-vm`** | **your browser tab** | **the tab itself** | **yes (relay)** | listed, not wired yet |
| `litebox` / `k8s` / `docker-compose` | your infra | micro-VM / pod / container | no | yes |

## What a tab can't do

Honesty section. A browser is a hostile execution host, and three
limitations are structural:

1. **No raw TCP.** `git clone` and `apt install` inside the VM need the
   traffic tunneled over WebSocket (a WISP relay for v86). A browser
   sandbox removes the *compute* backend, not the *networking* one.
2. **No vault credential injection on outbound calls from the tab** —
   same stance as the laptop bridge daemon.
3. **No memory-store or session-outputs mounts** — the tab has no
   bind-mount primitive, the same gap boxrun and k8s-remote have.

And of course: close the tab mid-session and the next sandbox op fails
loudly with a "reopen your sandbox tab" error — never a silent hang.

## Try it

On the Cloudflare deployment:

1. Console → **Runtimes** → the Browser VM card → **Open sandbox tab**.
2. Create an environment with `"sandbox_provider": "browser-vm"`.
3. Point any agent's session at that environment. Its `bash` now runs in
   your tab.

Full design rationale — engine licensing, the four hostile-host problems,
the security model — lives in
[`docs/browser-vm-sandbox.md`](https://github.com/duyet/oma/blob/main/docs/browser-vm-sandbox.md).

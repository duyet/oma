---
title: "Running OMA Sandboxes on NVIDIA OpenShell: Local CLI and Kubernetes"
description: "OpenShell gives agent sandboxes policy-enforced isolation and a default-deny egress proxy. Here's every way to point OMA at a gateway — self-host, your laptop's bridge daemon, Cloudflare, and in-cluster via Helm — with the trade-offs each one makes."
publishedAt: 2026-07-24
author: OMA
tags: ["openshell", "sandbox", "kubernetes", "helm", "bridge", "self-host", "guide"]
draft: true
---

Every OMA session needs somewhere to run `bash` / `read` / `write`. The
default is a Cloudflare Container; the [local bridge](/blog/run-agent-sandbox-local-machine-claude-code-acp)
runs them straight on your machine. Both ends of that spectrum have an
obvious gap: the container is isolated but empty and remote, and the
local subprocess sandbox has **no isolation at all** — it's your real
filesystem, by design.

[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) sits in the
middle. It's a gateway that hands out isolated sandboxes backed by
Docker, Podman, or a MicroVM, with a **default-deny egress proxy** —
so an agent can only reach hosts you allowed. OMA speaks to it as a
sandbox provider, which means you select it per environment and nothing
else about your agents changes.

There are four ways to wire it up, and picking the right one is most of
the work:

| Deployment | How OMA reaches the gateway | Use when |
|---|---|---|
| **Self-host Node** | Direct gRPC | You run `apps/main-node` yourself |
| **Local CLI daemon** | Direct gRPC from `oma bridge daemon` | You want isolation on *your* machine |
| **Cloudflare** | HTTP → k8s-bridge → gRPC | You're on the hosted/Workers deployment |
| **Kubernetes** | HTTP → in-cluster bridge → gRPC | Gateway and bridge both live in a cluster |

The reason Cloudflare and Kubernetes need a bridge at all: a Worker is a
V8 isolate that **cannot speak gRPC**. So a small Node service holds the
gRPC client and re-exposes it over plain HTTP. Everything else is the
same adapter.

## Step 1 — get a gateway running

Skip this if you already have one.

**On a laptop or a single host**, install OpenShell and let it
auto-detect a compute driver (Docker, Podman, or MicroVM):

```bash
curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh
openshell status        # confirm the gateway is up
```

It runs as a background service (systemd / Homebrew) and listens on a
`host:port` you'll reference from here on.

**In a cluster**, install upstream's chart. The
[Agent Sandbox controller + CRDs](https://github.com/kubernetes-sigs/agent-sandbox)
must be installed first — the same controller OMA's own `k8s` provider
uses, so a cluster already running that provider has the prerequisite:

```bash
helm install openshell oci://ghcr.io/nvidia/openshell/helm-chart \
  -n openshell --create-namespace
```

> Upstream marks the Kubernetes path "under active development — expect
> rough edges". The local Docker/Podman path is the stable one.

## Step 2a — self-host Node (direct gRPC)

The simplest case. Point `main-node` at the gateway in `.env.local`:

```bash
OPENSHELL_GATEWAY_ENDPOINT=localhost:50051
```

That's it. With `OPENSHELL_MODE=auto` (the default), OMA runs a cheap
connectivity probe at startup and **prefers OpenShell over `subprocess`**
when the gateway answers — so you don't have to touch any environment
config to get isolation. Force it with `OPENSHELL_MODE=openshell`, or
disable the auto-detect entirely with `OPENSHELL_MODE=subprocess`.

For TLS (and mTLS):

```bash
OPENSHELL_GATEWAY_TLS=1
OPENSHELL_GATEWAY_CA_PATH=/etc/openshell/ca.crt
# + OPENSHELL_GATEWAY_CERT_PATH / OPENSHELL_GATEWAY_KEY_PATH for mTLS
```

To select it explicitly per environment rather than relying on the
probe:

```json
{ "sandbox_provider": "openshell" }
```

## Step 2b — your own machine, via the bridge daemon

If you've paired your laptop with `oma bridge setup`, relayed sandbox
ops run directly on your host filesystem with zero isolation. Pointing
the daemon at a local OpenShell gateway swaps that for an isolated box.

**Be deliberate about this trade.** The whole reason to use a local
environment is usually that the agent gets your real repos, your
toolchains, your `gh` auth. An OpenShell box has none of that — it's
empty. Isolation costs you exactly the thing you paired the machine
for. That's why it is **opt-in only**: OMA will never flip your daemon
just because you happen to have installed OpenShell.

`bridge setup` offers it when it detects a gateway. To enable it by
hand:

```bash
export BRIDGE_SANDBOX_BACKEND=openshell
export OPENSHELL_GATEWAY_ENDPOINT=127.0.0.1:8080
```

Then confirm which backend is actually live — this is the bit that
tells you isolation is really on, rather than assumed:

```bash
oma bridge status
```

```
sandbox   openshell 127.0.0.1:8080  reachable  BRIDGE_SANDBOX_BACKEND=openshell (explicit)
```

versus the default:

```
sandbox   subprocess (host filesystem, no isolation) · default (host subprocess; no explicit opt-in)
```

Two limitations specific to this path. The relay protocol carries no
environment config, so **OMA's environment→policy mapping is not
applied** here — egress is governed by the gateway's own default policy,
not your `allowed_hosts`. And if the daemon crashes, boxes are left
behind on the gateway. Also note this changes *only* sandbox-op
execution: local ACP agents (Claude Code and friends) still spawn on the
host either way.

## Step 2c — Cloudflare

A Worker can't speak gRPC, so it talks to a **k8s-bridge running its
OpenShell backend** over plain `fetch`. Run the bridge as a Node process
next to the gateway with `BRIDGE_BACKEND=openshell` plus the same
`OPENSHELL_*` vars from 2a, then point the Worker at it:

```bash
wrangler secret put OPENSHELL_BRIDGE_URL
wrangler secret put OPENSHELL_BRIDGE_TOKEN   # matches the bridge's K8S_BRIDGE_TOKEN
```

A session with `sandbox_provider: "openshell"` then resolves to a
pure-`fetch` client against the bridge. A missing `OPENSHELL_BRIDGE_URL`
fails loudly with a `session.error` rather than silently falling back —
same contract as `boxrun`'s missing `BOXRUN_URL`.

## Step 2d — Kubernetes, via Helm

Rather than hand-running that bridge, install it from the chart. It's
the same image as the Kubernetes backend, switched with one value:

```bash
helm install oma-k8s-bridge-openshell ./charts/oma-k8s-bridge \
  --namespace oma \
  --set secret.existingSecret=oma-k8s-bridge-token \
  --set config.backend=openshell \
  --set openshell.endpoint=openshell.openshell.svc.cluster.local:50051
```

**RBAC is skipped entirely for this backend.** The OpenShell backend
never creates a pod or touches a Sandbox CR — it fronts an external
gateway — so the chart ships it no cluster permissions at all rather
than unused pod create/delete grants.

For a secured gateway, create the material out-of-band (never `--set` a
real token or cert on the command line — it lands in `helm history` and
your shell history):

```bash
kubectl -n oma create secret generic openshell-tls \
  --from-file=ca.crt=./ca.crt --from-file=tls.crt=./client.crt --from-file=tls.key=./client.key
kubectl -n oma create secret generic openshell-token \
  --from-literal=OPENSHELL_TOKEN="$(openssl rand -base64 32)"
```

```bash
helm upgrade oma-k8s-bridge-openshell ./charts/oma-k8s-bridge \
  --namespace oma \
  --set config.backend=openshell \
  --set openshell.endpoint=openshell.openshell.svc.cluster.local:50051 \
  --set openshell.tls.enabled=true \
  --set openshell.tls.caSecret=openshell-tls \
  --set openshell.tls.certSecret=openshell-tls \
  --set openshell.token.existingSecret=openshell-token
```

One detail worth understanding, because it's easy to get wrong:
**`certSecret` is what turns on mTLS.** Leave it empty and you get plain
server-auth TLS — the chart then emits no client cert/key paths at all.
That's deliberate: a Secret mounts as a directory containing only its own
keys, so pointing the gRPC client at a `tls.crt` that a CA-only Secret
doesn't contain would fail the handshake on every sandbox creation. If
one Secret carries all three keys, name it for both values, as above.

Then wire Cloudflare at the Service exactly as in 2c, using
`http://oma-k8s-bridge-openshell.oma.svc.cluster.local:8100`.

## How your environment config becomes policy

On every path *except* the bridge-daemon relay, an environment's
`config.networking` is translated into an OpenShell `SandboxPolicy` and
attached at sandbox creation — so OMA's egress rules are enforced by the
gateway's default-deny proxy rather than merely described:

```json
{
  "networking": {
    "type": "limited",
    "allowed_hosts": ["api.github.com", "registry.npmjs.org"]
  }
}
```

becomes a single network policy rule whose endpoints are those hosts.
Everything else is denied. The mapping is one shared module used by both
the direct gRPC adapter and the bridge backend, so self-host and
Cloudflare enforce identically.

## Known limitations

Worth knowing before you commit to this:

- **No memory-store or session-outputs mounts** over the bridge's HTTP
  API — shared with the `boxrun` and `k8s-remote` providers. The direct
  gRPC path is unaffected.
- **No policy mapping on the bridge-daemon relay** (step 2b), as above.
- **Upstream's Kubernetes path is young.** Local Docker/Podman is the
  stable driver today.
- Commands run in the container's default working directory rather than
  a `/workspace` the gateway was told about, so agents that assume
  relative paths behave slightly differently than on other providers.

## Which one should you use?

If you self-host, use **2a** — direct gRPC, full policy mapping, least
moving parts. If you're on Cloudflare, you need a bridge, so **2d** if
you have a cluster and **2c** if you don't. Reach for **2b** only when
you specifically want isolation on your own machine and are willing to
give up the local toolchain that made the local runtime attractive in
the first place.

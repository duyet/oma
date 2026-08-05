---
title: "Run OMA Agent Sandboxes on Your Private Kubernetes Cluster"
description: "Keep the OMA control plane hosted (or self-hosted) and put bash, files, and tool execution on pods inside your VPC. Three Helm charts, outbound bridge vs HTTP k8s-remote, and when to pick each path."
publishedAt: 2026-08-05
author: OMA
tags:
  - kubernetes
  - helm
  - sandbox
  - bridge
  - self-host
  - private-cluster
  - guide
---

Every OMA session needs somewhere to run tools — `bash`, `read`, `write`,
`edit`, `glob`, `grep`, and anything MCP or the browser touch. By default
that's a [Cloudflare Container](/features/agent-sandbox/) or, if you pair
a laptop, a [local bridge daemon](/blog/run-agent-sandbox-local-machine-claude-code-acp/).

Both ends leave a common gap: **you already have a private Kubernetes
cluster** — a homelab, a locked-down VPC, a GPU node pool, or a tenant
namespace with NetworkPolicy you control — and you want agent sandboxes
to be **pods you own**, not a vendor micro-VM and not your laptop
filesystem.

This post is the private-cluster path end to end: what stays on the
control plane, which Helm chart to install, how sessions pick the
cluster, and the trade-offs versus laptop bridge and full self-host.

For a shorter product overview, see the landing page:
[Private Kubernetes](/features/private-kubernetes/).

## The split that makes this work

OMA is a **meta-harness**. The platform owns *what* an agent has
(session event log, tools catalog, vault credentials, skills). A
harness owns *how* the model loop runs. The sandbox is where tools
**execute** — and that layer is deliberately swappable.

| Layer | Stays where | Private K8s changes |
|---|---|---|
| Sessions, SSE, crash recovery | Control plane | No |
| Model calls + vault injection | Control plane / outbound proxy | No |
| Agent config, skills, MCP proxy | Control plane | No |
| `bash` / files / process lifecycle | **Sandbox** | **Your cluster pods** |

So you do **not** have to move the Console, D1/SQLite, or the Durable
Object event log into the cluster just to get pods. Hosted
[app.oma.duyet.net](https://app.oma.duyet.net/) can keep owning the
plane while compute lands in your VPC.

That boundary is the same idea as the laptop bridge — only the worker
is a Deployment instead of a MacBook.

## Three Helm charts (pick one job)

Charts live under
[`charts/`](https://github.com/duyet/oma/tree/main/charts) in the repo.

| Chart | Job | When to use it |
|---|---|---|
| **`oma-bridge-daemon`** | Outbound reverse-WebSocket sandbox worker | Keep a remote control plane (hosted or another OMA); cluster only runs tools |
| **`oma-k8s-bridge`** | Token-gated HTTP gateway for sandboxes | Cloudflare Workers can't speak gRPC / load kube clients — they need plain `fetch` |
| **`oma`** | Full control plane on the cluster | You want API + Console + vault + sandboxes all in-cluster, no remote plane |

`oma-bridge-daemon` and `oma-k8s-bridge` are **sandbox workers**. The
`oma` chart is a different product shape: the whole plane moves in.
Most teams that already use hosted OMA want one of the first two.

## Path A — outbound bridge daemon (no inbound ports)

Same security model as [local machine bridge](/features/local-machine/):
the worker **only dials out**. Nothing listens on your cluster for the
control plane. Heartbeats keep the runtime online; if it goes quiet,
sandbox ops fail loud with `session.error` instead of hanging.

### 1. Pair once

On any machine with a browser (or use a multi-use pairing code from
the Console for CI / non-interactive installs):

```bash
oma bridge setup \
  --server-url=https://app.oma.duyet.net \
  --no-service
```

That writes `~/.oma/bridge/credentials.json` (and usually
`machine-id`). Do **not** pass those files on the Helm CLI — they land
in release history and shell history in plaintext.

### 2. Ship credentials as a Secret

```bash
kubectl create namespace oma

kubectl -n oma create secret generic oma-bridge-daemon-creds \
  --from-file=credentials.json="$HOME/.oma/bridge/credentials.json" \
  --from-file=machine-id="$HOME/.oma/bridge/machine-id"
```

### 3. Helm install

```bash
helm dependency build ./charts/oma-bridge-daemon

helm install oma-bridge ./charts/oma-bridge-daemon \
  --namespace oma \
  --set secret.existingSecret=oma-bridge-daemon-creds
```

The chart ships **no** ServiceAccount, RBAC, Service, or Ingress for
the default subprocess-style relay path: the pod is an outbound client
re-seeded from the Secret on every restart. Optional OpenShell backend
is values-driven when you want policy-enforced isolation instead of
raw host/process relay — see
[OpenShell + K8s](/blog/openshell-sandboxes-local-cli-and-kubernetes/)
and the chart README.

### 4. Point an environment at the runtime

```json
{
  "name": "homelab-k8s",
  "config": {
    "type": "cloud",
    "sandbox_provider": "subprocess",
    "packages": {
      "pip": ["numpy"]
    }
  }
}
```

On Cloudflare, `subprocess` means “relay to a paired bridge runtime”
— the Worker never spawns `child_process`. Sessions that use this
environment execute tools on the cluster daemon that most recently
heartbeated for your tenant.

## Path B — HTTP `k8s-remote` for Cloudflare Workers

A Worker is a V8 isolate: no kubeconfig, no `@kubernetes/client-node`,
no gRPC. For **ordinary pods** (Sandbox CRDs) driven from hosted OMA or
a CF deployment, install **`oma-k8s-bridge`** in the cluster and expose
a token-gated HTTP API (create / exec+SSE / files-as-tar / destroy).

```bash
helm install oma-k8s-bridge ./charts/oma-k8s-bridge \
  --namespace oma \
  --set secret.existingSecret=oma-k8s-bridge-token
```

On the plane, set `K8S_SANDBOX_GATEWAY_URL` (e.g. `wrangler secret put`)
and select the provider on the environment:

```json
{
  "name": "vpc-pods",
  "config": {
    "sandbox_provider": "k8s-remote",
    "packages": {
      "pip": ["pandas"]
    },
    "networking": {
      "type": "limited",
      "allowed_hosts": ["api.github.com", "registry.npmjs.org"],
      "allow_mcp_servers": true,
      "allow_package_managers": true
    }
  }
}
```

**`k8s-remote` vs `openshell`:** raw pods you own (images, NetworkPolicy,
node pools, RBAC) versus NVIDIA OpenShell sandboxes with
policy-enforced egress. Both use an HTTP bridge from Cloudflare; they
differ in what runs *behind* the bridge. Full comparison:
[docs/deploy/k8s-sandbox-backends](https://docs.oma.duyet.net/deploy/k8s-sandbox-backends/).

## Path C — full control plane on the cluster

When you want **zero** dependency on a remote plane:

```bash
kubectl create namespace oma
kubectl -n oma create secret generic oma \
  --from-literal=PLATFORM_ROOT_SECRET="$(openssl rand -base64 32)" \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=ANTHROPIC_API_KEY="sk-ant-..."

helm install oma ./charts/oma \
  --namespace oma \
  --set secret.existingSecret=oma \
  --set agentSandbox.enabled=true \
  --set ingress.enabled=true \
  --set ingress.host=oma.example.com
```

Here sandboxes typically use the in-cluster **`k8s`** provider (Node
runtime + cluster RBAC). Back up `PLATFORM_ROOT_SECRET` — it encrypts
vault credentials and model-card keys at rest; losing it makes those
rows unreadable.

## What you get — and what you don't

**You get**

- Tool execution inside **your** network boundary and RBAC
- Same agents and sessions whether sandboxes are CF, laptop, or K8s —
  only `sandbox_provider` (and the worker) change
- Outbound-only option for airgapped / no-inbound clusters
- Helm install path that matches how operators already ship workloads

**Known limitations** (same family as boxrun / HTTP sandbox APIs)

- Memory-store and session-outputs **bind-mounts** are not available
  over the HTTP tar / bridge APIs
- If no bridge runtime is online, the first sandbox op fails clearly
  (`session.error`) — it does not queue forever
- Credential injection for bridge/subprocess paths follows the bridge
  proxy rules (not every TLS client is MITM'd); vault-at-network-layer
  is strongest on the cloud outbound proxy path

None of that is unique to Kubernetes — it's the cost of putting the
sandbox on a relay or remote HTTP executor instead of a bind-mounted
local volume.

## Cluster vs laptop vs cloud container

| | Private K8s | Local machine | Cloudflare Containers |
|---|---|---|---|
| Where tools run | Pods / OpenShell on your cluster | Your laptop / workstation | Managed containers |
| Control plane | Hosted or remote, or full `charts/oma` | Hosted or remote | Hosted / Workers |
| Install | Helm | `oma bridge setup` | Default (no extra chart) |
| Isolation | Pod / OpenShell policy | Your user account (subprocess) | Container isolation |
| Best when | VPC residency, shared fleets, GPU pools | Dev on a real repo/toolchain | Zero cluster ops |

Pick **laptop** when the agent should see *your* checkout and `gh` auth.
Pick **private K8s** when many sessions should share a fleet of pods
you operate. Pick **CF Containers** when you want zero cluster to run.

## Minimal checklist

1. Decide: remote plane + worker (**A** or **B**) vs full plane (**C**).
2. Install the matching chart; keep secrets out of `helm --set`.
3. Confirm the runtime/gateway is healthy (Console → Runtimes, or
   gateway health if `k8s-remote`).
4. Create an environment with the right `sandbox_provider`.
5. Create a session on that environment and run a trivial `bash` tool
   call — if the worker is wrong, you'll get a loud `session.error`,
   not a silent hang.

## Further reading

- [Private Kubernetes feature page](/features/private-kubernetes/) —
  diagram + chart overview
- [Any Sandbox](/features/agent-sandbox/) — full provider table
- [Local machine bridge](/features/local-machine/) and
  [laptop + ACP post](/blog/run-agent-sandbox-local-machine-claude-code-acp/)
- [OpenShell on CLI and Kubernetes](/blog/openshell-sandboxes-local-cli-and-kubernetes/)
- Docs:
  [Kubernetes deploy](https://docs.oma.duyet.net/deploy/kubernetes/),
  [k8s sandbox backends](https://docs.oma.duyet.net/deploy/k8s-sandbox-backends/),
  [charts README](https://github.com/duyet/oma/tree/main/charts)

Same agent. Same session log. Different place for the shell — this time
a cluster you already trust.

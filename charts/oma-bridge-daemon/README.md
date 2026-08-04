# oma-bridge-daemon

Helm chart for the **OMA bridge daemon** — runs `oma bridge daemon`
(`npx -y @getoma/cli bridge daemon`) inside Kubernetes as a long-lived
reverse-WebSocket sandbox worker that connects OUT to an OMA control plane
(default `https://app.oma.duyet.net`) and executes relayed cloud-agent
sandbox ops. Packages the raw manifests at `deploy/cli-bridge-daemon/` into a
values-driven chart, and optionally installs the NVIDIA OpenShell gateway as
a subchart for the `openshell` backend. See
[`docs/deploy/k8s-sandbox-backends.md`](../../docs/deploy/k8s-sandbox-backends.md)
for the `k8s-remote` vs `openshell` comparison and the daemon's architecture.

## Prerequisites

- Kubernetes 1.25+, `kubectl` configured against it
- Helm 3
- An OMA control plane that accepts bridge runtimes (e.g.
  `https://app.oma.duyet.net`)
- When `openshell.enabled: true`: the agent-sandbox controller
  (`sandboxes.agents.x-k8s.io` CRDs) is installed automatically by this chart
  as a Helm pre-install hook (no manual install needed)

The daemon is outbound-only (WS to the control plane, gRPC to the OpenShell
gateway) and never touches the Kubernetes API, so the chart ships **no**
ServiceAccount, RBAC, Service, Ingress, or PVC — each pod is a stateless
outbound client re-seeded from a credentials Secret on every restart.

## Install

The daemon reads its identity (server URL + paired runtime credentials) ONLY
from `credentials.json`, which is produced by a one-time interactive pairing
flow. You therefore pair on a browser-capable machine once, ship the
resulting creds into the cluster, then install the chart.

**1. Pair a runtime with the control plane (once, on any machine with a
browser):**

```bash
oma bridge setup --server-url=https://app.oma.duyet.net --no-service --yes
# complete the OAuth click in the browser
```

This writes `~/.oma/bridge/credentials.json` and `~/.oma/bridge/machine-id`.

**2. Ship the creds into the cluster as a Kubernetes Secret** (do not pass
credentials.json on the Helm command line — it lands in `helm history` /
release storage in plaintext, and in your shell history):

```bash
kubectl create namespace oma
kubectl -n oma create secret generic oma-bridge-daemon-creds \
  --from-file=credentials.json="$HOME/.oma/bridge/credentials.json" \
  --from-file=machine-id="$HOME/.oma/bridge/machine-id"
```

(Or manage it with [external-secrets](https://external-secrets.io/) /
sealed-secrets and keep `secret.existingSecret` pointed at the result. Both
keys are required — the chart's `creds-src` volume projects exactly
`credentials.json` + `machine-id`.)

**3. Install the chart**, pointing at that Secret:

```bash
# Local subprocess backend (default) — runs sandbox ops inside the pod:
helm install oma-bridge-daemon ./charts/oma-bridge-daemon \
  --namespace oma \
  --set secret.existingSecret=oma-bridge-daemon-creds

# OpenShell backend — installs the gateway subchart + agent-sandbox hook and
# auto-derives BRIDGE_SANDBOX_BACKEND=openshell +
# OPENSHELL_GATEWAY_ENDPOINT=openshell-gateway.<ns>.svc.cluster.local:8080:
helm install oma-bridge-daemon ./charts/oma-bridge-daemon \
  --namespace oma \
  --set secret.existingSecret=oma-bridge-daemon-creds \
  --set openshell.enabled=true
```

> Pairing is interactive — there is no non-interactive `oma bridge setup`
> path. The credentials.json is the OAuth output, not something to generate
> in CI. Once paired, the Secret is the only secret this chart consumes.

## Values

| Key | Default | Description |
|---|---|---|
| `image.repository` / `image.tag` / `image.pullPolicy` | `node` / `22-slim` / `IfNotPresent` | Daemon container image (the published CLI runs on plain Node) |
| `cliVersion` | `""` | Pin `@getoma/cli` for `npx -y @getoma/cli@<cliVersion>`; empty = latest |
| `controlPlane.url` | `https://app.oma.duyet.net` | Documented target only — the daemon reads the real URL from `credentials.json` |
| `bridge.backend` | `""` | `""` (local subprocess) or `openshell`; explicit override wins over `openshell.enabled` |
| `bridge.namespace` | `""` | Namespace the daemon runs in (default = release namespace) |
| `secret.existingSecret` | `oma-bridge-daemon-creds` | Pre-existing Secret holding `credentials.json` + `machine-id` |
| `secret.credentialsKey` / `secret.machineIdKey` | `credentials.json` / `machine-id` | Keys inside that Secret |
| `secret.credentials` | `""` | Inline credentials.json (unusual — see [Secrets](#secrets)) |
| `openshell.enabled` | `false` | Install the OpenShell gateway subchart + agent-sandbox hook and auto-derive the daemon's openshell env |
| `openshell.gatewayEndpoint` | `""` | Override the derived `host:port`; empty auto-derives `openshell-gateway.<ns>.svc.cluster.local:8080` |
| `openshell.sandboxNamespace` | `""` | Namespace OpenShell Sandbox CRs land in (default = release namespace) |
| `openshell.image` | `""` | Sandbox image OpenShell launches; empty = gateway default |
| `openshell.token.existingSecret` / `.secretKey` | `""` / `OPENSHELL_TOKEN` | Pre-existing Secret carrying the gateway bearer token |
| `agentSandbox.enabled` | `false` | Install the agent-sandbox controller hook explicitly (auto-rendered when `openshell.enabled`) |
| `agentSandbox.version` | `v0.5.4` | agent-sandbox release tag (GitHub Releases) |
| `agentSandbox.manifestUrl` | `""` | Override the full manifest URL (reviewed fork/mirror) |
| `agentSandbox.hook.image.repository` / `.tag` | `registry.k8s.io/kubectl` / `v1.31.0` | Installer hook image |
| `agentSandbox.hook.serverSideApply` | `true` | Pass `--force-conflicts` to `kubectl apply --server-side` |
| `resources` | `100m/128Mi` requests, `1/512Mi` limits | Daemon pod resources |
| `nameOverride` / `fullnameOverride` | `""` / `""` | Name overrides |

## Backends

The daemon's backend is selected by `BRIDGE_SANDBOX_BACKEND`:

- **`""` (default — local subprocess relay).** Sandbox ops run inside the pod
  using the host kernel and filesystem. Works with the published
  `@getoma/cli` on a plain `node:22-slim` image; nothing else to install.
- **`"openshell"` (gRPC relay).** Each sandbox op is relayed to an NVIDIA
  OpenShell gateway over gRPC. Needs `OPENSHELL_GATEWAY_ENDPOINT` set as well.
  Important: setting `OPENSHELL_GATEWAY_ENDPOINT` alone does NOT flip the
  backend — `BRIDGE_SANDBOX_BACKEND=openshell` must be set explicitly (matches
  the daemon's own resolution rule in
  `packages/cli/src/bridge/lib/sandbox-backend.ts`).

When `openshell.enabled: true`, the ConfigMap auto-derives both values
(`BRIDGE_SANDBOX_BACKEND=openshell` and the in-cluster gateway endpoint)
unless an explicit `bridge.backend` / `openshell.gatewayEndpoint` override is
set. When `openshell.enabled: false` and `bridge.backend: ""` (the default),
the ConfigMap emits empty strings and the daemon runs the local relay.

## OpenShell install

`openshell.enabled: true` does three things in one chart:

1. Installs the NVIDIA [OpenShell](https://github.com/NVIDIA/OpenShell) gateway
   as a Helm subchart (pulled from `oci://ghcr.io/nvidia/openshell` at
   `helm dependency build` time, aliased under `.Values.openshellGateway`).
2. Renders the [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
   controller + `sandboxes.agents.x-k8s.io` CRD install hook (the same hook
   `charts/oma` ships) — OpenShell's Kubernetes driver requires it. The hook
   is a Helm pre-install Job that runs `kubectl apply --server-side` against
   the manifest at `agentSandbox.version`; the CRDs survive `helm uninstall`
   by design.
3. Auto-derives `BRIDGE_SANDBOX_BACKEND=openshell` and
   `OPENSHELL_GATEWAY_ENDPOINT=openshell-gateway.<sandboxNamespace>.svc.cluster.local:8080`
   in the daemon's ConfigMap.

```bash
helm dependency build ./charts/oma-bridge-daemon   # fetches the OCI subchart
helm install oma-bridge-daemon ./charts/oma-bridge-daemon \
  --namespace oma \
  --set secret.existingSecret=oma-bridge-daemon-creds \
  --set openshell.enabled=true
```

To point the daemon at an external gateway instead (one you've installed
out-of-band), leave `openshell.enabled` off and set the backend explicitly:

```bash
helm install oma-bridge-daemon ./charts/oma-bridge-daemon \
  --namespace oma \
  --set secret.existingSecret=oma-bridge-daemon-creds \
  --set bridge.backend=openshell \
  --set openshell.gatewayEndpoint=openshell.openshell.svc.cluster.local:50051
```

## Secrets

`secret.existingSecret` (default `oma-bridge-daemon-creds`) is the normal
path. The chart renders no Secret at all when it is set — credentials.json is
interactive OAuth output that must come from `oma bridge setup`, never from a
committed values file. The unusual `secret.credentials` inline path only
renders when you explicitly set it AND clear `existingSecret`; prefer the
out-of-band Secret.

## Verify

```bash
helm dependency build ./charts/oma-bridge-daemon
helm lint ./charts/oma-bridge-daemon

# Default (local subprocess backend) — daemon Deployment + ConfigMap only:
helm template oma-bridge-daemon ./charts/oma-bridge-daemon \
  --namespace oma

# OpenShell backend against an external gateway (subchart NOT installed):
helm template oma-bridge-daemon ./charts/oma-bridge-daemon \
  --namespace oma \
  --set bridge.backend=openshell

# OpenShell subchart installed — gateway subchart + agent-sandbox hook render:
helm template oma-bridge-daemon ./charts/oma-bridge-daemon \
  --namespace oma \
  --set openshell.enabled=true

# Subchart installed but daemon pinned to local (explicit override wins):
helm template oma-bridge-daemon ./charts/oma-bridge-daemon \
  --namespace oma \
  --set openshell.enabled=true \
  --set bridge.backend=local
```

Once installed, confirm the daemon registered with the control plane:

```bash
kubectl -n oma logs deployment/oma-bridge-daemon | grep -E "WS attached|registered"
# → "WS attached" once the reverse-WebSocket to the control plane is live
```

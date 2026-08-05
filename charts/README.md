# Helm charts

Helm charts for deploying OMA on Kubernetes. Each chart is self-contained with its own `README.md` and `values.yaml`; install from the repo root via `helm install <name> ./charts/<chart>`.

| Chart | What it deploys | When to use it | Docs |
|---|---|---|---|
| [`oma/`](oma/README.md) | The full self-host **control plane** — `apps/main-node` (HTTP API + Console) and its `oma-vault` outbound-credential sidecar as a single-pod, two-container Deployment with a shared RWO PVC, plus optional Ingress and an agent-sandbox controller install hook. | You want a **standalone OMA instance** — your own model loop, your own sandboxes, no dependency on a hosted control plane. | [chart](oma/README.md) · [docs/self-host.md](../docs/self-host.md) · [docs/deploy/kubernetes.md](../docs/deploy/kubernetes.md) |
| [`oma-bridge-daemon/`](oma-bridge-daemon/README.md) | The **bridge daemon** (`oma bridge daemon`) as a long-lived reverse-WebSocket worker that connects OUT to a remote control plane (default `https://app.oma.duyet.net`) and executes relayed sandbox ops. Outbound-only: no ServiceAccount, RBAC, Service, Ingress, or PVC. Optionally installs the NVIDIA OpenShell gateway as a subchart. | You want a **sandbox worker for an existing control plane** — e.g. run sandboxes on your own cluster while keeping `app.oma.duyet.net` (or any other OMA instance) as the control plane. | [chart](oma-bridge-daemon/README.md) · [docs/deploy/k8s-bridge.md](../docs/deploy/k8s-bridge.md) |
| [`oma-k8s-bridge/`](oma-k8s-bridge/README.md) | `apps/k8s-bridge` — a token-gated HTTP bridge that lets a Cloudflare Worker (which cannot load `@kubernetes/client-node` or any native driver) manage sandbox pods on a real cluster via a small REST API. Can also front an OpenShell gateway. | You run OMA on **Cloudflare Workers** and want sandbox execution on your own Kubernetes cluster (`k8s-remote` / `openshell` providers). | [chart](oma-k8s-bridge/README.md) · [docs/deploy/k8s-sandbox-backends.md](../docs/deploy/k8s-sandbox-backends.md) |

## Two deployment modes

These charts reflect two fundamentally different ways to run OMA on your own infrastructure:

- **Fullstack (`oma`).** The chart runs the whole control plane: HTTP API, Console, agent runtime, model loop, event log, vault, and sandbox provider. Sessions live here, model calls fire from here, and sandboxes run wherever this deployment points them. Nothing outside this deployment is required beyond an LLM API key. See [`docs/self-host.md`](../docs/self-host.md).

- **Bridge worker (`oma-bridge-daemon`).** The chart runs **only** the sandbox execution worker. It pairs with a remote control plane over a one-time interactive OAuth flow (`oma bridge setup`), then opens a reverse-WebSocket out to that plane, which drives the model loop and owns the event log, agent configuration, and session state. The daemon only executes the relayed sandbox ops — locally as subprocesses or over gRPC against an OpenShell gateway. Use it to put sandbox compute on your own infrastructure (a homelab cluster, a GPU node pool) while keeping a hosted control plane like `app.oma.duyet.net`.

`oma-k8s-bridge` is neither of these — it is narrow plumbing that lets a Cloudflare Worker reach sandboxes on your cluster over HTTP, not a deployment mode by itself. It serves the `k8s-remote` and `openshell` providers; see [`docs/deploy/k8s-sandbox-backends.md`](../docs/deploy/k8s-sandbox-backends.md).

## Common prerequisites

- Kubernetes 1.25+, `kubectl` configured against it
- Helm 3
- For sandbox-pod charts, the [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller + `sandboxes.agents.x-k8s.io` CRDs — `oma` and `oma-bridge-daemon` can auto-install them via a Helm hook (`agentSandbox.enabled` / `openshell.enabled`)

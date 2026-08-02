# oma-k8s-bridge

Helm chart for `apps/k8s-bridge` — the HTTP bridge that lets a Cloudflare
Worker (which cannot load `@kubernetes/client-node` or any native driver)
manage sandbox pods on a real Kubernetes cluster via a small, token-gated
REST API. See [`docs/deploy/k8s-bridge.md`](../../docs/deploy/k8s-bridge.md)
for the full reference (API endpoints, architecture, troubleshooting) and
[`docs/deploy/k8s-bridge-quickstart.md`](../../docs/deploy/k8s-bridge-quickstart.md)
for the 10-minute install → register → verify path. This README covers just
the chart itself.

## Prerequisites

- Kubernetes 1.25+, `kubectl` configured against it
- Helm 3
- No cert-manager requirement — TLS works with a Secret you already have
  (`ingress.tls.enabled` + `ingress.tls.secretName`); the chart never
  requires an in-cluster issuer.

## Install

**1. Generate the bearer token the bridge will require on every request**
(`apps/k8s-bridge/src/auth.ts` gates `/api/v1/*` behind it):

```bash
openssl rand -base64 32
```

**2. Create the token as a Kubernetes Secret out-of-band** — do not pass a
real token on the Helm command line in production (it lands in
`helm history`/release storage in plaintext, and in your shell history):

```bash
kubectl create namespace sandboxes
kubectl -n sandboxes create secret generic oma-k8s-bridge-token \
  --from-literal=K8S_BRIDGE_TOKEN="$(openssl rand -base64 32)"
```

(Or manage it with [external-secrets](https://external-secrets.io/) /
sealed-secrets and point `secret.existingSecret` at the result instead.)

**3. Install the chart**, pointing at that Secret:

```bash
helm install oma-k8s-bridge ./charts/oma-k8s-bridge \
  --namespace sandboxes \
  --set secret.existingSecret=oma-k8s-bridge-token \
  --set config.namespace=sandboxes
```

For quick local testing only (never for a real deployment), you can instead
let the chart create the Secret from a value on the command line:

```bash
helm install oma-k8s-bridge ./charts/oma-k8s-bridge \
  --namespace sandboxes --create-namespace \
  --set secret.token="$(openssl rand -base64 32)"
```

**4. Wait for rollout and verify:**

```bash
kubectl -n sandboxes rollout status deployment/oma-k8s-bridge
kubectl -n sandboxes port-forward svc/oma-k8s-bridge 8100:8100 &
curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" http://localhost:8100/api/v1/health
```

## Values

| Key | Default | Description |
|---|---|---|
| `image.repository` / `image.tag` / `image.pullPolicy` | `ghcr.io/duyet/oma-k8s-bridge` / `latest` / `IfNotPresent` | Bridge container image |
| `replicaCount` | `2` | Deployment replicas |
| `secret.token` | `""` | Bearer token (empty placeholder only — see [Secrets](#secrets)) |
| `secret.existingSecret` | `""` | Name of a pre-existing Secret to source the token from instead |
| `secret.tokenKey` | `K8S_BRIDGE_TOKEN` | Key inside the Secret holding the token |
| `config.namespace` | `sandboxes` | Namespace the bridge provisions sandbox pods into |
| `config.sandboxImage` | `node:22-slim` | Default sandbox container image |
| `config.runtimeClass` / `config.serviceAccount` | `""` | Optional RuntimeClass / ServiceAccount for sandbox pods |
| `config.backend` | `k8s` | `k8s` \| `openshell` \| `auto` — which `BridgeBackend` the process runs, see [OpenShell backend](#openshell-backend) below |
| `openshell.endpoint` | `""` | `host:port` of the OpenShell gateway (required when `config.backend: openshell`) |
| `openshell.image` | `""` | Sandbox image OpenShell launches; empty = gateway default |
| `openshell.tls.enabled` / `.caSecret` | `false` / `""` | Server-auth TLS to the gateway; `caSecret` holds the CA |
| `openshell.tls.certSecret` | `""` | Secret holding the client cert/key — setting it is what enables **mTLS**. May name the same Secret as `caSecret` if it holds all three keys |
| `openshell.token.existingSecret` / `.tokenKey` | `""` / `OPENSHELL_TOKEN` | Pre-existing Secret carrying the gateway bearer token |
| `service.type` / `service.port` | `ClusterIP` / `8100` | Bridge Service |
| `ingress.enabled` | `false` | Expose the bridge via Ingress |
| `ingress.tls.enabled` / `ingress.tls.secretName` | `false` / `oma-k8s-bridge-tls` | TLS via a Secret you provide (no cert-manager dependency) |
| `resources` | `100m/128Mi` requests, `500m/512Mi` limits | Bridge pod resources |
| `hpa.enabled` | `true` | HorizontalPodAutoscaler on CPU |
| `rbac.create` | `true` | Create the Role/RoleBinding + ClusterRole/ClusterRoleBinding |
| `rbac.targetNamespace` | `""` (falls back to `config.namespace`) | Namespace the namespace-scoped Role/RoleBinding target — must match where sandbox pods run |
| `serviceAccount.create` / `serviceAccount.name` | `true` / `""` | ServiceAccount the bridge Pod runs as |

## RBAC

See the annotated rules in [`templates/rbac.yaml`](templates/rbac.yaml) and
the "RBAC Permissions" section of
[`docs/deploy/k8s-bridge.md`](../../docs/deploy/k8s-bridge.md#rbac-permissions)
for the full verb-by-verb justification. Summary: a namespace-scoped `Role`
(sandbox pod create/exec/log/delete, scoped to `rbac.targetNamespace`) plus a
`ClusterRole` for the handful of operations that are genuinely cluster-scoped
(node listing, cross-namespace pod listing for capacity reporting, metrics).
No wildcards, no cluster-admin.

## Secrets

`K8S_BRIDGE_TOKEN` is the only secret this chart manages. `secret.token` in
`values.yaml` defaults to an empty-string placeholder and must never be set
to a real token in a committed values file — generate it with
`openssl rand -base64 32` and either pass it with `--set` for a quick local
install, or (recommended) create the Secret out-of-band and reference it via
`secret.existingSecret` as shown above.

This chart deploys only the k8s-bridge process — it does **not** carry
`BETTER_AUTH_SECRET` or `PLATFORM_ROOT_SECRET`. Those belong to the separate
main OMA control-plane app (Console auth signing and at-rest credential
encryption respectively — see the repo root `CLAUDE.md`) and are not
consumed by `apps/k8s-bridge` at all.

## Pod security

The bridge Pod runs `runAsNonRoot`, non-root UID/GID, `seccompProfile:
RuntimeDefault`, `allowPrivilegeEscalation: false`, all Linux capabilities
dropped, and a read-only root filesystem (the process writes nothing to
disk — all state is the in-memory box map plus outbound Kubernetes API
calls). This is the bridge's own container; it does not affect the
hardening of the ephemeral sandbox pods it creates for sessions, which are
controlled separately by the `agent-sandbox` controller's `Sandbox` CRD
(`podTemplate.spec`) and the cluster's own `RuntimeClass`/PodSecurity setup.

## OpenShell backend

By default this chart runs `apps/k8s-bridge`'s Kubernetes backend (creates a
`Sandbox` CR per session, per the RBAC above). Setting `config.backend:
openshell` switches the same Deployment to front an
[NVIDIA OpenShell](https://github.com/NVIDIA/OpenShell) gateway over gRPC
instead — see `apps/k8s-bridge/src/backend.ts` and
`apps/k8s-bridge/src/openshell-manager.ts`. This is the in-cluster half of
what `docs/self-host.md`'s ["Running an OpenShell
gateway"](../../docs/self-host.md#running-an-openshell-gateway) section
describes; that doc also covers running the bridge as a bare Node process,
which remains the option for local/non-cluster setups.

**Prerequisites** (same as the OpenShell adapter needs anywhere):

- The [Agent Sandbox controller + CRDs](https://github.com/kubernetes-sigs/agent-sandbox)
  installed in the cluster the gateway itself deploys into.
- The NVIDIA OpenShell gateway chart installed and reachable, e.g.:

  ```bash
  helm install openshell oci://ghcr.io/nvidia/openshell/helm-chart \
    -n openshell --create-namespace
  ```

**Install this chart pointed at that gateway.** RBAC is skipped entirely for
this backend (it owns no pods — see `templates/rbac.yaml`), so no
`rbac.targetNamespace` / `config.namespace` tuning is needed for it:

```bash
helm install oma-k8s-bridge-openshell ./charts/oma-k8s-bridge \
  --namespace oma \
  --set secret.existingSecret=oma-k8s-bridge-token \
  --set config.backend=openshell \
  --set openshell.endpoint=openshell.openshell.svc.cluster.local:50051
```

With mTLS to the gateway, create the CA/cert/key material as a Secret
out-of-band first (never `--set` real certs on the command line):

```bash
kubectl -n oma create secret generic openshell-tls \
  --from-file=ca.crt=./ca.crt --from-file=tls.crt=./client.crt --from-file=tls.key=./client.key
kubectl -n oma create secret generic openshell-token \
  --from-literal=OPENSHELL_TOKEN="$(openssl rand -base64 32)"
```

```bash
helm upgrade oma-k8s-bridge-openshell ./charts/oma-k8s-bridge \
  --namespace oma \
  --set secret.existingSecret=oma-k8s-bridge-token \
  --set config.backend=openshell \
  --set openshell.endpoint=openshell.openshell.svc.cluster.local:50051 \
  --set openshell.tls.enabled=true \
  --set openshell.tls.caSecret=openshell-tls \
  --set openshell.tls.certSecret=openshell-tls \
  --set openshell.token.existingSecret=openshell-token
```

**Wire the Cloudflare deployment at this Service** — the Worker cannot speak
gRPC, so it reaches OpenShell through this bridge's HTTP API:

```bash
wrangler secret put OPENSHELL_BRIDGE_URL
# → http://oma-k8s-bridge-openshell.oma.svc.cluster.local:8100 (or your Ingress URL)
wrangler secret put OPENSHELL_BRIDGE_TOKEN
# → the same value as K8S_BRIDGE_TOKEN / secret.existingSecret above
```

A session with `config.sandbox_provider: "openshell"` then resolves through
this bridge without the Worker ever touching gRPC. Known limitation, shared
with the `boxrun` and `k8s-remote` sandbox providers: memory-store /
session-outputs mounts aren't available over the bridge's HTTP API.

## Verify

```bash
helm lint ./charts/oma-k8s-bridge
helm template oma-k8s-bridge ./charts/oma-k8s-bridge --set secret.token=test

# OpenShell backend
helm template oma-k8s-bridge ./charts/oma-k8s-bridge --set secret.token=test \
  --set config.backend=openshell --set openshell.endpoint=host:50051
```

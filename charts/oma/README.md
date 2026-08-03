# oma

Helm chart for the **self-hosted OMA control plane** — packages `apps/main-node`
(HTTP API + Console on `:8787`, sqlite + local FS store) and its `oma-vault`
sidecar (outbound-credential MITM proxy on `:14322`) as a single-pod,
two-container Deployment backed by a shared RWO PVC. Mirrors the production
raw manifests at `infra/homelab/oma/`. See
[`docs/self-host.md`](../../docs/self-host.md) for the docker-compose path
and [`docs/deployment.md`](../../docs/deployment.md) for the deployment
topology reference.

## Prerequisites

- Kubernetes 1.25+, `kubectl` configured against it
- Helm 3
- The [agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox)
  controller + `sandboxes.agents.x-k8s.io` CRD installed in the cluster
  (enable `agentSandbox.enabled` below to auto-install them via a Helm hook,
  or install out-of-band)
- A `ReadWriteOnce` volume provisioner (the chart ships a PVC; default
  `storageClass: ""` uses the cluster default)
- Optional: cert-manager + a ClusterIssuer if you enable the Ingress with
  the default `cert-manager.io/cluster-issuer` annotation

## Install

**1. Create the namespace + the Secret out-of-band (recommended for
production)** — never pass real secrets on the Helm command line (it lands
in `helm history`/release storage in plaintext, and in your shell history):

```bash
kubectl create namespace oma
kubectl -n oma create secret generic oma \
  --from-literal=PLATFORM_ROOT_SECRET="$(openssl rand -base64 32)" \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=ANTHROPIC_API_KEY="sk-ant-..."
```

> **Back up `PLATFORM_ROOT_SECRET`.** It is the at-rest encryption root for
> vault credentials, model-card API keys, and integration tokens. Losing it
> makes every encrypted row unreadable. Rotating it has the same effect on
> rows encrypted under the old value — see
> [`docs/platform-root-secret-rotation.md`](../../docs/platform-root-secret-rotation.md).

**2. Install the chart**, pointing at that Secret:

```bash
helm install oma ./charts/oma \
  --namespace oma \
  --set secret.existingSecret=oma \
  --set config.publicBaseUrl=https://app.oma.duyet.net \
  --set ingress.enabled=true \
  --set ingress.host=app.oma.duyet.net \
  --set agentSandbox.enabled=true
```

**Quick local testing (auto-generate the generatable secrets):**

```bash
helm install oma ./charts/oma \
  --namespace oma --create-namespace \
  --set secret.autoGenerate=true \
  --set agentSandbox.enabled=true
# then edit the generated Secret to fill in ANTHROPIC_API_KEY:
kubectl -n oma edit secret oma
```

`PLATFORM_ROOT_SECRET` and `BETTER_AUTH_SECRET` are generated ONCE and
reused on every upgrade (stable via `lookup`) — they never rotate
automatically. `ANTHROPIC_API_KEY` is **never** auto-generated (it is an
external key you must obtain from Anthropic or a gateway).

**3. Wait for rollout and verify:**

```bash
kubectl -n oma rollout status deployment/oma
kubectl -n oma port-forward svc/oma 8787:8787 &
curl localhost:8787/health
# → {"status":"ok","runtime":"node","backends":{"db":"sqlite ..."},...}
```

## Values

| Key | Default | Description |
|---|---|---|
| `images.mainNode.repository` / `.tag` / `.pullPolicy` | `ghcr.io/duyet/oma-main-node` / `latest` / `Always` | main-node container image |
| `images.vault.repository` / `.tag` / `.pullPolicy` | `ghcr.io/duyet/oma-vault` / `latest` / `Always` | oma-vault sidecar image |
| `replicaCount` | `1` | Single replica only (sqlite single-writer + RWO PVC) |
| `podSecurityContext.fsGroup` | `1000` | Image `node` user uid/gid; lets it write the PVC |
| `resources` | `100m/256Mi` requests, `1Gi` limits | main-node container resources |
| `serviceAccount.create` / `.name` | `true` / `""` | ServiceAccount the pod runs as (needs the Role in rbac.yaml) |
| `rbac.create` | `true` | Role + RoleBinding granting sandbox-pod lifecycle verbs |
| `secret.existingSecret` | `""` | Name of a pre-existing Secret (recommended). When set, no Secret is rendered |
| `secret.autoGenerate` | `false` | Opt-in: render a Secret with stable generated `PLATFORM_ROOT_SECRET` / `BETTER_AUTH_SECRET` |
| `secret.anthropicApiKey` | `""` | Plaintext key; never auto-generated. Supply via `--set` or edit the Secret |
| `secret.betterAuthSecret` / `.platformRootSecret` | `""` | Plaintext overrides; empty = generated when `autoGenerate: true` |
| `config.publicBaseUrl` | `http://localhost:8787` | Public URL the Console/API is reachable at |
| `config.databasePath` / `.authDatabasePath` | `/app/data/oma.db` / `/app/data/auth.db` | SQLite db paths (shared PVC) |
| `config.sandboxWorkdir` / `.memoryBlobDir` / `.filesBlobDir` / `.sessionOutputsDir` | `/app/data/{sandboxes,memory-blobs,files-blobs,session-outputs}` | Storage paths |
| `config.vaultProxyUrl` | `""` (computed) | Reach the vault sidecar via the in-cluster Service. Empty = `http://<fullname>.<ns>.svc.cluster.local:<vault.port>` |
| `config.vaultCaCert` | `/app/data/oma-vault-ca/ca.crt` | CA cert the vault writes and main-node trusts |
| `config.anthropicBaseUrl` | `https://api.anthropic.com` | Anthropic endpoint or compatible gateway |
| `config.maxOutputTokens` | `4096` | Cap harness output tokens (lower for budget-limited gateways) |
| `config.apiCompat` | `""` | `""` (Anthropic) \| `oai` (OpenAI /chat/completions) \| `ant` |
| `config.sandboxProvider` | `k8s` | Sandbox executor: `k8s` Sandbox CRD |
| `config.k8s.namespace` | `""` (→ release namespace) | Namespace sandbox pods are created in (must match rbac Role) |
| `config.k8s.image` | `node:22-slim` | Container image for sandbox pods |
| `config.k8s.cpu` / `.memory` | `500m` / `512Mi` | Sandbox pod resource requests |
| `config.k8s.serviceAccount` | `""` (→ main SA) | ServiceAccount sandbox pods run as |
| `vault.databasePath` / `.caDir` / `.port` / `.tenant` | `/app/data/oma.db` / `/app/data/oma-vault-ca` / `14322` / `*` | oma-vault sidecar env |
| `vault.resources` | `50m/128Mi` requests, `512Mi` limits | oma-vault container resources |
| `service.type` / `.port` / `.vaultPort` | `ClusterIP` / `8787` / `14322` | Cluster Service ports |
| `ingress.enabled` / `.className` / `.host` | `false` / `traefik` / `app.oma.duyet.net` | Public Ingress (override host per-deploy) |
| `ingress.annotations` | `{cert-manager.io/cluster-issuer: letsencrypt-prod}` | Ingress annotations |
| `ingress.tls.enabled` / `.secretName` | `true` / `oma-tls` | TLS via cert-manager |
| `persistence.enabled` / `.size` / `.storageClass` | `true` / `10Gi` / `""` | Shared PVC for sqlite + blob stores + vault CA |
| `agentSandbox.enabled` | `false` | Auto-install agent-sandbox controller + CRDs via Helm hook |
| `agentSandbox.version` | `v0.5.4` | agent-sandbox release tag (builds the manifest URL) |
| `agentSandbox.manifestUrl` | `""` | Override the full manifest URL (fork/mirror) |
| `agentSandbox.hook.image.repository` / `.tag` | `registry.k8s.io/kubectl` / `v1.31.0` | Hook Job image |
| `agentSandbox.hook.serverSideApply` | `true` | Pass `--force-conflicts` to `kubectl apply --server-side` |

## RBAC

The chart creates a namespace-scoped `Role` + `RoleBinding`
(`templates/rbac.yaml`) granting the OMA pod's ServiceAccount the verbs it
needs to drive the k8s sandbox provider: `sandboxes` (agents.x-k8s.io CRD
full lifecycle), `pods`/`pods/log` (get/list/watch), and `pods/exec`
(create/get). This mirrors `infra/homelab/oma/rbac.yaml`. Sandboxes are
created in the release namespace by default (`config.k8s.namespace`), so a
namespaced Role is sufficient — if you point sandboxes at a different
namespace, move the Role there or widen to a ClusterRole.

This is the OMA **runtime's** permission to use sandboxes. It is orthogonal
to the agent-sandbox **controller** install (`agentSandbox.enabled`), which
installs the CRD + controller itself — separate concerns, kept in separate
templates.

## Secrets

The Secret resolved by `oma.secretName` carries three keys:

| Key | Purpose | Auto-generated? |
|---|---|---|
| `PLATFORM_ROOT_SECRET` | At-rest encryption root for vault credentials, model-card keys, integration tokens | Yes (stable, when `autoGenerate: true`) |
| `BETTER_AUTH_SECRET` | Signs Console sessions | Yes (stable, when `autoGenerate: true`) |
| `ANTHROPIC_API_KEY` | External Anthropic (or gateway) API key | **No** — supply via `--set` or by editing the Secret |

**Two patterns:**

1. **Bring-your-own (recommended):** create the Secret out-of-band and set
   `secret.existingSecret`. The chart renders no Secret and every secretRef
   resolves to that name.
2. **Auto-generate:** set `secret.autoGenerate: true` (and leave
   `existingSecret` empty). The chart renders a Secret, generating stable
   random values for `PLATFORM_ROOT_SECRET` and `BETTER_AUTH_SECRET` via
   `lookup` so they persist across upgrades. `ANTHROPIC_API_KEY` is emitted
   empty — fill it in after install.

> **Never rotate `PLATFORM_ROOT_SECRET`.** Every encrypted vault row becomes
> unreadable under the old value. Back up the generated value. See
> [`docs/platform-root-secret-rotation.md`](../../docs/platform-root-secret-rotation.md).

## agent-sandbox auto-install

`agentSandbox.enabled: true` installs the
[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) controller
+ CRDs before the chart's own resources, via a Helm `pre-install`/`pre-upgrade`
hook Job that runs `kubectl apply --server-side -f <url>`. The CRDs and
controller are **not** owned by Helm — they survive `helm uninstall`, which
is correct: removing OMA should not tear down the cluster's sandbox
substrate. The apply is idempotent (server-side apply, force-conflicts).

The hook runs as a `cluster-admin` ServiceAccount (needed to apply CRDs +
cluster-scoped resources in one shot). For a hardened cluster, review the
manifest, pin `agentSandbox.manifestUrl` to a reviewed copy, and narrow the
ClusterRoleBinding in `templates/agent-sandbox/hook-rbac.yaml` to just the
resources the manifest touches.

The OMA runtime's own sandbox RBAC (`templates/rbac.yaml`) is separate from
this controller install — they're orthogonal.

## Verify

```bash
helm lint ./charts/oma
helm template oma ./charts/oma --set secret.existingSecret=oma-test
helm template oma ./charts/oma --set secret.autoGenerate=true
helm template oma ./charts/oma --set ingress.enabled=true --set ingress.host=app.oma.duyet.net
helm template oma ./charts/oma --set agentSandbox.enabled=true
```

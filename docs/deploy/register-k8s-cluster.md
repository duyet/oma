# Register a Kubernetes cluster (bridge daemon)

Pair your cluster to an OMA control plane with **`oma-bridge-daemon`** — a
long-lived reverse-WebSocket worker that executes relayed sandbox ops.

**Console:** Runtimes → **Register k8s cluster**  
**Docs site:** [Register a Kubernetes cluster](https://docs.oma.duyet.net/deploy/bridge-daemon/)  
**Chart:** [`charts/oma-bridge-daemon`](../../charts/oma-bridge-daemon)

## Where sandboxes run

| Mode | Meaning |
|---|---|
| **In-pod (default)** | Tools run **inside the daemon pod**. One Deployment; no extra pods per session. Same model as `oma bridge daemon` on a laptop. |
| **OpenShell** | Daemon relays each session to an OpenShell gateway that creates **isolated sandboxes** per turn. |

In-pod is **not** “one pod that nests containers for each session.” It is
subprocess execution in the daemon container (`BRIDGE_SANDBOX_BACKEND=subprocess`
or empty). OpenShell is the multi-sandbox path.

## Install paths

1. **Helm** — pairing Secret + `values.yaml` + `helm upgrade --install`
2. **Manual / env** — ConfigMap (`BRIDGE_SANDBOX_BACKEND`, …) + `deploy/cli-bridge-daemon/`
3. **GitOps** — out-of-band Secret; Argo CD `Application` or Flux `HelmRelease` with chart values only

Generate a multi-use pairing token in the Console (or
`POST /v1/runtimes/pairing-token`). Never commit `OMA_PAIRING_CODE` /
`OMA_PAIRING_STATE`.

### Quick Helm (in-pod)

```bash
# Secret (token from Console)
kubectl create namespace oma --dry-run=client -o yaml | kubectl apply -f -
kubectl -n oma create secret generic oma-bridge-daemon-pairing \
  --from-literal=OMA_PAIRING_CODE='pair_…' \
  --from-literal=OMA_PAIRING_STATE='st_…'

# values.yaml: pairing.existingSecret, pairing.serverUrl, bridge.backend: ""
helm dependency build ./charts/oma-bridge-daemon
helm upgrade --install oma-bridge-daemon ./charts/oma-bridge-daemon \
  --namespace oma -f values.yaml
```

### Quick Helm (OpenShell)

```bash
helm upgrade --install oma-bridge-daemon ./charts/oma-bridge-daemon \
  --namespace oma \
  --set secret.existingSecret= \
  --set pairing.existingSecret=oma-bridge-daemon-pairing \
  --set openshell.enabled=true
```

## Related

- [Kubernetes sandbox backends](./k8s-sandbox-backends.md) — `k8s-remote` vs OpenShell vs daemon
- [k8s-bridge](./k8s-bridge.md) — older HTTP pod bridge (`oma-k8s-bridge`), different chart
- [Runtimes concepts](../runtimes.md)

# oma bridge daemon — in-cluster deployment

Run `oma bridge daemon` inside Kubernetes as a reverse-WebSocket runtime that
executes relayed cloud-agent sandbox ops. Two backends:

- **local** (default) — subprocess + host filesystem, inside the pod. Works
  with the published `@getoma/cli` on a plain `node:22-slim` image.
- **openshell** — relay each op to an NVIDIA OpenShell gateway over gRPC. Needs
  an image with `@getoma/sandbox-sdk` present (see `Dockerfile.openshell`).

The daemon only makes **outbound** connections (WS to the control plane, gRPC
to the gateway) — it never touches the Kubernetes API, so it needs **no RBAC**.

## Files

| File | Purpose |
|---|---|
| `deployment.yaml` | The daemon Deployment (1 replica = 1 machine) |
| `configmap.yaml` | Backend selection env (`BRIDGE_SANDBOX_BACKEND`, `OPENSHELL_GATEWAY_ENDPOINT`, …) |
| `secret.example.yaml` | Shape of the `credentials.json` Secret — create it out-of-band |
| `Dockerfile.openshell` | Monorepo image build for the OpenShell backend |

## Quickstart

```bash
# 1. Pair a runtime with the control plane (once, on any machine):
oma bridge setup --server-url https://<your-instance> --no-service

# 2. Ship the creds into the cluster:
kubectl create secret generic oma-bridge-daemon-creds \
  --from-file=credentials.json="$HOME/.oma/bridge/credentials.json"

# 3. (optional) OpenShell backend:
kubectl apply -f configmap.yaml   # then edit: BRIDGE_SANDBOX_BACKEND=openshell, OPENSHELL_GATEWAY_ENDPOINT=...

# 4. Deploy:
kubectl apply -f deployment.yaml
```

See [`docs/deploy/k8s-sandbox-backends.md`](../../docs/deploy/k8s-sandbox-backends.md)
for the full `k8s-remote` vs `openshell` comparison.

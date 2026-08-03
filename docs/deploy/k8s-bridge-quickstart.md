# k8s-bridge Quickstart

10 minutes to a running k8s-bridge, assuming you already have a
Kubernetes cluster. For the full reference (Helm values, endpoints,
security, troubleshooting), see [`k8s-bridge.md`](./k8s-bridge.md).

## Prerequisites

- Kubernetes 1.25+ cluster, `kubectl` configured against it
- Helm 3
- An OMA deployment (Cloudflare Workers or self-host Node) with API access
  (`x-api-key`)

## 1. Generate a token

```bash
export K8S_BRIDGE_TOKEN=$(openssl rand -base64 32)
```

This becomes the bearer token the bridge requires on every request
(`apps/k8s-bridge/src/index.ts` gates `/api/v1/boxes*`, `/api/v1/cluster*`,
`/api/v1/sandboxes*`, and `/api/v1/health` behind it).

## 2. Install via Helm

From the repo root (the chart isn't published to a repo yet — install
straight from `charts/oma-k8s-bridge`):

```bash
helm install oma-k8s-bridge ./charts/oma-k8s-bridge \
  --namespace oma-sandbox \
  --create-namespace \
  --set secret.token=$K8S_BRIDGE_TOKEN \
  --set ingress.enabled=true \
  --set ingress.host=k8s-bridge.example.com
```

Key values (see `charts/oma-k8s-bridge/values.yaml` for the full set):

| Value | Default | Notes |
|---|---|---|
| `secret.token` | `""` | Required — the bearer token from step 1 |
| `config.namespace` | `sandboxes` | Namespace the bridge provisions sandbox pods into |
| `service.port` | `8100` | Bridge HTTP port |
| `ingress.enabled` | `false` | Set `true` to expose the bridge outside the cluster |
| `ingress.host` | `oma-k8s-bridge.oma.local` | Hostname OMA will call |
| `ingress.className` | `nginx` | Your ingress controller's class |
| `ingress.tls.enabled` | `false` | Set `true` if your ingress controller terminates TLS |
| `replicaCount` | `2` | Bridge replicas |

Wait for the rollout:

```bash
kubectl -n oma-sandbox rollout status deployment/oma-k8s-bridge
```

## 3. Register the provider with OMA

Call the bridge directly to confirm it's up first:

```bash
curl -s -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/health
# → {"status":"ok","k8sVersion":"v1.30.2","nodeCount":3,"activeBoxes":0,"latencyMs":42}
```

Then register it as a sandbox provider on your OMA deployment
(`POST /v1/sandbox_providers`, handled in
`apps/main/src/routes/sandbox-providers.ts`):

```bash
BASE=https://your-oma-deployment.example.com
KEY=your-oma-api-key

curl -s -X POST $BASE/v1/sandbox_providers \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{
    "name": "k8s-bridge-prod",
    "type": "k8s-bridge",
    "config": {
      "base_url": "https://k8s-bridge.example.com",
      "token": "'"$K8S_BRIDGE_TOKEN"'"
    }
  }'
# → {"id":"byok_xxx","name":"k8s-bridge-prod","type":"byok","provider":"k8s-bridge",...}
```

Save the returned `id` (`byok_xxx`) — set it as an environment's
`config.sandbox_provider` to route that environment's sessions through the
bridge.

Alternatively, on the Cloudflare deployment, set `K8S_BRIDGE_URL` and
`K8S_BRIDGE_TOKEN` as Worker secrets (`wrangler secret put`) before first
boot to auto-seed `k8s-bridge` as a **system** provider — no registration
call needed, but every environment shares the same cluster and token. See
`seedSystemProviders` in `packages/sandbox-sdk/src/provider-config.ts`.

## 4. End-to-end verification

Create an environment pointed at the provider you just registered, then run
a session against it and confirm a pod actually gets scheduled:

```bash
ENV=$(curl -s -X POST $BASE/v1/environments \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"name":"k8s-bridge-env","config":{"sandbox_provider":"byok_xxx"}}' \
  | jq -r .id)

AGENT=$(curl -s -X POST $BASE/v1/agents \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"name":"K8s Bridge Test","model":"claude-sonnet-4-6","system":"You are a test agent.","tools":[{"type":"agent_toolset_20260401"}]}' \
  | jq -r .id)

# environment_id selects the sandbox for this session (agents are stateless
# configs — the environment binding happens at session-create time)
SESSION=$(curl -s -X POST $BASE/v1/sessions \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d "{\"agent\":\"$AGENT\",\"environment_id\":\"$ENV\"}" | jq -r .id)

curl -N -X POST $BASE/v1/sessions/$SESSION/messages \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"content":"Run `hostname` and tell me the output."}'
```

If the bridge is wired up correctly, the agent's tool call reaches a pod in
your cluster and returns the pod's hostname. Confirm the pod directly:

```bash
kubectl -n sandboxes get pods
```

## Troubleshooting

For pod-scheduling errors, RBAC issues, token rotation, and the full
Helm values reference, see the
[full k8s-bridge guide](./k8s-bridge.md#troubleshooting) and its
[Helm Configuration](./k8s-bridge.md#helm-configuration) section.

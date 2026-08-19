# Quickstart: Your First Agent in 5 Minutes

Get OMA running on your machine (or in the cloud) and send your first agent message — pick your path below.

## Pick Your Path

| Path | Best for | Time |
|------|----------|------|
| 🐳 **Docker** (recommended) | Trying OMA locally | ~5 min |
| ☁️ **Cloudflare** | Production deployment | ~10 min |
| 🚢 **Kubernetes** | Scale-out deployment | ~15 min |

---

## 🐳 Docker (Recommended for Trying)

### 1. Prerequisites

- [Docker](https://docs.docker.com/get-docker/) (with Compose)
- [curl](https://curl.se) (or any HTTP client)
- [jq](https://jqlang.github.io/jq/) (for parsing JSON responses)

### 2. Clone & Configure

```bash
git clone https://github.com/duyet/oma.git
cd oma
cp .env.example .env
```

Generate secrets and add them to `.env`:

```bash
echo "BETTER_AUTH_SECRET=$(openssl rand -hex 32)" >> .env
echo "PLATFORM_ROOT_SECRET=$(openssl rand -base64 32)" >> .env
```

`.env.example` already sets `API_KEY=dev-test-key-change-me` (same as `.dev.vars.example`). A provider key is required for a successful turn — set `ANTHROPIC_API_KEY` in `.env` or add a Model Card in the Console.

**Important**: Back up `PLATFORM_ROOT_SECRET` — losing it makes all encrypted data unreadable.

### 3. Launch

```bash
docker compose up -d
```

Verify it's running:

```bash
curl localhost:8787/health
```

Expected response (pid, uptime, and backend paths vary):

```json
{
  "status": "ok",
  "runtime": "node",
  "pid": 1,
  "uptime_s": 12,
  "auth": "better-auth-sqlite",
  "backends": {
    "agents": "sqlite",
    "events": "sqlite",
    "hub": "in-process",
    "memory_blobs": "localfs /app/data/memory-blobs",
    "db": "sqlite /app/data/oma.db"
  }
}
```

### 4. Create Your First Agent

Open [http://localhost:8787](http://localhost:8787) in your browser, sign up, and use the Console:

- **Launch wizard** at `/launch` — ordered path: model access → environment (sandbox) → vault → agent → session. Same control plane on Docker/self-host **k3s** and **Cloudflare Workers**; only the sandbox provider differs.
- **Overview** Getting Started checklist uses the same order (environment and vault before the first session).
- Or create ad-hoc via **New Agent** / API (below).

CLI:

```bash
export OMA_BASE="http://localhost:8787"
export OMA_KEY="$(grep '^API_KEY=' .env | cut -d= -f2-)"
# .env.example / .dev.vars.example ship API_KEY=dev-test-key-change-me

AGENT_ID=$(curl -s -X POST "$OMA_BASE/v1/agents" \
  -H "x-api-key: $OMA_KEY" \
  -H "content-type: application/json" \
  -d '{
    "name": "hello-agent",
    "model": "claude-sonnet-4-6",
    "system": "You are a helpful assistant. Keep replies short.",
    "tools": [{"type": "agent_toolset_20260401", "default_config": {"enabled": true}}]
  }' | jq -r .id)

ENV_ID=$(curl -s -X POST "$OMA_BASE/v1/environments" \
  -H "x-api-key: $OMA_KEY" \
  -H "content-type: application/json" \
  -d '{"name":"local","config":{"type":"cloud"}}' | jq -r .id)

echo "Agent: $AGENT_ID"
echo "Environment: $ENV_ID"
```

### 5. Send a Message

```bash
SESSION_ID=$(curl -s -X POST "$OMA_BASE/v1/sessions" \
  -H "x-api-key: $OMA_KEY" \
  -H "content-type: application/json" \
  -d "{\"agent\": \"$AGENT_ID\", \"environment_id\": \"$ENV_ID\"}" | jq -r .id)

curl -N -X POST "$OMA_BASE/v1/sessions/$SESSION_ID/messages" \
  -H "x-api-key: $OMA_KEY" \
  -H "content-type: application/json" \
  -d '{"content": "Say hello and tell me what tools you have available."}'
```

You'll see the agent's reply stream in real-time. A real model key is required for a successful turn — set `ANTHROPIC_API_KEY` in `.env` (or add a Model Card in the Console) and restart if the session stays silent.

### Next Steps with Docker

- [Docker deploy guide](deploy/docker.md) — Postgres, custom config, production tuning
- [Self-host overview](self-host.md)

---

## ☁️ Cloudflare (Production)

### 1. Prerequisites

- [Node.js](https://nodejs.org) 22+
- [pnpm](https://pnpm.io/installation) 10+ (`npm i -g pnpm`)
- A [Cloudflare](https://cloudflare.com) account on **Workers Paid** plan ($5/mo)
- `wrangler` logged in (`npx wrangler login`)
- An [Anthropic API key](https://console.anthropic.com) (or OpenAI compatible)

### 2. Deploy

```bash
git clone https://github.com/duyet/oma.git
cd oma
pnpm install
npx wrangler login
./scripts/setup-cf.sh
```

The wizard will:
1. Create D1 databases, KV namespace, and R2 buckets
2. Set secrets and deploy 3 workers (main + agent + integrations)
3. Print your Console URL

### 3. Open Console

Open the URL printed by the wizard (e.g. `https://oma-main.xxx.workers.dev`). Sign up — your first user becomes the tenant owner. Create an agent and start a session.

### Next Steps with Cloudflare

- [Cloudflare deploy guide](deploy/cloudflare.md) — custom domains, OAuth apps, monitoring

---

## 🚢 Kubernetes (Scale)

### 1. Prerequisites

- Kubernetes cluster v1.25+
- [Helm 3](https://helm.sh)
- `kubectl` configured with cluster access
- cert-manager installed (for TLS)
- OMA deployed via Cloudflare or self-hosted Node

### 2. Install k8s-bridge

```bash
helm repo add oma https://charts.oma.duyet.net
helm repo update

export K8S_BRIDGE_TOKEN=$(openssl rand -base64 32)

helm install oma-k8s-bridge oma/oma-k8s-bridge \
  --namespace oma-sandbox \
  --create-namespace \
  --set secret.token=$K8S_BRIDGE_TOKEN \
  --set ingress.enabled=true \
  --set ingress.host=k8s-bridge.example.com
```

### 3. Verify

```bash
kubectl -n oma-sandbox rollout status deployment/oma-k8s-bridge

curl -H "Authorization: Bearer $K8S_BRIDGE_TOKEN" \
  https://k8s-bridge.example.com/api/v1/health
```

### Next Steps with Kubernetes

- [Kubernetes deploy guide](deploy/kubernetes.md) — scaling, monitoring, advanced config

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| `docker compose up` fails | Port 8787 in use | Stop the conflicting process or change port in `docker-compose.yml` |
| `health` returns 503 | Migrations not finished | Wait 10s and retry, check `docker compose logs oma` |
| Agent creation fails with 401 | `OMA_KEY` does not match `API_KEY` in `.env` | Use `export OMA_KEY="$(grep '^API_KEY=' .env | cut -d= -f2-)"` (`.env.example` ships `dev-test-key-change-me`) |
| Session create returns 400 `environment_id is required` | No environment on the request | Create one with `POST /v1/environments` and pass `environment_id` (CLI: `--env`) |
| Session returns no reply | No model card configured | Add a Model Card in Console or set `ANTHROPIC_API_KEY` in `.env` |
| `setup-cf.sh` fails on secret | Wrangler not logged in | Run `npx wrangler login` first |

## What's Next

- **Deploy guides**: [Docker](deploy/docker.md) · [Cloudflare](deploy/cloudflare.md) · [Kubernetes](deploy/kubernetes.md)
- **Build with the API**: [API reference](https://docs.oma.duyet.net/build/api/) · [CLI/SDK](https://docs.oma.duyet.net/build/cli-sdk/)
- **Add integrations**: Slack · GitHub · Linear
- **Custom harness**: Replace the default agent loop with your own logic

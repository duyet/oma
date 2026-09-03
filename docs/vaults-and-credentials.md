# Vaults & outbound credentials

**Tools never see your tokens.** When a sandbox makes an HTTP request, an outbound resolver — `oma-vault` sidecar on self-host (mockttp HTTPS proxy with a trusted self-signed CA), the agent worker's `outboundByHost` interceptor on Cloudflare — matches the request hostname against the session's vaults, **strips any inbound `Authorization`/`x-api-key`/`x-goog-api-key`**, injects the real credential, and forwards. A prompt-injected agent has nothing to leak; `env | grep TOKEN` returns nothing inside the sandbox.

```bash
# Create a vault and add a static bearer bound to api.github.com
VID=$(curl -sX POST $BASE/v1/vaults -H "x-api-key: $KEY" \
  -d '{"name":"github-prod"}' | jq -r .id)

curl -sX POST $BASE/v1/vaults/$VID/credentials -H "x-api-key: $KEY" -d '{
  "display_name": "gh-pat",
  "auth": {
    "type": "static_bearer",
    "token": "ghp_xxx",
    "mcp_server_url": "https://api.github.com"
  }
}'

# Bind on session create
curl -sX POST $BASE/v1/sessions -H "x-api-key: $KEY" \
  -d "{\"agent\":\"$AGENT\",\"vault_ids\":[\"$VID\"]}"

# Inside the sandbox: curl https://api.github.com/user → 200, Authorization injected at the network layer
```

**Session injection.** An operator can bind an existing vault credential to a
newly discovered host on a *running* session (`POST /v1/sessions/:id/injections`
`{ type: "credential_inject", host, credential_id }`) without restarting or
mutating the agent. The outbound resolver re-reads the session overlay on
every call, so the bind takes effect immediately. Overlay, events, GET bodies,
and the Console Inject tab carry `credential_id` + host only — the token never
enters the sandbox and is never logged. The credential must already belong to
one of the session's `vault_ids`.

Three credential types share one resolver:

| Type | Match by | Refresh |
|---|---|---|
| `static_bearer` | request host matches `mcp_server_url` | never |
| `mcp_oauth` | request host matches `mcp_server_url` | on 401 / 403 via `token_endpoint`, CAS-writes new token to D1 |
| `cap_cli` | sandbox CLI invocations match `cli_id` in the cap registry (`gh`, `glab`, `aws`, …) | per-CLI |

Max 20 credentials per vault. Each forward emits a structured `op:"mcp_proxy.forward"` log. Full design: [`mcp-credential-architecture.md`](mcp-credential-architecture.md), [docs.oma.duyet.net/build/vault-and-mcp](https://docs.oma.duyet.net/build/vault-and-mcp/).

**Self-host `oma-vault` tenant scope.** The sidecar matches by hostname under `OMA_TENANT`. Unset / empty / `*` is wildcard and **refuses to start** when `credentials` has more than one distinct `tenant_id` (single-operator still boots). Set `OMA_TENANT=tn_xxx` (compose `.env`) or `vault.tenant` (Helm) for multi-user. Compose and the chart do not default to `*`.

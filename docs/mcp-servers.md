# MCP servers

OMA registers any [Model Context Protocol](https://modelcontextprotocol.io) server attached to an agent. Each upstream tool surfaces to the model as `mcp__<server>__<tool>` (double underscore — copy the name exactly). Up to 20 servers per agent.

| Transport | When to use | How |
|---|---|---|
| HTTP / SSE | Hosted MCP servers (Linear, GitHub Copilot, Notion, …) | `{"type":"url","url":"https://mcp.linear.app/mcp"}` |
| stdio | npm / PyPI MCP packages with no hosted endpoint | `{"type":"stdio","command":"uvx","args":[...],"port":8765}` — OMA spawns inside the sandbox container, talks to `127.0.0.1:port/sse` |

Credentials never enter the sandbox; the outbound resolver matches by host and injects at forward time.

| Auth mode | Configured as | Refresh |
|---|---|---|
| none | no `authorization_token`, no matching vault credential | n/a |
| inline bearer | `"authorization_token": "..."` on the server entry | no |
| vault static bearer | session vault has a `static_bearer` credential whose `mcp_server_url` matches | no |
| vault OAuth | session vault has an `mcp_oauth` credential (with `refresh_token` + `token_endpoint`) | yes — on 401 **and 403** (Airtable/Asana/Sentry use 403 for expired tokens), CAS-writes new token to D1, retries once |

```bash
# Servers attach to the agent (not the session)
curl -X PUT $BASE/v1/agents/$AGENT -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d '{"mcp_servers":[{"name":"linear","type":"url","url":"https://mcp.linear.app/mcp"}]}'

# Bind an OAuth credential via Vault
oma connect linear --vault $VAULT_ID
```

Tool discovery is bounded at 15 s per server; one bad server logs and skips, the rest stay live. Full design: [docs.oma.duyet.net/build/vault-and-mcp](https://docs.oma.duyet.net/build/vault-and-mcp/).

**Tenant-level registry.** Register a server once (`POST /v1/mcp_servers`,
optionally pinning a vault `credential_id`) and reference it from any agent by
`registry_id` instead of repeating the inline `url`. An inline `url` always
wins; `GET /v1/mcp-proxy/_health/:sid` reports per-server credential
resolution for the sandbox status page.

See also: [MCP & Vault Credential Architecture](mcp-credential-architecture.md)
for how credential resolution and the outbound proxy work under the hood.

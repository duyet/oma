# API Reference

Compatible with the [Claude Managed Agents API](https://docs.anthropic.com/en/docs/agents/managed-agents). Same endpoints, same event types, works with existing SDKs.

## Agents — Create and manage agent configurations

```http
POST   /v1/agents                          # Create agent
GET    /v1/agents                          # List agents
GET    /v1/agents/:id                      # Get agent
PUT    /v1/agents/:id                      # Update agent
DELETE /v1/agents/:id                      # Delete agent
POST   /v1/agents/:id/archive             # Archive agent
GET    /v1/agents/:id/versions            # Version history
GET    /v1/agents/:id/versions/:version   # Get specific version
GET    /v1/agents/:id/daily-summary       # Scheduled-run daily summary (`?days=1|7|30`, default 7)
```

## Environments — Sandbox execution environments

```http
POST   /v1/environments                   # Create environment
GET    /v1/environments                   # List environments
GET    /v1/environments/:id               # Get environment
PUT    /v1/environments/:id               # Update environment
DELETE /v1/environments/:id               # Delete environment
```

## Sessions — Run agent conversations

```http
POST   /v1/sessions                        # Create session
GET    /v1/sessions                        # List sessions
GET    /v1/sessions/:id                    # Get session
POST   /v1/sessions/:id                    # Update session
DELETE /v1/sessions/:id                    # Delete session
POST   /v1/sessions/:id/archive           # Archive session

POST   /v1/sessions/:id/events            # Send events (user messages)
GET    /v1/sessions/:id/events             # Get events (JSON or SSE)
GET    /v1/sessions/:id/events/stream      # SSE stream

POST   /v1/sessions/:id/resources          # Attach resource
GET    /v1/sessions/:id/resources          # List resources
DELETE /v1/sessions/:id/resources/:resId   # Remove resource

POST   /v1/sessions/:id/pause              # Snapshot workspace and destroy the sandbox
POST   /v1/sessions/:id/resume             # Reprovision sandbox and restore workspace

GET    /v1/sessions/:id/injections         # Session-scoped operator injection overlay
POST   /v1/sessions/:id/injections         # Append prompt / mount MCP / toggle tools / bind credential
PATCH  /v1/sessions/:id/tools              # Alias for POST /injections { type: "tools_update" }
```

## Vaults — Secure credential storage

```http
POST   /v1/vaults                          # Create vault
POST   /v1/vaults/:id/credentials          # Add credential
GET    /v1/vaults/:id/credentials          # List (secrets stripped)
```

## Memory Stores — persistent storage; Claude Managed Agents Memory contract

When attached to a session, each store is mounted into the sandbox at
`/mnt/memory/<store_name>/`. The agent reads and writes it with the
**standard file tools** (bash/read/write/edit/glob/grep) — there are no
bespoke `memory_*` tools.

R2 holds the bytes-of-truth (key `<store_id>/<memory_path>`); D1 holds the
index + audit, kept eventually consistent via R2 Event Notifications →
Cloudflare Queue → Consumer.

```http
POST   /v1/memory_stores                                        # Create store
GET    /v1/memory_stores                                        # List stores
GET    /v1/memory_stores/:id                                    # Retrieve store
POST   /v1/memory_stores/:id/archive                            # Archive (one-way)
DELETE /v1/memory_stores/:id                                    # Delete store + memories + versions

POST   /v1/memory_stores/:id/memories                           # Create/upsert memory {path, content, precondition?}
GET    /v1/memory_stores/:id/memories?path_prefix=&depth=N      # List memories (metadata)
GET    /v1/memory_stores/:id/memories/:mid                      # Retrieve memory (with content)
POST   /v1/memory_stores/:id/memories/:mid                      # Update memory {path?, content?, precondition?}
DELETE /v1/memory_stores/:id/memories/:mid                      # Delete memory

GET    /v1/memory_stores/:id/memory_versions?memory_id=         # Audit history (newest first)
GET    /v1/memory_stores/:id/memory_versions/:ver_id            # Single version (with snapshot content)
POST   /v1/memory_stores/:id/memory_versions/:ver_id/redact     # Redact prior version (refuses live head)
```

CAS via `precondition: { type: "content_sha256", content_sha256 }`. 100KB
cap per memory. 30-day version retention with the most-recent version per
memory always preserved. Rollback = retrieve a version and write its
content as a new memory revision (no special endpoint).

CLI:
```bash
oma memory stores create "User Preferences"
oma memory write <store-id> /preferences/formatting.md --content "Always use tabs."
oma memory ls <store-id> --prefix /preferences/
oma memory versions <store-id> --memory-id <mem-id>
```

## Files & Skills

```http
POST   /v1/files                           # Upload file
GET    /v1/files/:id/content               # Download file
POST   /v1/skills                          # Create skill
GET    /v1/skills                          # List skills
```

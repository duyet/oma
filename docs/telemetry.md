# Telemetry

OMA collects **anonymous, opt-out** usage telemetry to guide development. A
self-hosted install phones home every 6 hours with aggregate counts only —
the public numbers are visible at **[oma.duyet.net/stats](https://oma.duyet.net/stats/)**.

**What is collected (and nothing else):**

- A random instance UUID generated + persisted locally on first run (no
  hostname, username, IP, or any PII).
- The OMA version and deployment kind (`cloudflare` / `node-docker` / `k8s`).
- Aggregate counts: total/active agents, total/running sessions, total &
  average session duration, sandbox launches grouped by provider kind, and
  the set of model **ids** in use (names only).

**What is never collected:** prompts, messages, tool inputs/outputs, file
contents or paths, agent/tenant names, credentials, or any user data.

**Opt out** at any time — honored everywhere (self-host Node, Cloudflare, and
the CLI):

```bash
export OMA_TELEMETRY_DISABLED=1        # or OMA_TELEMETRY=0, or DO_NOT_TRACK=1
```

The ingest endpoint is `POST /v1/telemetry/ingest` (public, unauthenticated,
rate-limited, zod-validated); the schema and aggregation live in
`packages/http-routes/src/telemetry/`. Point `OMA_TELEMETRY_ENDPOINT` at your
own instance to keep the data entirely private to your deployment.

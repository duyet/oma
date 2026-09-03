# Schedule an agent

Fire sessions on a cron cadence with no human turn — digests, polling, recurring
maintenance:

```bash
curl -s $BASE/v1/agents/$AGENT/schedules -H "x-api-key: $KEY" \
  -d '{"cron_expression":"0 9 * * 1","timezone":"America/New_York",
       "environment_id":"env_xxx","input":"Post the weekly digest."}'
```

`next_run_at` advances via an atomic compare-and-set on each per-minute tick
(no double-fire); `POST .../schedules/:id/run` fires immediately. Fires on
**both** the Cloudflare and self-host Node runtimes.

`PATCH .../schedules/:id` updates any subset of `cron_expression` / `input` /
`environment_id` / `timezone` / `max_sessions` / `enabled` / `notify` — not
just `enabled`. Patching `cron_expression` or `timezone` recomputes
`next_run_at` atomically in the same request.

A schedule can also raise its own alerts, independent of the agent's
`notify`, by setting a `notify` object (`{ on, targets }` — same
`NotificationTarget` shapes as agent-level `notify`) on the schedule. `on`
filters which firing outcomes alert (`ok` | `error` | `skipped_concurrency`,
default `["error", "skipped_concurrency"]`). Every firing also appends an
immutable row to `agent_schedule_runs`, readable via
`GET .../schedules/:id/runs` (cursor-paginated run history). The Console
agent hub shows last/next run, success rate, and uptime on the agent
header health strip, and a **Monitor** tab (`/agents/:id/monitor`) for
the live session plus `agent.status` heartbeats.

Full reference in [`AGENTS.md` § Agent Schedules](../AGENTS.md#agent-schedules),
including the `notify`/`on` filter semantics and the run-history schema.

See also [`AGENTS.md` § Deployments](../AGENTS.md#deployments) for the
richer, reusable bundle (agent + environment + vaults + memory + trigger)
that also supports schedule/webhook/manual triggers.

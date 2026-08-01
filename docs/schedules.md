# Schedule an agent

Fire sessions on a cron cadence with no human turn — digests, polling, recurring
maintenance:

```bash
curl -s $BASE/v1/agents/$AGENT/schedules -H "x-api-key: $KEY" \
  -d '{"cron_expression":"0 9 * * 1","timezone":"America/New_York",
       "environment_id":"env_xxx","input":"Post the weekly digest."}'
```

`next_run_at` advances via an atomic compare-and-set on each per-minute tick
(no double-fire); `POST .../schedules/:id/run` fires immediately. Cloudflare
deployment only for now. Full reference in [`AGENTS.md` § Agent Schedules](../AGENTS.md#agent-schedules).

See also [`AGENTS.md` § Deployments](../AGENTS.md#deployments) for the
richer, reusable bundle (agent + environment + vaults + memory + trigger)
that also supports schedule/webhook/manual triggers.

-- 0035_agent_schedule_runs.sql — durable run history for agent schedules
-- (issue #312, WP3).
--
-- agent_schedules only ever tracks the LATEST firing (last_run_at /
-- last_run_status / last_run_error / last_session_id) — no history. This
-- table gives every firing (ok / error / skipped_concurrency) its own
-- durable row so a schedule's run history can be paged, independent of the
-- single-row last_run_* summary. `summary` is a nullable slot for a
-- follow-up (see AGENTS.md).

CREATE TABLE IF NOT EXISTS agent_schedule_runs (
	id TEXT PRIMARY KEY NOT NULL,
	schedule_id TEXT NOT NULL,
	tenant_id TEXT NOT NULL,
	agent_id TEXT NOT NULL,
	session_id TEXT,
	status TEXT NOT NULL,
	error TEXT,
	summary TEXT,
	started_at TEXT NOT NULL,
	created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_schedule_runs_page ON agent_schedule_runs(schedule_id, created_at DESC, id DESC);

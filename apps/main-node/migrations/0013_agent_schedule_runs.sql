-- 0013_agent_schedule_runs.sql — durable run history for agent schedules
-- (issue #312, WP3).
--
-- Ports apps/main/migrations/0035_agent_schedule_runs.sql into the
-- self-host Node control-plane DB. agent_schedules only tracks the LATEST
-- firing (last_run_*); this table gives every firing (ok / error /
-- skipped_concurrency) its own durable row so run history can be paged.
-- `summary` is a nullable slot for a follow-up (see AGENTS.md).
CREATE TABLE IF NOT EXISTS "agent_schedule_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"schedule_id" text NOT NULL,
	"tenant_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"session_id" text,
	"status" text NOT NULL,
	"error" text,
	"summary" text,
	"started_at" text NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_agent_schedule_runs_page" ON "agent_schedule_runs" USING btree ("schedule_id","created_at" DESC,"id" DESC);

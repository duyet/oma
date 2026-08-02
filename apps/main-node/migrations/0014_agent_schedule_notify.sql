-- 0014_agent_schedule_notify.sql — per-schedule alert targets (issue #313,
-- WP2).
--
-- Ports apps/main/migrations/0036_agent_schedule_notify.sql into the
-- self-host Node control-plane DB. JSON text:
--   { "on": ["error", "skipped_concurrency"], "targets": [ ...NotificationTarget ] }
-- Absent `on` defaults to ["error", "skipped_concurrency"]; NULL = no
-- per-schedule alerts.
ALTER TABLE "agent_schedules" ADD COLUMN "notify" text;

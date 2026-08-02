-- 0036_agent_schedule_notify.sql — per-schedule alert targets (issue #313,
-- WP2).
--
-- Agent-level `notify` fans out session-status updates for every session an
-- agent runs. A schedule needs its own, narrower channel: "tell me when THIS
-- cron job fails / gets skipped", without subscribing to every interactive
-- session. `notify` stores that config as JSON text:
--   { "on": ["error", "skipped_concurrency"], "targets": [ ...NotificationTarget ] }
-- Absent `on` defaults to ["error", "skipped_concurrency"]; NULL column =
-- no per-schedule alerts (the pre-existing behaviour).

ALTER TABLE agent_schedules ADD COLUMN notify TEXT;

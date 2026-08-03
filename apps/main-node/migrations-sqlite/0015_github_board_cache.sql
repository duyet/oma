-- 0015_github_board_cache.sql — Console GitHub Kanban board read-through
-- cache (repo picker + assignee combobox).
--
-- Ports apps/main/migrations-integrations/0002_github_board_cache.sql into
-- the self-host Node DB (sqlite dialect). One generic row per
-- (installation_id, cache_key): "repos" for the installation's repo list,
-- "assignees:<owner>/<repo>" for a repo's assignable users. payload_json is
-- the exact `data` array served back; never holds tokens.
CREATE TABLE `github_board_cache` (
	`installation_id` text NOT NULL,
	`cache_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`installation_id`, `cache_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_github_board_cache_installation` ON `github_board_cache` (`installation_id`);

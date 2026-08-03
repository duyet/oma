CREATE TABLE `github_board_cache` (
	`installation_id` text NOT NULL,
	`cache_key` text NOT NULL,
	`payload_json` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`installation_id`, `cache_key`)
);
--> statement-breakpoint
CREATE INDEX `idx_github_board_cache_installation` ON `github_board_cache` (`installation_id`);
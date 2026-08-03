-- 0015_github_board_cache.sql — Console GitHub Kanban board read-through
-- cache (repo picker + assignee combobox). Postgres dialect twin of
-- migrations-sqlite/0015_github_board_cache.sql.
CREATE TABLE "github_board_cache" (
	"installation_id" text NOT NULL,
	"cache_key" text NOT NULL,
	"payload_json" text NOT NULL,
	"fetched_at" bigint NOT NULL,
	CONSTRAINT "github_board_cache_installation_id_cache_key_pk" PRIMARY KEY("installation_id","cache_key")
);
--> statement-breakpoint
CREATE INDEX "idx_github_board_cache_installation" ON "github_board_cache" USING btree ("installation_id");

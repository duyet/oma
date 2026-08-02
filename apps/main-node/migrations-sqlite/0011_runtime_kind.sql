-- 0011_runtime_kind.sql — mirrors CF hand-written migration
-- apps/main/migrations/0033_runtime_kind.sql. Distinguishes local-daemon
-- runtimes from browser-vm tabs on the shared `runtimes` schema.
ALTER TABLE `runtimes` ADD `kind` text DEFAULT 'daemon' NOT NULL;

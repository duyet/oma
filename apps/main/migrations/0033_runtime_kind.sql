-- 0033_runtime_kind.sql — distinguish local-daemon runtimes from browser-vm tabs.
--
-- A `runtimes` row is registered by either an `oma bridge daemon` (a paired
-- local machine) or a browser tab hosting a WASM VM ("browser-vm" sandbox
-- provider). Both attach to the same RuntimeRoom relay, so the sandbox
-- executor must be able to pick the RIGHT kind of runtime for a session:
-- a browser-vm environment must never relay to a daemon, and vice versa.
-- Existing rows are all daemons, hence the DEFAULT.

ALTER TABLE "runtimes" ADD COLUMN kind TEXT NOT NULL DEFAULT 'daemon';

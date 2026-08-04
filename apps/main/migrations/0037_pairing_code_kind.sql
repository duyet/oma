-- 0037_pairing_code_kind.sql — discriminator + multi-use flag on
-- connect_runtime_codes, so a long-lived "pairing" code can be redeemed
-- repeatedly by in-cluster `oma bridge daemon` pods without the browser
-- OAuth loop.
--
-- Until now every connect_runtime_code was a 5-minute, single-use browser
-- handshake token (`used_at` flips on first /exchange). k8s registration
-- can't use that: pods restart, emptyDirs vanish, and requiring a human
-- to re-open the browser flow on every pod bounce defeats the point of
-- non-interactive registration. The new `kind='k8s_pairing'` row skips
-- the `used_at` single-use gate and is honored for the full TTL (default
-- 24h, hard cap 7d). The existing `kind='browser_oauth'` (the DEFAULT)
-- keeps the single-use semantics — unchanged behavior for existing rows.
--
-- `max_uses` is reserved (NULL = unlimited within TTL). The current
-- implementation doesn't enforce a use cap — a pairing code is valid for
-- any redemption inside its TTL — but the column is added now so a later
-- migration isn't needed if we decide to cap redemption count.

ALTER TABLE "connect_runtime_codes" ADD COLUMN kind TEXT NOT NULL DEFAULT 'browser_oauth';
ALTER TABLE "connect_runtime_codes" ADD COLUMN max_uses INTEGER;

CREATE INDEX IF NOT EXISTS "idx_connect_runtime_codes_user_kind"
  ON "connect_runtime_codes" (user_id, kind, expires_at);

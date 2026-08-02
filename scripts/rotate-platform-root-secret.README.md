# Rotate: PLATFORM_ROOT_SECRET

Operator runbook for `scripts/rotate-platform-root-secret.ts`. Sibling of
`scripts/backfill-encrypt-secrets.ts` (which introduced encryption for these
columns in the first place) — this is the rotation path for changing the
secret value afterwards.

## What this does

Rewrites every value encrypted under `PLATFORM_ROOT_SECRET` — across the
tenant D1 shard, the integrations D1, and the federation registry in KV (see
[Coverage](#coverage-every-platform_root_secret-derived-key)) — from
ciphertext-under-OLD-secret to ciphertext-under-NEW-secret, row by row,
with:

- **Idempotency**: every row is try-decrypted under NEW first; success means
  "already rotated" and the row is skipped. Safe to re-run after any
  interruption (crash, Ctrl-C, network blip) — no double-encryption risk.
- **Verify-before-commit**: OLD-decrypt → NEW-encrypt → NEW-decrypt the fresh
  ciphertext → assert it equals the original plaintext byte-for-byte.
  Nothing is written to the DB unless that check passes.
- **Dry-run**: `--dry-run` reports exactly what would change; zero writes.
- **No plaintext logging**: only row ids, counts, and error classes/messages
  ever hit stdout/stderr.
- **Fail-loud by default**: a row that doesn't decrypt under OLD or NEW
  aborts the whole run immediately (non-zero exit). Pass
  `--continue-on-error` to instead collect every such row and keep going —
  they are still never written, just batched into the report.
- **Atomic per-row swap**: each write is a CAS
  (`UPDATE ... WHERE id = ? AND col = ?<ciphertext-we-read>`), so a row
  changed by the live app between our read and write is detected and
  reported as a conflict (left untouched, picked up automatically on re-run)
  instead of being silently clobbered.

## Required env / secrets

| | |
|---|---|
| `CF_ACCOUNT_ID` | Cloudflare account UUID |
| `CF_API_TOKEN` | API token with `D1: Edit` on the shards you're rotating **and** `Workers KV Storage: Edit` on the namespace holding the federation registry |
| `CF_INTEGRATIONS_DB_ID` | Integrations D1 UUID (or `--integrations-db`) |
| `CF_KV_NAMESPACE_ID` | KV namespace UUID holding `federation:*` (or `--kv-namespace`) |
| `PLATFORM_ROOT_SECRET_OLD` | The secret currently in the worker (`wrangler secret list oma-agent` to confirm which one is live — the value itself isn't retrievable, use the value you have on record) |
| `PLATFORM_ROOT_SECRET_NEW` | The new secret you're rotating to |

**Back up `PLATFORM_ROOT_SECRET_OLD` before starting.** If a run is
interrupted partway and you lose the old secret, rows not yet rotated become
permanently unreadable — there's no way to derive OLD from NEW.

## Concurrency & downtime: read this before running

The runtime holds exactly **one** `PLATFORM_ROOT_SECRET` at a time — it
can't try both OLD and NEW on a read. That means there is an unavoidable
window during rotation where:

- Rows already rotated (NEW ciphertext) are readable only once the worker's
  live secret is NEW.
- Rows not yet rotated (still OLD ciphertext) are readable only while the
  worker's live secret is OLD.

**There is no way to make every row continuously readable throughout a
rotation without a maintenance window.** The accepted operational answer,
matching the original backfill script's cutover:

1. Flip the worker's `PLATFORM_ROOT_SECRET` wrangler secret to NEW and
   deploy. From this instant, reads of not-yet-rotated rows
   (`credentials.auth`, `model_cards.api_key_cipher`) fail with a decrypt
   error — the same class of brief outage the original backfill accepted.
2. Immediately run this script (non-dry-run) against every shard, in
   parallel, to close that window as fast as possible.
3. Once `wouldRotate=0` on every shard (see step 4), the outage is over.

This IS a live-writes-safe design in the sense that a credential written by
the app *during* the rotation window (under the runtime's current secret,
whichever that is) will either:
- be written under NEW (worker already flipped) → the rotation script's
  try-NEW-first check sees it as already rotated, skips it, done; or
- be written under OLD, then get raced against by this script's CAS write —
  the CAS guard makes this a detected "conflict" (reported, left alone,
  fixed by the next re-run) rather than data loss.

So: **short read-availability outage for not-yet-rotated rows is expected
and accepted**; **no data loss or corruption is possible** even under
concurrent writes, because of the CAS guard + verify-before-commit.

## Step-by-step cutover

### 0. Back up the old secret

Copy `PLATFORM_ROOT_SECRET_OLD` somewhere durable (secrets manager, sealed
note) before touching anything.

### 1. Dry-run on every shard (no impact, OLD secret still live)

```bash
for db in $(./scripts/list-shards.sh); do
  CF_ACCOUNT_ID=... CF_API_TOKEN=... \
  PLATFORM_ROOT_SECRET_OLD=... PLATFORM_ROOT_SECRET_NEW=... \
    pnpm tsx scripts/rotate-platform-root-secret.ts \
      --db="$db" --integrations-db="$INTEGRATIONS_DB" --kv-namespace="$KV_NS" --dry-run
done
```

Confirm `failures=0` everywhere before proceeding — a nonzero failure count
here means the OLD secret you supplied doesn't match what's actually
encrypting those rows. Stop and reconcile before going further.

### 2. Flip the worker's secret to NEW

```bash
echo "$PLATFORM_ROOT_SECRET_NEW" | wrangler secret put PLATFORM_ROOT_SECRET --name <worker>
```

From this moment, reads of not-yet-rotated rows start failing. This is the
outage window step 3 closes.

### 3. Rotate every shard, in parallel

```bash
SHARDS=$(./scripts/list-shards.sh)
echo "$SHARDS" | xargs -P 8 -I {} \
  env CF_ACCOUNT_ID=... CF_API_TOKEN=... \
      PLATFORM_ROOT_SECRET_OLD=... PLATFORM_ROOT_SECRET_NEW=... \
    pnpm tsx scripts/rotate-platform-root-secret.ts \
      --db={} --shard={} --integrations-db="$INTEGRATIONS_DB" --kv-namespace="$KV_NS"
```

The integrations D1 and the federation KV namespace are **global, not
per-shard** — running the fan-out above rotates them repeatedly, which is
harmless (the second pass sees every row as `alreadyRotated`) but wasteful.
To rotate them exactly once, pass `--no-integrations --no-federation` in the
fan-out and do a single separate run with a shard that carries them.

### 4. Verify

```bash
for db in $(./scripts/list-shards.sh); do
  CF_ACCOUNT_ID=... CF_API_TOKEN=... \
  PLATFORM_ROOT_SECRET_OLD=... PLATFORM_ROOT_SECRET_NEW=... \
    pnpm tsx scripts/rotate-platform-root-secret.ts \
      --db="$db" --integrations-db="$INTEGRATIONS_DB" --kv-namespace="$KV_NS" --dry-run
done
```

Every shard must show `wouldRotate=0` for every table **and** for
`federation(KV)`. Non-zero means
re-run step 3 for that shard (it's fully idempotent).

## Recovery from interruption

Just re-run step 3 for the affected shard. The try-NEW-first check means
already-rotated rows are instantly skipped; only remaining OLD-only rows are
touched. No manual bookkeeping needed.

## Coverage: every PLATFORM_ROOT_SECRET-derived key

`PLATFORM_ROOT_SECRET` is not one key — each subsystem derives its own AES
key as `SHA-256(secret | label)`. A rotation that misses a label leaves that
subsystem's ciphertext permanently unreadable. The complete map:

| Label | Store | Rows | Covered by |
|---|---|---|---|
| `credentials.auth` | tenant D1 | `credentials.auth` | `--db` |
| `model.cards.keys` | tenant D1 | `model_cards.api_key_cipher` | `--db` |
| `integrations.tokens` | **integrations D1** (separate database) | 21 `*_cipher` columns across `linear_apps`, `linear_installations`, `linear_publications`, `github_apps`, `github_installations`, `github_publications`, `slack_apps`, `slack_installations`, `slack_publications` | `--integrations-db` |
| `federation.api_key` | **Workers KV** (not D1) | `api_key_enc` inside the JSON row at `federation:<tenant>:<id>` | `--kv-namespace` |

The script **refuses to run** if `--integrations-db` or `--kv-namespace` is
omitted, unless you explicitly pass `--no-integrations` / `--no-federation`
to assert that deployment has none. That is deliberate: silently skipping a
store is exactly how a rotation ends in unreadable data.

### Derived from the secret but NOT rotatable

These use `PLATFORM_ROOT_SECRET` but store no at-rest ciphertext, so there is
nothing to rewrite — rotating simply invalidates them:

- **Integrations JWTs** (`WebCryptoJwtSigner(PLATFORM_ROOT_SECRET)`) —
  in-flight tokens stop verifying; clients re-authenticate. No action needed.
- **OAuth state signing** (`apps/integrations/src/oauth-unified.ts`) —
  OAuth handshakes in flight at the moment of the flip fail and must be
  restarted by the user. Expect a handful of "please try connecting again".

## Envelope format: why there is no key-version field

The stored envelope is bare `base64url(iv || ciphertext)` with no version
byte, and this change deliberately **does not add one**. Reasoning:

- Idempotency does not need it. Try-decrypt-under-NEW-first already
  classifies every row correctly, is self-correcting after a crash, and
  cannot double-encrypt (AES-GCM authentication makes a wrong-key decrypt
  fail rather than return garbage).
- Adding a version prefix is a wire-format change to a security-critical
  path shared by five independent decrypt implementations (`packages/shared`
  credential-crypto, the CF and Node `WebCryptoAesGcm` classes,
  `apps/oma-vault` reading the column directly, plus the integrations repos).
  Every one would need backward-compatible dual-read, and getting any of
  them wrong is a data-loss bug — a strictly larger risk than the problem it
  would solve.

If a future rotation needs to distinguish generations for another reason,
add it then, as its own change with its own migration — not bundled into a
rotation.

## Known limitation / scope

- **Cloudflare only.** The transport is the D1 + KV HTTP APIs. Self-host
  Postgres/SQLite is not covered (same gap as
  `scripts/backfill-encrypt-secrets.ts`); a Node variant would swap the
  `d1Query` / `kv*` helpers for a `pg` (or better-sqlite3) client and reuse
  `rotateColumn()` unchanged.
- **KV has no CAS.** The D1 pass guards each write with
  `WHERE id = ? AND col = ?<what-we-read>`. Workers KV offers no equivalent,
  so the federation pass writes, then re-reads and verifies the bytes are
  ours — that detects a concurrent write but cannot prevent it. The
  maintenance window below is the mitigation.
- **Legacy plaintext rows are left alone.** `credentials.auth` rows written
  before at-rest encryption existed hold verbatim JSON. The runtime reads
  those unchanged under any secret, so they are counted (`legacyPlaintext=N`)
  and skipped rather than encrypted — encrypting them would be a behavior
  change smuggled into a rotation.

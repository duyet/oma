# Rotating `PLATFORM_ROOT_SECRET`

`PLATFORM_ROOT_SECRET` is the root of at-rest encryption for the whole
platform. Every other secret in the deployment can be swapped by writing a
new value and redeploying; this one cannot, because **changing it makes every
existing ciphertext unreadable** unless the stored rows are re-encrypted at
the same time.

That re-encryption is what `scripts/rotate-platform-root-secret.ts` does. The
full operator runbook — flags, cutover steps, verification, recovery — lives
next to the script in
[`scripts/rotate-platform-root-secret.README.md`](../scripts/rotate-platform-root-secret.README.md).
This page is the orientation: what the secret protects, and the two rules that
matter most.

## What the secret protects

`PLATFORM_ROOT_SECRET` is not used as a key directly. Each subsystem derives
its own AES-256-GCM key as `SHA-256(secret | label)`, so a leak in one
subsystem cannot decrypt another's data. Four labels hold at-rest ciphertext:

| Label | Store | What is encrypted |
|---|---|---|
| `credentials.auth` | tenant D1 | Vault credentials (`credentials.auth`) |
| `model.cards.keys` | tenant D1 | Model-card provider API keys (`model_cards.api_key_cipher`) |
| `integrations.tokens` | integrations D1 (**a separate database**) | Slack / GitHub / Linear OAuth access + refresh tokens, app client secrets, webhook secrets, signing secrets, GitHub App private keys — 21 columns across 9 tables |
| `federation.api_key` | Workers **KV** (not D1) | Remote-instance API keys in the federation registry (`federation:<tenant>:<id>` → `api_key_enc`) |

Two further derivations exist but hold no stored ciphertext, so rotation just
invalidates them and they regenerate: the integrations **JWT signing key**
(in-flight tokens stop verifying; clients re-auth) and the **OAuth state
signing secret** (handshakes in flight at the moment of the flip must be
restarted).

## Rule 1: back the old secret up before you touch anything

There is no way to derive the old secret from the new one. If a rotation is
interrupted after the worker's secret has been flipped and you no longer have
the old value, every not-yet-rotated row is permanently unreadable. Copy it
somewhere durable first.

## Rule 2: flip the worker's secret *before* running the rekey, not after

The runtime holds exactly one secret and cannot try both on a read, so some
read-failure window during rotation is unavoidable. The ordering still
matters, and only one direction is correct:

- **Flip to NEW first, then rekey (correct).** Rows are unreadable until the
  script reaches them, so the failure window **shrinks to zero** as the run
  progresses. Anything the app writes during the window is written under NEW
  — already final, and the script's try-NEW-first check skips it.
- **Rekey first, then flip (wrong).** Each row the script rewrites becomes
  unreadable to the still-on-OLD runtime immediately, so the failure window
  **grows** to 100% and only closes at the flip. Worse, rows the app writes
  during the run land under OLD *behind* the script's cursor, so a second
  pass is required and correctness now depends on catching every straggler.

Run a `--dry-run` across everything *before* the flip and confirm
`failures=0`. That is the check that proves the old secret you hold is
actually the one encrypting the data — do it while the system is still
healthy, not after you have already flipped.

## Scope

The script is **Cloudflare-only** (D1 + KV HTTP APIs). Self-host
Postgres/SQLite deployments have no equivalent tool yet; the `rotateColumn()`
helper is transport-agnostic so a Node variant can reuse it.

See also: [configuration.md](configuration.md) for where the secret is set,
and [vaults-and-credentials.md](vaults-and-credentials.md) for what the
credential ciphertext contains.

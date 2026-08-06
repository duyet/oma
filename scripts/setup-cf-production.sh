#!/usr/bin/env bash
# scripts/setup-cf-production.sh
#
# Provision + deploy the hosted PRODUCTION environment (oma.duyet.net) — the
# `env.production` overlay in apps/{main,agent,integrations}/wrangler.jsonc.
#
# LAUNCH SHAPE: single auth D1, no sharding. Same D1 layout as the self-host
# baseline (scripts/setup-cf.sh) — sharding is premature with zero users. This
# script is the `--env production` sibling of setup-cf.sh: same idempotent
# "check-before-create, patch IDs in place, deploy in order" pattern.
#
#   D1  (2): oma-auth          — all tenant + control-plane data
#            oma-integrations  — linear/github/slack tables
#   KV  (1): CONFIG_KV
#   R2  (4): oma-managed-agents-files, oma-managed-agents-memory,
#            oma-managed-agents-workspace, oma-managed-agents-backups
#   Que (2): oma-managed-agents-memory-events, oma-managed-agents-memory-events-dlq
#
# Migrations (fresh deploy — do NOT run stamp-baseline-existing-deploy.sh):
#   apps/main/migrations              → oma-auth  (tenant/auth schema, INCLUDING
#                                                      tenant_shard / shard_pool /
#                                                      memory_store_tenant — see
#                                                      0001_router_tables.sql)
#   apps/main/migrations-integrations → oma-integrations
#
# Why the router tables are in apps/main/migrations (not applied from
# migrations-router/ separately): even in single-D1 mode, signup writes a
# tenant_shard row (apps/main/src/auth-config.ts) and control-plane services
# (memory_store_tenant index) read via the ROUTER_DB ?? MAIN_DB fallback — i.e.
# oma-auth here. The tables used to exist ONLY in migrations-router/ (applied
# to a real standalone ROUTER_DB in true multi-shard mode), which meant every
# single-D1 deployment — self-host AND this launch — was missing them and every
# signup would throw. Fixed at the schema level: packages/db-schema/src/cf-auth/
# sharding.ts now mirrors packages/db-schema/src/cf-router/sharding.ts, and
# `pnpm db:generate:cf-auth` emitted apps/main/migrations/0001_router_tables.sql
# (byte-identical CREATE TABLE/INDEX statements to migrations-router's version).
# `migrations-router/` is now applied ONLY when ROUTER_DB is a genuinely separate
# D1 (real multi-shard mode, not this launch) — see operations.mdx.
#
# Usage
# ─────
#   ./scripts/setup-cf-production.sh                 # full provision + deploy
#   ./scripts/setup-cf-production.sh --no-deploy     # provision only
#   ./scripts/setup-cf-production.sh --skip-secrets  # if secrets already set
#   ./scripts/setup-cf-production.sh --reset-secrets # overwrite existing secrets
#   ./scripts/setup-cf-production.sh --skip-migrations
#
# Re-runnable: every resource is looked up by name/id and reused if it exists.
# Fresh resources get NEW ids, patched into the env.production blocks of all
# three wrangler.jsonc files IN PLACE — review + commit that diff afterward.
#
# Secrets: export these before running so every run (and every worker) uses the
# SAME value — auto-generation is a last-resort fallback and the irreplaceable
# ones are printed once so you can back them up:
#     export PLATFORM_ROOT_SECRET="$(openssl rand -base64 32)"   # back this up!
#     export BETTER_AUTH_SECRET="$(openssl rand -hex 32)"
#     export INTEGRATIONS_INTERNAL_SECRET="$(openssl rand -hex 32)"
#   optional — this is a self-service platform; tenants bring their own model
#   credentials via model_cards or vaults, so NONE of these are required to
#   deploy a working instance:
#     export ANTHROPIC_API_KEY=sk-ant-... # default-provider fallback, used only when
#                                     # a session's agent has no model_card_id at all
#     export API_KEY=...             # bootstrap admin key (main)
#     export TURNSTILE_SECRET_KEY=... # bot challenge (main); soft-passes if unset
#     export TAVILY_API_KEY=...      # web_search tool (agent)
#     export CLAUDE_CODE_OAUTH_TOKEN=... # only powers agents with "harness": "claude-agent-sdk"
#                                     # (agent); does NOT cover the default harness — see
#                                     # apps/agent/src/harness/claude-agent-sdk/auth.ts
#     export ANYROUTER_API_KEY=...   # default-provider fallback via https://anyrouter.dev
#                                     # (agent); only used when no model card matches and
#                                     # ANTHROPIC_API_KEY is unset — see harness/provider.ts

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

ENV_NAME="production"
MAIN_CFG="apps/main/wrangler.jsonc"
AGENT_CFG="apps/agent/wrangler.jsonc"
INTEGRATIONS_CFG="apps/integrations/wrangler.jsonc"

# Known-good values baked into the env.production overlays today. Used only to
# sanity-check the live account and the hardcoded KV id — never assumed present.
EXPECTED_ACCOUNT_ID="44af79e51582ca20c9003eb926540242"
EXPECTED_KV_ID="5e49bdaec1884f5989037c86ece7b462"

# ── flag parsing ────────────────────────────────────────────────────────
DO_DEPLOY=1
SKIP_SECRETS=0
RESET_SECRETS=0
SKIP_MIGRATIONS=0
for arg in "$@"; do
  case "$arg" in
    --no-deploy)       DO_DEPLOY=0 ;;
    --skip-secrets)    SKIP_SECRETS=1 ;;
    --reset-secrets)   RESET_SECRETS=1 ;;
    --skip-migrations) SKIP_MIGRATIONS=1 ;;
    --help|-h)
      sed -n '2,60p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg"
      exit 1
      ;;
  esac
done

# ── tiny helpers ───────────────────────────────────────────────────────
say()  { printf "\n\033[1;36m▶ %s\033[0m\n" "$*"; }
warn() { printf "\033[1;33m  ⚠ %s\033[0m\n" "$*"; }
die()  { printf "\033[1;31m  ✖ %s\033[0m\n" "$*"; exit 1; }
ok()   { printf "  ✓ %s\n" "$*"; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "$1 not found. Install it and try again."
}

# ── 0. preflight ────────────────────────────────────────────────────────
say "0. Preflight"

require_cmd npx
require_cmd jq
require_cmd node
require_cmd openssl

if ! npx wrangler whoami 2>&1 | grep -q "logged in"; then
  die "wrangler is not logged in. Run: npx wrangler login"
fi
ok "wrangler logged in as $(npx wrangler whoami 2>&1 | grep -oE '[^ ]+@[^ ]+' | head -1)"

ACCOUNT_ID=$(npx wrangler whoami 2>&1 | grep -oE '\b[a-f0-9]{32}\b' | head -1)
[ -n "$ACCOUNT_ID" ] || die "couldn't extract Cloudflare account id from \`wrangler whoami\`"
ok "Cloudflare account → $ACCOUNT_ID"
if [ "$ACCOUNT_ID" != "$EXPECTED_ACCOUNT_ID" ]; then
  warn "live account ($ACCOUNT_ID) != the account baked into env.production ($EXPECTED_ACCOUNT_ID)."
  warn "Fine for a fresh deploy — the agent worker's CLOUDFLARE_ACCOUNT_ID var is re-patched below."
fi

# ANTHROPIC_API_KEY / ANYROUTER_API_KEY are OPTIONAL, not required. This is
# a self-service platform — tenants bring their own provider credentials via
# model_cards (POST /v1/model_cards) or vault-backed credentials on their
# agents. The env-var key here is only a lazy, per-session FALLBACK used by
# session-do.ts's resolveModelCardCredentials when a session's agent has no
# model_card_id at all — nothing at boot, signup, or tenant-creation reads
# it. Deploying without it is completely normal: a fresh instance works
# immediately for signup/environments/vaults/agents; the only thing that
# needs a model_card (or this fallback) is a session actually calling a
# model. Neither key set here is fine — just warn, don't block deploy.
if [ "$SKIP_SECRETS" = "0" ] && [ -z "${ANTHROPIC_API_KEY:-}" ] && [ -z "${ANYROUTER_API_KEY:-}" ]; then
  warn "Neither ANTHROPIC_API_KEY nor ANYROUTER_API_KEY exported — skipping the default-provider fallback."
  warn "Deploy proceeds normally; tenants configure their own model_cards (or a vault credential) per-agent."
fi

# Console assets are bundled into the main worker (assets.directory =
# ../console/dist, inherited by the env overlays). Deploy fails without them.
if [ "$DO_DEPLOY" = "1" ] && [ ! -d "apps/console/dist" ]; then
  die "apps/console/dist is missing — build the Console first: pnpm --filter managed-agents-console build"
fi

# ── jsonc patch helpers (env.production overlay aware) ───────────────────
# Patch every entry in env.production.<arrayKey> whose <matchField> == matchVal,
# setting <idField> = newVal. Writes only on change; preserves comments/format.
patch_prod_id() {
  local cfg="$1" array_key="$2" match_field="$3" match_val="$4" id_field="$5" new_val="$6"
  local res
  res=$(CFG="$cfg" ARRKEY="$array_key" MATCHFIELD="$match_field" MATCHVAL="$match_val" \
        IDFIELD="$id_field" NEWVAL="$new_val" node <<'NODE'
const { parse, modify, applyEdits } = require("jsonc-parser");
const fs = require("fs");
const cfg = process.env.CFG;
const arrayKey = process.env.ARRKEY;
const matchField = process.env.MATCHFIELD;
const matchVal = process.env.MATCHVAL;
const idField = process.env.IDFIELD;
const newVal = process.env.NEWVAL;
let text = fs.readFileSync(cfg, "utf8");
let obj = parse(text);
const arr = (obj.env && obj.env.production && obj.env.production[arrayKey]) || [];
let changed = 0, unchanged = 0, missing = 0;
for (let i = 0; i < arr.length; i++) {
  if (arr[i][matchField] !== matchVal) continue;
  if (arr[i][idField] === newVal) { unchanged++; continue; }
  const edits = modify(text, ["env", "production", arrayKey, i, idField], newVal, {
    formattingOptions: { tabSize: 2, insertSpaces: true },
  });
  text = applyEdits(text, edits);
  obj = parse(text);
  changed++;
}
if (changed === 0 && unchanged === 0) missing = 1;
if (changed) fs.writeFileSync(cfg, text);
process.stdout.write(JSON.stringify({ changed, unchanged, missing }));
NODE
)
  local changed missing
  changed=$(echo "$res" | jq -r '.changed')
  missing=$(echo "$res" | jq -r '.missing')
  if [ "$missing" = "1" ]; then
    ok "$cfg :: no env.production.$array_key entry with $match_field=$match_val (not bound here — skipped)"
  elif [ "$changed" != "0" ]; then
    ok "$cfg :: patched $changed binding(s) ($match_field=$match_val) $id_field=$new_val"
  else
    ok "$cfg :: $match_field=$match_val already $new_val (unchanged)"
  fi
}

# Patch env.production.vars.<key> = value.
patch_prod_var() {
  local cfg="$1" key="$2" value="$3"
  CFG="$cfg" VKEY="$key" VVAL="$value" node <<'NODE' >/dev/null
const { parse, modify, applyEdits } = require("jsonc-parser");
const fs = require("fs");
const cfg = process.env.CFG;
const text = fs.readFileSync(cfg, "utf8");
const obj = parse(text);
const cur = obj.env && obj.env.production && obj.env.production.vars
  ? obj.env.production.vars[process.env.VKEY] : undefined;
if (cur === process.env.VVAL) process.exit(0);
const edits = modify(text, ["env", "production", "vars", process.env.VKEY], process.env.VVAL, {
  formattingOptions: { tabSize: 2, insertSpaces: true },
});
fs.writeFileSync(cfg, applyEdits(text, edits));
NODE
  ok "$cfg :: env.production.vars.$key = $value"
}

# ── 1. provision resources (idempotent) ──────────────────────────────────
say "1. Provision Cloudflare resources (idempotent)"

create_d1() {
  local name="$1"
  local out id
  if out=$(npx wrangler d1 create "$name" 2>&1); then
    id=$(echo "$out" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
    [ -n "$id" ] || die "couldn't extract id from \`wrangler d1 create $name\`"
    echo "$id"
  else
    id=$(npx wrangler d1 list --json 2>/dev/null | jq -r --arg n "$name" '.[] | select(.name == $n) | .uuid' | head -1)
    [ -n "$id" ] && [ "$id" != "null" ] || die "d1 $name doesn't exist and create failed: $out"
    echo "$id"
  fi
}

create_r2() {
  local name="$1"
  local out
  out=$(npx wrangler r2 bucket create "$name" 2>&1) \
    || npx wrangler r2 bucket info "$name" >/dev/null 2>&1 \
    || die "r2 bucket $name doesn't exist and create failed: $out"
  ok "r2 bucket $name"
}

create_queue() {
  local name="$1" out
  if out=$(npx wrangler queues create "$name" 2>&1); then
    ok "queue $name (created)"
  elif echo "$out" | grep -qi "already taken"; then
    # `wrangler queues list` has no --json/table-only output in this
    # wrangler version, so idempotency here relies on parsing the create
    # command's own "already taken" error instead of a pre-check via list.
    ok "queue $name (exists)"
  else
    warn "queue $name — create failed and not confirmed already-existing; wrangler also creates it lazily on first consumer deploy: $out"
  fi
}

# D1 databases — create-or-lookup by name (single-D1 layout).
AUTH_DB_ID=$(create_d1 "oma-auth");                 ok "D1 oma-auth         → $AUTH_DB_ID"
INTEGRATIONS_DB_ID=$(create_d1 "oma-integrations"); ok "D1 oma-integrations → $INTEGRATIONS_DB_ID"

# KV — the env.production overlays hardcode id EXPECTED_KV_ID. Verify it
# exists in this account first; if not, look up by TITLE (re-running this
# script after it already created one gives a namespace with a NEW,
# non-hardcoded id — checking only the original hardcoded id would try to
# create a duplicate and fail with "already exists"); only create if truly
# absent by both id and title.
say "1b. CONFIG_KV namespace"
# No --json flag on this subcommand in this wrangler version — passing it
# prints help text instead of erroring, which then fails downstream jq
# parsing with a confusing "Invalid numeric literal" error. Plain JSON is
# this command's only (default) output format.
KV_LIST=$(npx wrangler kv namespace list 2>/dev/null)
if echo "$KV_LIST" | jq -e --arg id "$EXPECTED_KV_ID" '.[] | select(.id == $id)' >/dev/null 2>&1; then
  CONFIG_KV_ID="$EXPECTED_KV_ID"
  ok "CONFIG_KV $EXPECTED_KV_ID already exists — reusing"
elif existing_id=$(echo "$KV_LIST" | jq -r '.[] | select(.title == "CONFIG_KV") | .id' | head -1) && [ -n "$existing_id" ]; then
  CONFIG_KV_ID="$existing_id"
  ok "CONFIG_KV $CONFIG_KV_ID already exists (found by title) — reusing"
else
  warn "hardcoded CONFIG_KV id $EXPECTED_KV_ID not found in this account — creating a fresh namespace"
  out=$(npx wrangler kv namespace create "CONFIG_KV" 2>&1) || die "kv namespace create failed: $out"
  CONFIG_KV_ID=$(echo "$out" | grep -oE '[a-f0-9]{32}' | head -1)
  [ -n "$CONFIG_KV_ID" ] || die "couldn't extract new KV id from create output"
  ok "CONFIG_KV → $CONFIG_KV_ID (new)"
fi

# R2 buckets (union of all three env.production overlays). Names must match
# apps/{main,agent}/wrangler.jsonc env.production (oma- prefix rebrand).
create_r2 "oma-managed-agents-files"
create_r2 "oma-managed-agents-memory"
create_r2 "oma-managed-agents-workspace"
create_r2 "oma-managed-agents-backups"

# Queues (same oma- prefix as wrangler.jsonc queue consumers).
create_queue "oma-managed-agents-memory-events"
create_queue "oma-managed-agents-memory-events-dlq"

# ── 2. patch env.production overlays with resolved ids ───────────────────
say "2. Patch env.production overlays with resolved resource ids"

# D1 — patch by database_name across all three configs. Configs that don't bind
# a given database (e.g. agent has no INTEGRATIONS_DB) are skipped harmlessly.
for cfg in "$MAIN_CFG" "$AGENT_CFG" "$INTEGRATIONS_CFG"; do
  patch_prod_id "$cfg" d1_databases database_name "oma-auth"         database_id "$AUTH_DB_ID"
  patch_prod_id "$cfg" d1_databases database_name "oma-integrations" database_id "$INTEGRATIONS_DB_ID"
done

# KV — main + agent bind CONFIG_KV.
patch_prod_id "$MAIN_CFG"  kv_namespaces binding "CONFIG_KV" id "$CONFIG_KV_ID"
patch_prod_id "$AGENT_CFG" kv_namespaces binding "CONFIG_KV" id "$CONFIG_KV_ID"

# CLOUDFLARE_ACCOUNT_ID var (agent) — needed by the sandbox SDK to mint R2
# presigned URLs. Re-patch when the live account differs from what's baked in.
patch_prod_var "$AGENT_CFG" CLOUDFLARE_ACCOUNT_ID "$ACCOUNT_ID"

# ── 3. apply migrations ───────────────────────────────────────────────────
if [ "$SKIP_MIGRATIONS" = "0" ]; then
  say "3. Apply D1 migrations (remote)"

  apply_migrations() {
    local db_name="$1" dir="$2"
    echo "  → $db_name (from $dir)"
    # `wrangler d1 migrations apply` has no --migrations-dir flag — the
    # directory comes from the matching d1_databases entry's own
    # `migrations_dir` field in $MAIN_CFG (see env.production.d1_databases
    # above), resolved for THIS env via --env production. Capture the real
    # exit status before piping through grep, so a failed migration aborts
    # the script instead of silently continuing to deploy against an
    # unmigrated schema.
    local out status
    out=$(npx wrangler d1 migrations apply "$db_name" --remote \
      --config "$MAIN_CFG" --env "$ENV_NAME" 2>&1)
    status=$?
    echo "$out" | grep -E '(Applied|No migrations|already)' || true
    [ "$status" -eq 0 ] || die "migrations apply failed for $db_name (from $dir):"$'\n'"$out"
  }

  # Tenant/auth schema (now includes tenant_shard/shard_pool/memory_store_tenant
  # via 0001_router_tables.sql — see header comment) → the single auth DB.
  apply_migrations "oma-auth"         "apps/main/migrations"
  # Integration subsystem tables (linear_* / github_* / slack_*).
  apply_migrations "oma-integrations" "apps/main/migrations-integrations"
else
  warn "3. Skipping migrations (--skip-migrations)"
fi

# ── 4. set secrets (per env.production worker) ────────────────────────────
if [ "$SKIP_SECRETS" = "0" ]; then
  say "4. Set required Worker secrets (--env production)"

  gen_base64_secret() { openssl rand -base64 32; }
  gen_hex_secret()    { openssl rand -hex 32; }

  # Resolve a secret value: prefer the exported env var; else auto-generate
  # via $2 (a function name — no eval, no shell re-parsing of a command
  # string). Runs in a $(...) subshell, so it cannot report "was this
  # generated?" via a side-effect variable — callers check that themselves
  # by testing the original env var *before* overwriting it with this call.
  gen_or_env() {
    local var_name="$1" gen_fn="$2"
    local val="${!var_name:-}"
    if [ -z "$val" ]; then
      val=$("$gen_fn")
    fi
    echo "$val"
  }

  # Sets a secret. Returns 0 if it was actually WRITTEN (new, or
  # --reset-secrets), 1 if skipped because it already exists remotely —
  # callers use this to decide whether a freshly-generated irreplaceable
  # value truly needs a "SAVE THIS NOW" warning (printing it unconditionally
  # would be misleading when set_secret silently skips the write because the
  # real value is already provisioned).
  set_secret() {
    local name="$1" value="$2" cfg="$3"
    if [ "$RESET_SECRETS" = "0" ]; then
      if npx wrangler secret list --env "$ENV_NAME" --config "$cfg" 2>/dev/null \
           | jq -e ".[] | select(.name == \"$name\")" >/dev/null 2>&1; then
        ok "$cfg [$ENV_NAME] :: $name (already set, skipping; --reset-secrets to overwrite)"
        return 1
      fi
    fi
    echo "$value" | npx wrangler secret put "$name" --env "$ENV_NAME" --config "$cfg" >/dev/null
    ok "$cfg [$ENV_NAME] :: $name"
    return 0
  }

  # Shared across all three workers — value MUST match everywhere. Export these
  # to guarantee consistency across re-runs / interrupted runs.
  platform_root_generated=$([ -z "${PLATFORM_ROOT_SECRET:-}" ] && echo 1 || echo 0)
  PLATFORM_ROOT_SECRET=$(gen_or_env PLATFORM_ROOT_SECRET gen_base64_secret)
  INTEGRATIONS_INTERNAL_SECRET=$(gen_or_env INTEGRATIONS_INTERNAL_SECRET gen_hex_secret)

  platform_root_written=0
  for cfg in "$MAIN_CFG" "$AGENT_CFG" "$INTEGRATIONS_CFG"; do
    if set_secret PLATFORM_ROOT_SECRET "$PLATFORM_ROOT_SECRET" "$cfg"; then
      platform_root_written=1
    fi
    # set_secret returns 1 (non-fatal "already set, skipping") when RESET_SECRETS=0
    # — guard every unchecked call against `set -e` aborting the script on that path.
    set_secret INTEGRATIONS_INTERNAL_SECRET "$INTEGRATIONS_INTERNAL_SECRET" "$cfg" || true
    # ANTHROPIC_API_KEY is optional here if ANYROUTER_API_KEY covers the
    # default-provider fallback instead (see preflight check above).
    if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
      set_secret ANTHROPIC_API_KEY "$ANTHROPIC_API_KEY" "$cfg" || true
    fi
  done
  if [ "$platform_root_generated" = "1" ] && [ "$platform_root_written" = "1" ]; then
    warn "PLATFORM_ROOT_SECRET was not exported — auto-generated and just written. SAVE THIS NOW (losing it is unrecoverable):"
    printf "      PLATFORM_ROOT_SECRET=%s\n" "$PLATFORM_ROOT_SECRET"
  fi

  # main-only
  better_auth_generated=$([ -z "${BETTER_AUTH_SECRET:-}" ] && echo 1 || echo 0)
  BETTER_AUTH_SECRET=$(gen_or_env BETTER_AUTH_SECRET gen_hex_secret)
  if set_secret BETTER_AUTH_SECRET "$BETTER_AUTH_SECRET" "$MAIN_CFG" && [ "$better_auth_generated" = "1" ]; then
    warn "BETTER_AUTH_SECRET was not exported — auto-generated and just written. SAVE THIS NOW (losing it is unrecoverable):"
    printf "      BETTER_AUTH_SECRET=%s\n" "$BETTER_AUTH_SECRET"
  fi
  if [ -n "${API_KEY:-}" ]; then
    set_secret API_KEY "$API_KEY" "$MAIN_CFG" || true
  else
    warn "API_KEY not exported — skipping (bootstrap admin key; set later with: wrangler secret put API_KEY --env production --config $MAIN_CFG)"
  fi
  if [ -n "${TURNSTILE_SECRET_KEY:-}" ]; then
    set_secret TURNSTILE_SECRET_KEY "$TURNSTILE_SECRET_KEY" "$MAIN_CFG" || true
  else
    warn "TURNSTILE_SECRET_KEY not exported — Turnstile soft-passes (bot challenge disabled). env.production sets TURNSTILE_SITE_KEY, so set this to actually enforce the challenge."
  fi

  # agent-only
  if [ -n "${TAVILY_API_KEY:-}" ]; then
    set_secret TAVILY_API_KEY "$TAVILY_API_KEY" "$AGENT_CFG" || true
  else
    warn "TAVILY_API_KEY not exported — the web_search tool stays unavailable until set on $AGENT_CFG"
  fi
  if [ -n "${ANYROUTER_API_KEY:-}" ]; then
    set_secret ANYROUTER_API_KEY "$ANYROUTER_API_KEY" "$AGENT_CFG" || true
  else
    warn "ANYROUTER_API_KEY not exported — skipping (static default-provider fallback via https://anyrouter.dev; only used when no model card matches and ANTHROPIC_API_KEY is unset)"
  fi
  if [ -n "${CLAUDE_CODE_OAUTH_TOKEN:-}" ]; then
    set_secret CLAUDE_CODE_OAUTH_TOKEN "$CLAUDE_CODE_OAUTH_TOKEN" "$AGENT_CFG" || true
  else
    warn "CLAUDE_CODE_OAUTH_TOKEN not exported — skipping (only used by agents that explicitly set \"harness\": \"claude-agent-sdk\"; ANTHROPIC_API_KEY/ANYROUTER_API_KEY still cover the default harness)"
  fi
else
  warn "4. Skipping secrets (--skip-secrets)"
fi

# ── 5. deploy (integrations → agent → main) ──────────────────────────────
if [ "$DO_DEPLOY" = "1" ]; then
  say "5. Deploy workers (integrations → agent → main, --env production)"

  # Deploy is non-fatal per step: cross-worker links (main↔agent↔integrations
  # service bindings, and the agent's RUNTIME_ROOM cross-script DO binding to
  # `managed-agents`) form a cycle. On a cold account the first pass may warn or
  # fail on a not-yet-existent target; the script is re-runnable, so a second
  # run resolves everything. We keep going and report at the end.
  DEPLOY_FAILED=0
  deploy_worker() {
    local label="$1" cfg="$2"
    echo "  → $label"
    if npx wrangler deploy --config "$cfg" --env "$ENV_NAME"; then
      ok "$label deployed"
    else
      warn "$label deploy returned non-zero — likely a cross-worker binding to a not-yet-deployed target. Re-run this script to complete."
      DEPLOY_FAILED=1
    fi
  }

  deploy_worker "integrations (managed-agents-integrations)" "$INTEGRATIONS_CFG"
  deploy_worker "agent (sandbox-default)"                    "$AGENT_CFG"
  deploy_worker "main (managed-agents)"                      "$MAIN_CFG"

  # ── 6. wire R2 → memory-events queue (post-deploy) ────────────────────
  say "6. Wire R2 memory bucket → memory-events queue"
  npx wrangler r2 bucket notification create oma-managed-agents-memory \
    --event-type object-create object-delete \
    --queue oma-managed-agents-memory-events 2>&1 | tail -3 \
    || warn "R2 notification setup failed — wire manually once the queue consumer exists (see cmd below)"

  if [ "$DEPLOY_FAILED" = "1" ]; then
    warn "One or more deploys failed on this pass — RE-RUN the script to resolve the cross-worker binding cycle."
  fi
else
  warn "5. Skipping deploy (--no-deploy)"
  warn "After deploying, wire the R2 notification:"
  warn "  npx wrangler r2 bucket notification create oma-managed-agents-memory \\"
  warn "    --event-type object-create object-delete \\"
  warn "    --queue oma-managed-agents-memory-events"
fi

# ── done ─────────────────────────────────────────────────────────────────
say "Done."

cat <<EOF

Post-deploy checklist / known gaps:

  1. COMMIT the wrangler.jsonc id changes this script patched into
     env.production (if any were fresh). Otherwise a future CI deploy will
     use stale ids.

  2. MAIN HAS NO ROUTE. apps/main/wrangler.jsonc's env.production block has no
     "routes" — the app is only reachable at its *.workers.dev URL, NOT at
     app.oma.duyet.net. Add (needs the oma.duyet.net zone on this account):

         "routes": [
           { "pattern": "app.oma.duyet.net", "custom_domain": true }
         ]

     (integrations.oma.duyet.net IS already routed in the integrations config.)

  3. Verify the deploy:
         curl -s https://<main-workers-dev-or-app.oma.duyet.net>/health
         npx wrangler tail managed-agents --env production

  4. Do NOT run scripts/stamp-baseline-existing-deploy.sh — that's only for
     deployments that already ran the historical (pre-consolidation)
     migrations. This is a fresh deploy.

  5. Usage metering is intentionally OFF (no managed-agents-billing worker /
     USAGE_METER binding). Sessions start unmetered; /billing-api/* returns 404.

  6. Single-D1 launch: no sharding. To scale out later, re-add ROUTER_DB +
     AUTH_DB_00..03 to the env.production overlays (git history / env.staging),
     provision the shard DBs + oma-router, and migrate tenants.
EOF

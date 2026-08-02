#!/usr/bin/env bash
# scripts/setup-cf.sh
#
# Interactive setup wizard for a fresh CF self-host deploy. One command,
# ~5 minutes (network-bound on the Anthropic key + wrangler API calls).
#
# What it does
# ────────────
#   1. Preflight: wrangler login, jq + node, prompt for Anthropic key
#   2. Create resources (idempotent — re-running is safe):
#      - 2 D1 DBs (oma-auth, oma-integrations)
#      - 1 KV namespace (CONFIG_KV)
#      - 4 R2 buckets (files, workspace, memory, backups)
#   3. Generate apps/<app>/wrangler.local.jsonc (gitignored copies of the
#      tracked wrangler.jsonc) with the captured IDs spliced in. The tracked
#      files keep their `<set-by-setup-cf-sh>` placeholders and stay clean.
#   4. Set required secrets (auto-generated where possible)
#   5. Apply migrations (one consolidated file per D1)
#   6. Wire R2 → memory-events queue notification
#   7. Deploy main + agent + integrations workers
#
# Usage
# ─────
#   ./scripts/setup-cf.sh                 # interactive
#   ./scripts/setup-cf.sh --no-deploy     # provision but don't deploy
#   ./scripts/setup-cf.sh --skip-secrets  # if you already set them
#
# Re-runnable: detects existing resources and reuses their IDs. Re-prompts
# for secrets only if you pass --reset-secrets.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$ROOT_DIR"

# ── flag parsing ────────────────────────────────────────────────────────
DO_DEPLOY=1
SKIP_SECRETS=0
RESET_SECRETS=0
for arg in "$@"; do
  case "$arg" in
    --no-deploy)     DO_DEPLOY=0 ;;
    --skip-secrets)  SKIP_SECRETS=1 ;;
    --reset-secrets) RESET_SECRETS=1 ;;
    --help|-h)
      sed -n '2,30p' "$0"
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

# Parse a JSONC file's top-level fields via jsonc-parser (already in repo
# devDeps). Output exact JSON.
read_jsonc() {
  local path="$1" key="$2"
  node -e "
    const {parse} = require('jsonc-parser');
    const fs = require('fs');
    const cfg = parse(fs.readFileSync('$path', 'utf8'));
    const v = cfg['$key'];
    process.stdout.write(JSON.stringify(v));
  "
}

# Update a top-level field in a JSONC file, preserving formatting + comments
# via jsonc-parser's modify() + applyEdits(). Used to splice IDs in without
# wrecking the human-edited structure.
patch_jsonc() {
  local path="$1" json_pointer="$2" new_value="$3"
  node -e "
    const {modify, applyEdits} = require('jsonc-parser');
    const fs = require('fs');
    const text = fs.readFileSync('$path', 'utf8');
    const path_arr = $json_pointer;
    const value = $new_value;
    const edits = modify(text, path_arr, value, { formattingOptions: { tabSize: 2, insertSpaces: true } });
    fs.writeFileSync('$path', applyEdits(text, edits));
  "
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

# Anthropic key — required.
if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  ok "ANTHROPIC_API_KEY from env"
else
  read -rsp "  Anthropic API key (sk-ant-...): " ANTHROPIC_API_KEY
  echo
  [ -n "$ANTHROPIC_API_KEY" ] || die "ANTHROPIC_API_KEY is required"
fi
export ANTHROPIC_API_KEY

# ── 1. create resources ─────────────────────────────────────────────────
say "1. Provision Cloudflare resources (idempotent)"

create_d1() {
  local name="$1"
  # Try create; if it already exists, look up the id via list.
  local out
  if out=$(npx wrangler d1 create "$name" 2>&1); then
    local id
    id=$(echo "$out" | grep -oE '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}' | head -1)
    [ -n "$id" ] || die "couldn't extract id from `wrangler d1 create $name` output"
    echo "$id"
  else
    # Already exists path
    local id
    id=$(npx wrangler d1 list --json 2>/dev/null | jq -r --arg n "$name" '.[] | select(.name == $n) | .uuid' | head -1)
    [ -n "$id" ] && [ "$id" != "null" ] || die "d1 $name doesn't exist and create failed: $out"
    echo "$id"
  fi
}

create_kv() {
  local binding="$1"
  local out
  if out=$(npx wrangler kv namespace create "$binding" 2>&1); then
    local id
    id=$(echo "$out" | grep -oE '"id": "[a-f0-9]+"' | grep -oE '[a-f0-9]{32}' | head -1)
    [ -n "$id" ] || die "couldn't extract KV id from create output"
    echo "$id"
  else
    local id
    id=$(npx wrangler kv namespace list --json 2>/dev/null | jq -r --arg t "$binding" '.[] | select(.title | endswith($t)) | .id' | head -1)
    [ -n "$id" ] && [ "$id" != "null" ] || die "KV namespace $binding doesn't exist and create failed: $out"
    echo "$id"
  fi
}

create_r2() {
  local name="$1"
  npx wrangler r2 bucket create "$name" 2>/dev/null \
    || npx wrangler r2 bucket info "$name" >/dev/null 2>&1 \
    || die "r2 bucket $name doesn't exist and create failed"
  ok "r2 bucket $name"
}

AUTH_DB_ID=$(create_d1 "oma-auth")
ok "D1 oma-auth → $AUTH_DB_ID"
INTEGRATIONS_DB_ID=$(create_d1 "oma-integrations")
ok "D1 oma-integrations → $INTEGRATIONS_DB_ID"

CONFIG_KV_ID=$(create_kv "CONFIG_KV")
ok "KV CONFIG_KV → $CONFIG_KV_ID"

create_r2 "managed-agents-files"
create_r2 "managed-agents-workspace"
create_r2 "managed-agents-memory"
create_r2 "managed-agents-backups"

ACCOUNT_ID=$(npx wrangler whoami 2>&1 | grep -oE '\b[a-f0-9]{32}\b' | head -1)
[ -n "$ACCOUNT_ID" ] || die "couldn't extract Cloudflare account id from `wrangler whoami`"
ok "Cloudflare account → $ACCOUNT_ID"

# ── 2. generate wrangler.local.jsonc files ──────────────────────────────
say "2. Generate wrangler.local.jsonc files with resource IDs"

# The tracked apps/<app>/wrangler.jsonc files are the pristine source of
# truth and keep their `<set-by-setup-cf-sh>` placeholders. We copy each one
# to a sibling wrangler.local.jsonc (gitignored) and splice the real ids into
# the copy, so a configured checkout has no permanently-dirty tracked files.
# The copy lives in the same directory, so every relative path inside the
# config (main entry, assets directory, migrations_dir) still resolves.
MAIN_CFG="apps/main/wrangler.local.jsonc"
AGENT_CFG="apps/agent/wrangler.local.jsonc"
INTEGRATIONS_CFG="apps/integrations/wrangler.local.jsonc"

# Seed the copy from the tracked file only when it doesn't exist yet, so a
# re-run never clobbers hand edits (custom domain, extra bindings) the
# operator made in their local config. The ids below are re-patched either way.
gen_local_cfg() {
  local src="$1" dst="$2"
  if [ -f "$dst" ]; then
    ok "$dst (exists — reusing, ids re-patched below)"
  else
    cp "$src" "$dst"
    ok "$dst (generated from $src)"
  fi
}

gen_local_cfg apps/main/wrangler.jsonc         "$MAIN_CFG"
gen_local_cfg apps/agent/wrangler.jsonc        "$AGENT_CFG"
gen_local_cfg apps/integrations/wrangler.jsonc "$INTEGRATIONS_CFG"

# Find array index of a binding entry under top-level d1_databases or kv_namespaces.
# Returns the index, or -1 if not found.
jsonc_array_index_by_binding() {
  local path="$1" array_key="$2" binding="$3"
  node -e "
    const {parse} = require('jsonc-parser');
    const fs = require('fs');
    const cfg = parse(fs.readFileSync('$path', 'utf8'));
    const arr = cfg['$array_key'] || [];
    const idx = arr.findIndex(x => x.binding === '$binding');
    process.stdout.write(String(idx));
  "
}

# Patch a top-level binding's database_id (D1) or id (KV).
patch_d1() {
  local path="$1" binding="$2" id="$3"
  local idx
  idx=$(jsonc_array_index_by_binding "$path" "d1_databases" "$binding")
  [ "$idx" != "-1" ] || { warn "no $binding D1 binding in $path top-level — skip"; return; }
  patch_jsonc "$path" "[\"d1_databases\", $idx, \"database_id\"]" "\"$id\""
  ok "$path :: d1_databases[$idx=$binding].database_id = $id"
}

patch_kv() {
  local path="$1" binding="$2" id="$3"
  local idx
  idx=$(jsonc_array_index_by_binding "$path" "kv_namespaces" "$binding")
  [ "$idx" != "-1" ] || { warn "no $binding KV in $path top-level — skip"; return; }
  patch_jsonc "$path" "[\"kv_namespaces\", $idx, \"id\"]" "\"$id\""
  ok "$path :: kv_namespaces[$idx=$binding].id = $id"
}

patch_var() {
  local path="$1" key="$2" value="$3"
  patch_jsonc "$path" "[\"vars\", \"$key\"]" "\"$value\""
  ok "$path :: vars.$key = $value"
}

# apps/main: AUTH_DB + INTEGRATIONS_DB + CONFIG_KV + INTEGRATIONS_ORIGIN
patch_d1 "$MAIN_CFG" AUTH_DB         "$AUTH_DB_ID"
patch_d1 "$MAIN_CFG" INTEGRATIONS_DB "$INTEGRATIONS_DB_ID"
patch_kv "$MAIN_CFG" CONFIG_KV       "$CONFIG_KV_ID"
# Default INTEGRATIONS_ORIGIN to the integrations workers.dev URL — user
# can override later if they bring a custom domain.
patch_var "$MAIN_CFG" INTEGRATIONS_ORIGIN \
  "https://managed-agents-integrations.${ACCOUNT_ID:0:8}.workers.dev"

# apps/agent: AUTH_DB + CONFIG_KV + CLOUDFLARE_ACCOUNT_ID
patch_d1 "$AGENT_CFG" AUTH_DB   "$AUTH_DB_ID"
patch_kv "$AGENT_CFG" CONFIG_KV "$CONFIG_KV_ID"
patch_var "$AGENT_CFG" CLOUDFLARE_ACCOUNT_ID "$ACCOUNT_ID"

# apps/integrations: AUTH_DB + INTEGRATIONS_DB + GATEWAY_ORIGIN
patch_d1 "$INTEGRATIONS_CFG" AUTH_DB         "$AUTH_DB_ID"
patch_d1 "$INTEGRATIONS_CFG" INTEGRATIONS_DB "$INTEGRATIONS_DB_ID"
patch_var "$INTEGRATIONS_CFG" GATEWAY_ORIGIN \
  "https://managed-agents-integrations.${ACCOUNT_ID:0:8}.workers.dev"

# ── 3. apply migrations ─────────────────────────────────────────────────
say "3. Apply D1 migrations"

apply_migrations() {
  local db_name="$1" dir="$2"
  echo "  → $db_name (from $dir)"
  # `wrangler d1 migrations apply` has no --migrations-dir flag — the
  # directory comes from the matching d1_databases entry's own
  # `migrations_dir` field in the config (defaults to ./migrations if unset).
  # Capture the real exit status before piping through grep, so a failed
  # migration aborts the script instead of silently continuing to deploy.
  local out status
  out=$(npx wrangler d1 migrations apply "$db_name" --remote --config "$MAIN_CFG" 2>&1)
  status=$?
  echo "$out" | grep -E '(Applied|No migrations)' || true
  [ "$status" -eq 0 ] || die "migrations apply failed for $db_name (from $dir):"$'\n'"$out"
}

apply_migrations "oma-auth"         "apps/main/migrations"
apply_migrations "oma-integrations" "apps/main/migrations-integrations"
# ROUTER_DB is the same physical DB as AUTH_DB in single-D1 mode (the
# code falls back via env.ROUTER_DB ?? env.AUTH_DB). The router tables
# (tenant_shard, shard_pool, memory_store_tenant) are created by
# apps/main/migrations/0001_router_tables.sql — part of the regular
# apps/main/migrations dir applied above, NOT a separate step — so we don't
# apply migrations-router/ in single-D1 mode. For multi-shard prod, the
# operator runs `wrangler d1 migrations apply oma-router` separately
# against a genuinely standalone ROUTER_DB.

# ── 4. set secrets ──────────────────────────────────────────────────────
if [ "$SKIP_SECRETS" = "0" ]; then
  say "4. Set required Worker secrets"

  set_secret() {
    local name="$1" value="$2" config="$3"
    if [ "$RESET_SECRETS" = "0" ]; then
      # Skip if already set (best-effort: wrangler secret list shows names only).
      if npx wrangler secret list --config "$config" 2>/dev/null | jq -e ".[] | select(.name == \"$name\")" >/dev/null 2>&1; then
        ok "$config :: $name (already set, skipping; pass --reset-secrets to overwrite)"
        return
      fi
    fi
    echo "$value" | npx wrangler secret put "$name" --config "$config" >/dev/null
    ok "$config :: $name"
  }

  # Required everywhere — same value across all 3 workers
  PLATFORM_ROOT_SECRET=$(openssl rand -base64 32)
  INTEGRATIONS_INTERNAL_SECRET=$(openssl rand -hex 32)
  BETTER_AUTH_SECRET=$(openssl rand -hex 32)
  API_KEY=$(openssl rand -hex 16)

  for cfg in "$MAIN_CFG" "$AGENT_CFG" "$INTEGRATIONS_CFG"; do
    set_secret PLATFORM_ROOT_SECRET         "$PLATFORM_ROOT_SECRET"         "$cfg"
    set_secret INTEGRATIONS_INTERNAL_SECRET "$INTEGRATIONS_INTERNAL_SECRET" "$cfg"
    set_secret ANTHROPIC_API_KEY            "$ANTHROPIC_API_KEY"            "$cfg"
  done

  # main-only
  set_secret BETTER_AUTH_SECRET "$BETTER_AUTH_SECRET" "$MAIN_CFG"
  set_secret API_KEY            "$API_KEY"            "$MAIN_CFG"
fi

# ── 5. R2 → queue notification ──────────────────────────────────────────
say "5. Wire R2 memory bucket → memory-events queue"

# This requires the queue itself to exist — wrangler creates it lazily on
# first deploy of the consumer. So if we're deploying, do this AFTER deploy.
# If --no-deploy, skip and leave a note.
if [ "$DO_DEPLOY" = "0" ]; then
  warn "skipping R2 notification (queue doesn't exist until first deploy)"
  warn "after deploying, run:"
  warn "  npx wrangler r2 bucket notification create managed-agents-memory \\"
  warn "    --event-type object-create object-delete \\"
  warn "    --queue managed-agents-memory-events"
fi

# ── 6. deploy ───────────────────────────────────────────────────────────
if [ "$DO_DEPLOY" = "1" ]; then
  say "6. Deploy workers (main, agent, integrations)"

  echo "  → integrations (depended on by main + agent)"
  npx wrangler deploy --config "$INTEGRATIONS_CFG" 2>&1 | tail -3

  echo "  → agent (sandbox)"
  npx wrangler deploy --config "$AGENT_CFG" 2>&1 | tail -3

  echo "  → main"
  npx wrangler deploy --config "$MAIN_CFG" 2>&1 | tail -3

  # Now that the queue consumer exists, wire the R2 → queue subscription
  say "5b. Wire R2 → queue (post-deploy)"
  npx wrangler r2 bucket notification create managed-agents-memory \
    --event-type object-create object-delete \
    --queue managed-agents-memory-events 2>&1 | tail -3 || warn "R2 notification setup failed — wire manually"
fi

# ── done ────────────────────────────────────────────────────────────────
say "Done."

cat <<EOF

Your deploy config lives in apps/{main,agent,integrations}/wrangler.local.jsonc
(gitignored). The tracked wrangler.jsonc files keep their placeholders — pass
--config <app>/wrangler.local.jsonc to every wrangler command below.

Next steps:
  - Open the main worker URL (printed above) in your browser
  - Sign up an account; the first user becomes their tenant's owner
  - To enable Slack/GitHub/Linear OAuth, set those secrets:
      npx wrangler secret put LINEAR_CLIENT_ID --config apps/integrations/wrangler.local.jsonc
      npx wrangler secret put GITHUB_APP_ID    --config apps/integrations/wrangler.local.jsonc
      npx wrangler secret put SLACK_CLIENT_ID  --config apps/integrations/wrangler.local.jsonc
    See apps/docs/src/content/docs/self-host/oauth-apps.mdx
  - To redeploy after code changes:
      npx wrangler deploy --config apps/main/wrangler.local.jsonc
  - To scale to multi-shard in the future: see operations.mdx (env.production).

EOF

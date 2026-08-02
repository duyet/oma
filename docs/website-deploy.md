# Deploying the marketing website

`apps/web` (the marketing site) auto-deploys to `oma.duyet.net` via
[`.github/workflows/deploy-website.yml`](../.github/workflows/deploy-website.yml)
on every push to `main` that touches `apps/web/**`. One-time manual setup:

1. Create a Cloudflare API token with Workers Scripts (edit) + Account
   Settings (read) permissions, and set it as the `CLOUDFLARE_API_TOKEN`
   repo secret. Set `CLOUDFLARE_ACCOUNT_ID` (from the CF dashboard) as
   the `CLOUDFLARE_ACCOUNT_ID` repo secret.
2. In the Cloudflare dashboard, add `oma.duyet.net` as a Custom Domain /
   DNS record on the account that owns `duyet.net` — `wrangler deploy`
   provisions the route from `apps/web/wrangler.jsonc`, but the zone
   itself must already be on that account.

No other manual steps are required; `workflow_dispatch` is also available
for manual re-runs.

---
name: verify-oma
description: Drive Open Managed Agents the way a user does. Marketing site (Astro) and Console (Vite). Use when proving a UI, class-merge, or page change in oma, or when asked to verify, screenshot, or smoke the app.
---

# Verify oma

Agent-facing control skill for this repo. Launch a disposable instance, doctor it, drive a mapped feature, capture evidence, then clean up only what this run started.

Primary surface: the marketing site at `apps/web` (Astro, no secrets). Secondary surface: the operator Console at `apps/console` (Vite on `:5173`, proxies `/v1` and `/auth` to `:8787`). The API worker (`pnpm dev`, `:8787`) is out of scope for a no-secrets run. Do not invent `BETTER_AUTH_SECRET`, `PLATFORM_ROOT_SECRET`, or API keys.

The lever is `control-oma.mjs` in this directory. Prefer it over throwaway scripts.

```bash
node .cursor/skills/verify-oma/control-oma.mjs <command>
```

Repo root is detected from the skill file. Override with `OMA_ROOT`. Evidence lives under `.cursor/skills/verify-oma/artifacts/<run-id>/` and is copied to `/opt/cursor/artifacts/` when that directory exists. Cleanup never deletes evidence.

## Launch

One surface per run. Two instances may share a machine if they use different ports. Never attach to a server this run did not start.

**Marketing (default, no secrets):**

```bash
node .cursor/skills/verify-oma/control-oma.mjs launch web
```

Starts `pnpm exec astro dev --host 127.0.0.1 --port <port>` from `apps/web`. Default port `4321`. Ready when `GET /` returns HTTP 200 and the body contains `Open Managed Agents`. Logged URL is stored in `.cursor/skills/verify-oma/.run/state.json`.

**Console (UI only; API optional):**

```bash
node .cursor/skills/verify-oma/control-oma.mjs launch console
```

Starts `pnpm exec vite --host 127.0.0.1 --port <port> --strictPort` from `apps/console`. Default port `5173`. Ready when `GET /login` returns HTTP 200. Does not start the worker. Login can render without a live API. Protected routes (`/`, `/agents`, `/analytics`) redirect to `/login` when unauthenticated (`AppShell`).

Pass `--port N` to either launch. Isolation: pick a free port. Do not reuse `4321`/`5173` if they already answer.

Teardown is `cleanup`, not `killall`.

## Doctor

```bash
node .cursor/skills/verify-oma/control-oma.mjs doctor
```

Read-only. Passes only when all of these hold:

- `.run/state.json` exists and names a `pid` this process table still has.
- `GET <url>/` (web) or `GET <url>/login` (console) is HTTP 200.
- The listening port matches the state file.
- For `web`, the body includes `Open Managed Agents`.
- For `console`, the body is an HTML document (Vite index).

If doctor fails, stop. Do not drive a foreign instance.

## Drive

Recipes live in `features/`. Match the change to a feature file, then:

```bash
node .cursor/skills/verify-oma/control-oma.mjs drive <feature-id>
```

The harness uses system Chrome (`/usr/bin/google-chrome` or `CHROME_PATH`) via Playwright. Default viewport `1280x800` so the marketing desktop nav (`hidden md:flex`) is visible.

One-shot browser steps (same Chrome, one session):

```bash
node .cursor/skills/verify-oma/control-oma.mjs screenshot --path / --out home.png
node .cursor/skills/verify-oma/control-oma.mjs assert --path / --heading "The self-hosted agent platform for any LLM provider and any sandbox"
node .cursor/skills/verify-oma/control-oma.mjs landing-check
```

`landing-check` runs `apps/web/scripts/verify-landing.mjs` with `LANDING_URL` set to the launched origin. That script is the existing structural harness. Use it in addition to a visual drive, not instead of one.

Stable handles on the marketing site:

- Home link: `a[aria-label="Open Managed Agents — home"]`
- Primary nav: `nav[aria-label="Primary"]`
- Features menu: `nav[aria-label="Features"]`
- H1 on `/`: `The self-hosted agent platform for any LLM provider and any sandbox`
- H1 on `/features/`: `Everything you need to run agent fleets`

Stable handles on Console login (`/login`):

- Heading: `Welcome back`
- Subtitle: `Sign in to your workspace`
- Email: `#auth-email` / label `Email`
- Submit: button named `Sign in`

Prefer those over CSS position or tab order.

## Evidence

Each `drive` writes into `artifacts/<run-id>/<feature-id>/`:

| File | What it proves |
| --- | --- |
| `before.png` | Viewport after navigation, before the proving action |
| `after.png` | Viewport after the proving action |
| `aria.yml` | Playwright ARIA snapshot of `body` |
| `report.json` | Feature id, url, assertions, pass/fail, timestamps |

Proof standards:

- Exercise the real user path (open the page, follow a nav link). Do not stub routers or call test-only endpoints.
- Capture the action and the resulting state, not only the last frame.
- Side effects: for `landing-check`, the script's stdout is the structural proof. For `pin-cn`, the JSON fixture file is the merge-behavior proof.
- After cleanup, confirm the artifact directory still exists. A cleanup that deletes proof fails the run.

`pin-cn` is the class-merge characterization lever. Capture before a `cn` helper change. Check after. The pin file is `.cursor/skills/verify-oma/artifacts/cn-pin.json` (stable across launches).

```bash
node .cursor/skills/verify-oma/control-oma.mjs pin-cn capture
node .cursor/skills/verify-oma/control-oma.mjs pin-cn check
```

It imports the real `cn` export from `apps/web/src/lib/utils.ts` and `apps/console/src/lib/utils.ts` (Node `--experimental-strip-types`). Fixtures cover last-utility-wins (`p-2` then `p-4` → `p-4`), falsy skips, and object/array inputs. The pin is not a typecheck.

## Cleanup

```bash
node .cursor/skills/verify-oma/control-oma.mjs cleanup
```

Sends SIGTERM to the pid in `.run/state.json`, waits, then SIGKILL if it is still alive. Removes the state file. Does not delete `artifacts/`. Does not kill by process name. Does not touch ports this run does not own.

If launch failed partway, still run cleanup.

## Helpers

| Command | Purpose |
| --- | --- |
| `launch web\|console [--port N]` | Start one surface, write state, wait until ready |
| `doctor` | Confirm this run's instance is the one answering |
| `drive <feature-id>` | Run the mapped recipe, write screenshots + JSON |
| `screenshot --path <route> --out <file>` | One PNG of a route |
| `assert --path <route> --heading <text>` | Heading must be visible |
| `landing-check` | Existing `verify-landing.mjs` against the live origin |
| `pin-cn capture\|check` | Equivalence pin for `cn()` |
| `status` | Print state.json |
| `cleanup` | Stop what launch started |

Feature ids: `landing-home`, `landing-features`, `console-login`, `console-login-mobile`, `console-agents`, `console-analytics`, `console-inject`.

Keep the map honest with `/maintain-verification-skill` when routes, headings, or launch commands drift.

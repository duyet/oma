# Landing home

The marketing homepage tells a visitor what Open Managed Agents is, shows the product identity, and offers paths into docs, GitHub, hosted Console, and deeper pages.

## Sub-features

- `home-load` renders the H1 value prop and the `oma` wordmark.
- `home-identity` keeps `Open Managed Agents` in the document title or body.
- `home-cta` exposes `Try hosted` and a GitHub link.
- `home-nav` exposes the desktop Primary nav, including Platform and Features.

## How to get to it (user POV)

- Open `/` on the marketing origin.
- Choose the home link `Open Managed Agents — home` from any marketing page.

## Driving it with control-oma

Preconditions:

- `control-oma launch web` is healthy at `http://127.0.0.1:4321` (or the port in state.json).
- `control-oma doctor` reports surface `web` and HTTP 200 on `/`.
- Viewport is `1280x800`.

- **Open home.** Go to `/`. Run `node .cursor/skills/verify-oma/control-oma.mjs drive landing-home`. The heading `The self-hosted agent platform for any LLM provider and any sandbox` is visible.
- **Identity.** The accessible name `Open Managed Agents — home` is present (header and footer both use it; assert the first). The body contains `Open Managed Agents`.
- **CTA.** A `Try hosted` link is visible.
- **Nav.** `nav[aria-label="Primary"]` is visible. A `Features` control exists inside it.
- **Proof.** `before.png` is the first paint of `/`. `after.png` is the same viewport after the assertions (scroll not required). `aria.yml` includes the H1 text. `report.json` lists each assertion as pass.

Optional structural companion (not a substitute for the screenshots):

```bash
node .cursor/skills/verify-oma/control-oma.mjs landing-check
```

## Gotchas

- Below the `md` breakpoint the Primary nav is hidden. A 375px screenshot that lacks nav is not a failure of the nav sub-feature. Re-run at `1280x800`.
- Header and footer both expose `a[aria-label="Open Managed Agents — home"]`. Target `.first()` (header). A strict locator without `.first()` fails.
- Hosted Console is `app.oma.duyet.net`. Do not follow `Try hosted` off-origin during a local proof.
- `landing-check` without `LANDING_URL` only checks source files. The lever sets `LANDING_URL` from state.json. Do not run the script from `apps/web` yourself and call that a live drive.

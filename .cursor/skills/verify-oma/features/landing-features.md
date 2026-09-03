# Landing features

The features index explains what the platform ships. A visitor reaches it from the homepage explore row or the Platform menu.

## Sub-features

- `features-open` opens `/features/` from home.
- `features-heading` shows `Everything you need to run agent fleets`.
- `features-why` shows the Why section with `Drop-in compatible`.

## How to get to it (user POV)

- Choose `Features` in the homepage `Dig deeper` / explore row (`/features/`).
- Choose `Features` inside the Platform dropdown (`nav[aria-label="Platform"]`).
- Open `/features/` directly.

## Driving it with control-oma

Preconditions:

- Marketing is healthy (`doctor` surface `web`).
- Viewport is `1280x800`.

- **Open from home.** Run `node .cursor/skills/verify-oma/control-oma.mjs drive landing-features`. The recipe loads `/`, then follows the in-page `Features` explore link (`a[href="/features/"]` whose accessible name includes `Features`).
- **Heading.** The features page heading is `Everything you need to run agent fleets`.
- **Why.** Visible text includes `Drop-in compatible`.
- **Proof.** `before.png` is `/` with the explore row in view (the recipe scrolls it into view first). `after.png` is `/features/` after navigation. `aria.yml` is taken on `/features/`. `report.json` records the URL change from `/` to `/features/`.

## Gotchas

- The header also has a `Features` dropdown that points at `/features/agent-sandbox/`, not the index. Assert the resulting path is `/features/` (trailing slash). Landing on a child feature page means the wrong link was used.
- Astro `trailingSlash: "always"`. A missing trailing slash may 301. Wait for the final URL.
- `drive landing-home` does not cover this page. A home screenshot is not proof of the features index.

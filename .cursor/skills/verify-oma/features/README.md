# oma verification map

This directory is the maintained source for verifying user-facing behavior of Open Managed Agents. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Launch through `control-oma`. Never attach to a server this run did not start.
- Marketing drives use `launch web` (Astro, default `http://127.0.0.1:4321`). No secrets.
- Console drives use `launch console` (Vite, default `http://127.0.0.1:5173`). No invented auth secrets. Unauthenticated `/` redirects to `/login`.
- Desktop viewport `1280x800`. The marketing primary nav is `hidden md:flex`.
- Put the repo root on your cwd. Run `node .cursor/skills/verify-oma/control-oma.mjs doctor` and require a matching pid, port, and surface.
- Chrome is `/usr/bin/google-chrome` unless `CHROME_PATH` is set.

## Driving conventions

- Start every recipe from the launched origin unless its preconditions say otherwise.
- Prefer ARIA roles, accessible names, and the handles listed in each file.
- Treat every command as literal.
- Run browser actions through `control-oma drive` or the one-shot `screenshot` / `assert` commands.
- Restore nothing on the marketing site (it is static). Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- UI proof includes an ARIA snapshot and a screenshot with the product identity visible (`oma` wordmark or `Welcome back`).
- Structural proof for marketing also runs `landing-check`.
- Mutation proof does not apply to the static marketing site.
- Record the feature ID and entry point in `report.json`.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.
- `console-agents` is unreachable without a real session. Skip it when no auth exists. Do not mint one.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-oma` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

## Features

- [Landing home](./landing-home.md) covers the marketing homepage hero, identity, and primary CTAs.
- [Landing features](./landing-features.md) covers the `/features/` index reached from home.
- [Console login](./console-login.md) covers the unauthenticated Console sign-in screen.
- [Console agents](./console-agents.md) covers the agents list. Requires a real session. Skip when none exists.
- [Console session artifacts](./console-session-artifacts.md) covers the session-detail Artifacts tab. Requires a real session. Skip the tab when none exists.

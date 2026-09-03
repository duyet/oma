# Console agents

The agents list is the operator roster. It is behind `AppShell` auth. Without a real session the route redirects to login.

## Sub-features

- `agents-gate` redirects signed-out visitors from `/agents` to `/login`.
- `agents-list` shows the Agents heading and create affordance when signed in.
- `agents-empty` shows the empty roster state when the tenant has no agents.

## How to get to it (user POV)

- Choose `Agents` in the Console sidebar after sign-in.
- Open `/agents` directly.

## Driving it with control-oma

Preconditions:

- Console is healthy (`doctor` surface `console`).
- A real session cookie exists. If it does not, run only `agents-gate` and report the list paths as skipped.

- **Gate (always).** Run `node .cursor/skills/verify-oma/control-oma.mjs drive console-agents`. The recipe opens `/agents`. With no session, the final URL contains `/login` and `Welcome back` is visible. That is a pass for `agents-gate` and a skip for `agents-list` / `agents-empty`.
- **List (session required).** After a real sign-in, `/agents` shows an Agents page heading. Capture `after.png` of the list or empty state.
- **Proof.** `before.png` is the first `/agents` navigation. `after.png` is the settled URL (login or list). `report.json` names which sub-features ran and which were skipped.

## Gotchas

- Do not invent credentials, seed users, or set `AUTH_DISABLED`. Skip the signed-in paths.
- A login screenshot is proof of the gate, not of the roster.
- The data router may briefly show `BrandLoader` (`Loading session`). Wait for login or the list heading.

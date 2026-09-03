# Console inject

The Inject inspector tab lets an operator append a system prompt, mount an MCP server, toggle tools, or bind a vault credential on a running session. It is behind `AppShell` auth. Without a real session the route redirects to login.

## Sub-features

- `inject-gate` redirects signed-out visitors from a session URL to `/login`.
- `inject-tab` shows the Inspector Inject tab when signed in.
- `inject-sections` shows the four injection sections (prompt, MCP, tools, credentials) when signed in.

## How to get to it (user POV)

- Open a session, then choose `Inject` in the Inspector right-rail.
- Open `/sessions/<id>` directly and switch to Inject.

## Driving it with control-oma

Preconditions:

- Console is healthy (`doctor` surface `console`).
- A real session cookie exists. If it does not, run only `inject-gate` and report the panel paths as skipped.

- **Gate (always).** Run `node .cursor/skills/verify-oma/control-oma.mjs drive console-inject`. The recipe opens `/sessions/sess_fake`. With no session, the final URL contains `/login` and `Welcome back` is visible. That is a pass for `inject-gate` and a skip for `inject-tab` / `inject-sections`.
- **Panel (session required).** After a real sign-in, a live session's Inspector shows an Inject tab with system prompt, MCP, tools, and credentials. Capture `after.png` of the panel.
- **Proof.** `before.png` is the first `/sessions/sess_fake` navigation. `after.png` is the settled URL (login or Inject panel). `report.json` names which sub-features ran and which were skipped. Component tests in `InjectPanel.test.tsx` prove the four sections and that credential tokens never render.

## Gotchas

- Do not invent credentials, seed users, or set `AUTH_DISABLED`. Skip the signed-in paths.
- A login screenshot is proof of the gate, not of the Inject panel.
- Tokens must never appear in the panel, the overlay GET, or `session.config_updated`.

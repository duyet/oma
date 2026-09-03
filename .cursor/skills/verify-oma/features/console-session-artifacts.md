# Console session artifacts

Session detail is the operator view of a running conversation. The Inspector rail's Artifacts tab is the place to browse files the agent produced. Without a session cookie the route is behind `AppShell` and redirects to login.

## Sub-features

- `session-detail-gate` redirects signed-out visitors from `/sessions/:id` to `/login`.
- `login-heading` shows `Welcome back` after that redirect.
- `artifacts-tab` shows the Inspector Artifacts tab when signed in.

## How to get to it (user POV)

- Open a session from the Sessions list.
- Open `/sessions/<id>` directly.
- In the session Inspector, choose the Artifacts tab.

## Driving it with control-oma

Preconditions:

- Console is healthy (`doctor` surface `console`).
- A real session cookie exists for the signed-in path. If it does not, run only the gate and report `artifacts-tab` as skipped.
- Do not invent `BETTER_AUTH_SECRET`, `PLATFORM_ROOT_SECRET`, or API keys.

- **Gate (always).** Run `node .cursor/skills/verify-oma/control-oma.mjs drive console-session-artifacts`. The recipe opens `/sessions/sess_verify_artifacts`. With no session, the final URL contains `/login` and `Welcome back` is visible. That is a pass for `session-detail-gate` and a skip for `artifacts-tab`.
- **Tab (session required).** After a real sign-in, session detail shows an Inspector tab named `Artifacts`. Capture `after.png` of that tab.
- **Proof.** `before.png` is the first `/sessions/sess_verify_artifacts` navigation. `after.png` is the settled URL (login or session detail). `report.json` names which sub-features ran and which were skipped.

## Gotchas

- Do not invent credentials, seed users, or set `AUTH_DISABLED`. Skip the signed-in path.
- A login screenshot is proof of the gate, not of the Artifacts panel. Unit tests in `apps/console/src/pages/session-detail/artifacts.test.ts` cover derivation.
- The session id in the recipe is a probe. A 404 after sign-in still proves the route left `/login`.

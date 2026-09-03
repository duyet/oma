# Console analytics

The Analytics page is the operator view of estimated spend, tokens, and declared delegation. It is behind `AppShell` auth. Without a real session the route redirects to login.

## Sub-features

- `analytics-gate` redirects signed-out visitors from `/analytics` to `/login`.
- `analytics-charts` shows the Analytics heading, range chips, KPI strip, and charts when signed in.
- `analytics-empty` shows the empty-period state when the tenant has no usage in the selected window.

## How to get to it (user POV)

- Choose `Analytics` in the Console sidebar after sign-in.
- Open `/analytics` directly.

## Driving it with control-oma

Preconditions:

- Console is healthy (`doctor` surface `console`).
- A real session cookie exists. If it does not, run only `analytics-gate` and report the chart paths as skipped.

- **Gate (always).** Run `node .cursor/skills/verify-oma/control-oma.mjs drive console-analytics`. The recipe opens `/analytics`. With no session, the final URL contains `/login` and `Welcome back` is visible. That is a pass for `analytics-gate` and a skip for `analytics-charts` / `analytics-empty`.
- **Charts (session required).** After a real sign-in, `/analytics` shows an Analytics page heading and a Range control. Capture `after.png` of the charts or empty state.
- **Proof.** `before.png` is the first `/analytics` navigation. `after.png` is the settled URL (login or charts). `report.json` names which sub-features ran and which were skipped.

## Gotchas

- Do not invent credentials, seed users, or set `AUTH_DISABLED`. Skip the signed-in paths.
- A login screenshot is proof of the gate, not of spend charts.
- The data router may briefly show `BrandLoader` (`Loading session`). Wait for login or the Analytics heading.
- Charts are range-scoped (`1d` / `7d` / `30d`) from `GET /v1/usage`. Usage (`/usage`) stays all-time tables. Do not treat a Usage screenshot as Analytics proof.

# Console login on a phone viewport

The unauthenticated `/login` form must remain usable at 390×844. This is the only Console surface that can be driven without worker secrets. Authenticated HITL and session cards stay behind `/login`.

## Sub-features

- `login-load` renders the `Welcome back` heading at phone width.
- `login-email` shows the Email field (`#auth-email`).
- `login-submit` shows a `Sign in` button.
- `login-fits-viewport` keeps the heading inside the 390 px frame.
- `login-gate` sends `/` to `/login` when no session exists.

## How to get to it (user POV)

- Open `/login` on the Console origin from a phone-sized browser.
- Open `/` while signed out. `AppShell` redirects to `/login`.

## Driving it with control-oma

Preconditions:

- `control-oma launch console` is healthy.
- `control-oma doctor` reports surface `console`.
- No session cookie is required. Do not create one.

- **Open login.** Run `node .cursor/skills/verify-oma/control-oma.mjs drive console-login-mobile`. The recipe loads `/login` at viewport 390×844.
- **Heading.** An `h1` with `Welcome back` is visible. Subtitle text `Sign in to your workspace` is visible.
- **Fields.** `#auth-email` is visible. A button named `Sign in` is visible.
- **Fit.** The heading's bounding box stays inside the 390 px viewport.
- **Gate.** A second navigation to `/` ends on a URL that contains `/login`.
- **Proof.** `before.png` is `/login` after load at 390×844. `after.png` is the same form after the field assertions. `aria.yml` is taken on `/login`.

Do not submit the form. There is no disposable account in this environment, and inventing `BETTER_AUTH_SECRET` is forbidden.

## Gotchas

- This drive does not cover the authenticated session list, approval card, or notification bell. Those require a real Console session.
- `/auth-info` 502s or HTTP 500 toasts when the worker is down. The login form still renders.
- Wait for `Welcome back`, not for the first paint.

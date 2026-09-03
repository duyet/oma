# Console login

Unauthenticated operators sign in on `/login`. The page is the public Console surface that can render without worker secrets.

## Sub-features

- `login-load` renders the `Welcome back` heading and `Sign in to your workspace` subtitle.
- `login-email` shows the Email field (`#auth-email`).
- `login-submit` shows a `Sign in` button.
- `login-gate` sends `/` to `/login` when no session exists.

## How to get to it (user POV)

- Open `/login` on the Console origin.
- Open `/` or `/agents` while signed out. `AppShell` redirects to `/login`.

## Driving it with control-oma

Preconditions:

- `control-oma launch console` is healthy.
- `control-oma doctor` reports surface `console`.
- No session cookie is required. Do not create one.

- **Open login.** Run `node .cursor/skills/verify-oma/control-oma.mjs drive console-login`. The recipe loads `/login`.
- **Heading.** An `h1` with `Welcome back` is visible. Subtitle text `Sign in to your workspace` is visible.
- **Fields.** `#auth-email` is visible. A button named `Sign in` is visible.
- **Gate.** A second navigation to `/` ends on a URL that contains `/login`.
- **Proof.** `before.png` is `/login` after load. `after.png` is the same login form after the field assertions. The `/` redirect is recorded in `report.json` (`login-gate.detail`). `aria.yml` is taken on `/login`.

Do not submit the form. There is no disposable account in this environment, and inventing `BETTER_AUTH_SECRET` is forbidden.

## Gotchas

- `/auth-info` 502s or HTTP 500 toasts when the worker is down. The login form still renders. Those toasts are not a failed drive on a no-API launch.
- `isLoading` shows `Loading...` until `/auth-info` and the session probe settle. Wait for `Welcome back`, not for the first paint.
- `/cli/login` is a different page. Do not treat it as this feature.
- Social buttons (`Continue with Google` / `Continue with GitHub`) only appear when `/auth-info` advertises those providers. Their absence is not a failure on a no-API launch.

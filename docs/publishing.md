# Publish an agent to consumers

Publish an agent as a standalone bot that end users talk to without an OMA
account — a hosted chat page at `/p/<slug>`, an embeddable widget, guest access,
and optional per-message billing.

- **Widget embed** — `<script src="https://<host>/p/<slug>/widget.js" async></script>`
  drops a floating chat launcher onto any site. The Console **My Bots** page
  (`/my-bots`) surfaces the public URL, a QR code, and the copy-paste snippet.
- **Consumer auth** (`/v1/public/auth/*`) — magic-link, one-tap **guest** mode,
  and in-place **upgrade** (guest → email, history preserved). Creators see who
  used their bot via `GET /v1/publications/:id/users`.
- **Metering & paywall** (`@duyet/oma-payments`) — per-publication pricing
  (`free` / `per_message` / `per_1k_tokens` / `subscription`) over a credit
  wallet. Blocked turns return HTTP 402; top-ups run through Stripe Checkout
  (`POST /webhooks/stripe`). Kill-switch via `PAYMENTS_DISABLED`.

Full reference: [`AGENTS.md` § Publishing, Consumers & Payments](../AGENTS.md#publishing-consumers--payments).

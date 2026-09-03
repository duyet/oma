# Model Cards

Per-tenant LLM credentials. An agent references one by setting `agent.model = "<model_id>"` — the worker looks up the card and signs the outbound request with its api_key, base_url, and headers. This is the canonical replacement for the global `ANTHROPIC_API_KEY` env var.

When a tenant has **no** cards, `GET /v1/model_cards` still returns a
read-only `source: "platform"` row for the inherited deployment fallback
(handle `claude-sonnet-4-6`, the same id the seeded General agent uses).
`oma models list` therefore always has a model id to pass. Mutating that
row returns 403; it is never written to storage. With no card match, the
agent worker uses `ANTHROPIC_API_KEY`, or `ANYROUTER_API_KEY` when Anthropic
is unset. Bare `claude-*` handles are rewritten to `anthropic/claude-*` on
generic OpenAI-compat gateways. AnyRouter aliases hyphenated
`anthropic/claude-sonnet-4-6` to dotted BYOK-only
`anthropic/claude-sonnet-4.6`, so `resolveModel` (the HTTP body both
SessionDO and Node send) uses `anyrouter/free` when the request goes to
AnyRouter — on `openai.chat` (`/chat/completions`) **and** on
`anthropic()` (`/messages`). An `ANTHROPIC_API_KEY` plus AnyRouter
`ANTHROPIC_BASE_URL` deploy never hits the OpenAI branch. Never send the
dotted 4.6 slug.

Providers (wire tag → request shape):

| tag | shape | typical use |
|---|---|---|
| `ant` | Anthropic `/v1/messages` | Claude on `api.anthropic.com` |
| `ant-compatible` | Anthropic shape, custom `base_url` | Bedrock proxy, self-hosted Anthropic-compatible |
| `oai` | OpenAI `/v1/chat/completions` | OpenAI, Azure OpenAI |
| `oai-compatible` | OpenAI shape, custom `base_url` | vLLM, OpenRouter, Groq, etc. |

Add one from **Console → Model Cards**, or via CLI:

```bash
oma models create \
  --model-id claude-prod \
  --provider ant \
  --model claude-sonnet-4-6 \
  --api-key sk-ant-...
oma models list
```

REST: `POST /v1/model_cards`, `GET /v1/model_cards`, `POST /v1/model_cards/:id` (rotate), `DELETE /v1/model_cards/:id`. Create runs a 6-second probe so a bad key fails loudly, not at first turn.

Keys are AES-256-GCM-encrypted at rest under `PLATFORM_ROOT_SECRET` (label `model.cards.keys`); list responses surface only the last-4 preview. Rotate by POSTing a new `api_key` — no redeploy, no key versioning (re-run the backfill script if you rotate `PLATFORM_ROOT_SECRET` itself).

See also: connecting AnyRouter for a one-click, no-pasted-key provider —
[`AGENTS.md` § Connecting AnyRouter](../AGENTS.md#connecting-anyrouter-one-click-no-pasted-key).

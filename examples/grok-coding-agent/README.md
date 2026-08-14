# Grok coding agent example

The same generic long-running coding agent as [`examples/coding-agent`](../coding-agent),
but routed to xAI's Grok through the OpenAI-compatible wire format instead of
Anthropic. Demonstrates that swapping the model provider is a Model Card +
agent config change — no different harness, no different sandbox image.

## What this demonstrates

- **Provider swap via Model Card, not code.** `apps/agent/src/harness/provider.ts`
  branches on `ApiCompat` (`"ant" | "ant-compatible" | "oai" | "oai-compatible"`);
  `"oai-compatible"` always talks `/v1/chat/completions`, which is what xAI's
  Grok API (and Groq, DeepSeek, most gateways) expose. `run.sh` creates a
  Model Card with `provider: "oai-compatible"`, `base_url:
  https://api.x.ai/v1`, and the Grok API key — then `agent.json` sets
  `"model": "grok-coding"` to match the card's `model_id`. Resolution is by
  `agent.model` matching a Model Card's `model_id` (see
  `resolveModelCardCredentials` in `apps/agent/src/runtime/session-do.ts`) —
  the agent config never references the card by its internal id.
- **No `harness` field** — same `DefaultHarness` as `examples/coding-agent`.
  The default harness's model loop is provider-agnostic; only the wire
  format changes.
- **Not the local ACP path.** To run xAI's **Grok Build** CLI on a paired
  machine instead of the in-process loop, bind `acp_agent_id: "grok-build"`
  (`oma bridge setup` + `npm install -g @xai-official/grok`). See
  [`docs/runtimes.md`](../../docs/runtimes.md#local-grok-build-acp).
- **Same sandbox image as any other coding agent** — see
  [`docker/coding-agent-openai-compat`](../../docker/coding-agent-openai-compat)
  and [`docs/runtimes.md`](../../docs/runtimes.md) for why a Grok agent
  doesn't need a different sandbox image than a Claude agent.

## Prerequisites

- A running Open Managed Agents instance (Cloudflare `pnpm dev` or self-hosted
  `docker compose`).
- An xAI API key ([console.x.ai](https://console.x.ai)).
- `oma` CLI configured (`oma auth login`) or `curl` + an OMA API key.
- An environment id (`oma envs list` / `POST /v1/environments`).

## Build

```bash
docker build -t oma-example-grok-coding-agent examples/grok-coding-agent
```

## Run

```bash
docker run --rm \
  -e OMA_BASE_URL=https://your-instance \
  -e OMA_API_KEY=$OMA_KEY \
  -e OMA_ENV_ID=env_xxx \
  -e GROK_API_KEY=$XAI_KEY \
  -e GITHUB_REPO_URL=https://github.com/your-org/your-repo \
  oma-example-grok-coding-agent
```

`run.sh`:
1. `POST /v1/model_cards` with `provider: "oai-compatible"`, xAI's base URL,
   and the Grok API key — `model_id: "grok-coding"`.
2. `POST /v1/agents` with `agent.json` (`"model": "grok-coding"`, no
   `model_card_id` field — the platform matches by `model_id`, not by card
   id).
3. `POST /v1/sessions` referencing the created agent + an environment id.
4. `POST /v1/sessions/:id/resources` to attach the GitHub repo.
5. `POST /v1/sessions/:id/events` with a `user.message` to kick off a turn.

## Using a different OpenAI-compatible provider

Set `GROK_BASE_URL` and `GROK_MODEL` to point at any other
`/v1/chat/completions`-compatible gateway (Groq, DeepSeek, OpenRouter,
AnyRouter, a local vLLM/Ollama instance, etc.) — the harness and sandbox
don't change, only the Model Card's `base_url` / `model` / `api_key`.

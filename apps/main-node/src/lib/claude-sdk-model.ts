// Per-agent model/provider resolution for the self-host Node
// `claude-agent-sdk` harness (issue #316).
//
// Before #316 the Claude Code CLI subprocess only ever saw the node's
// process-global ANTHROPIC_API_KEY / CLAUDE_CODE_OAUTH_TOKEN /
// ANTHROPIC_BASE_URL, so every agent on a node ran on the same upstream
// regardless of its `model` / model card. This resolves the agent's card
// (the same `agent.model` handle → `model_cards.model_id` lookup the CF
// SessionDO does in resolveModelCardCredentials) into a
// `ClaudeSdkModelBinding`, which the harness maps onto the subprocess env.
//
// Returns null whenever nothing per-agent resolves (no card, archived card,
// undecryptable key, lookup failure) — the caller then leaves ctx.env alone
// and the harness keeps its pre-#316 global-env behavior exactly.

import type { ModelCardRow } from "@duyet/oma-model-cards-store";
import {
  providerToApiCompat,
  type ClaudeSdkModelBinding,
} from "@duyet/oma-agent/harness/claude-agent-sdk/model";

/** The slice of ModelCardService this resolver needs (keeps tests fake-able). */
export interface ModelCardLookup {
  get(opts: { tenantId: string; cardId: string }): Promise<ModelCardRow | null>;
  findByModelId(opts: { tenantId: string; modelId: string }): Promise<ModelCardRow | null>;
  getApiKey(opts: { tenantId: string; cardId: string }): Promise<string | null>;
}

export async function resolveAgentModelBinding(input: {
  modelCards: ModelCardLookup;
  tenantId: string;
  agent: {
    model?: string | { id?: string } | null;
    metadata?: Record<string, unknown> | null;
  };
  logger?: { warn: (ctx: Record<string, unknown>, msg: string) => void };
}): Promise<ClaudeSdkModelBinding | null> {
  const { modelCards, tenantId, agent } = input;
  const handle = typeof agent.model === "string" ? agent.model : (agent.model?.id ?? "");
  // AgentConfig has no typed `model_card_id` column; the documented field
  // lives in metadata on this runtime. An explicit id wins over the handle.
  const cardId = typeof agent.metadata?.model_card_id === "string"
    ? (agent.metadata.model_card_id as string)
    : undefined;
  if (!cardId && !handle) return null;

  try {
    const card = cardId
      ? await modelCards.get({ tenantId, cardId })
      : await modelCards.findByModelId({ tenantId, modelId: handle });
    if (!card) return null;
    if (card.archived_at) {
      input.logger?.warn(
        { op: "claude_agent_sdk.model_card_archived", cardId: card.id },
        "model card is archived — falling back to global env provider",
      );
      return null;
    }
    const apiKey = await modelCards.getApiKey({ tenantId, cardId: card.id });
    if (!apiKey) {
      input.logger?.warn(
        { op: "claude_agent_sdk.model_card_key_unavailable", cardId: card.id },
        "model card key missing or undecryptable — falling back to global env provider",
      );
      return null;
    }
    return {
      model: card.model || handle,
      apiKey,
      baseUrl: card.base_url ?? undefined,
      apiCompat: providerToApiCompat(card.provider),
      source: card.id,
    };
  } catch (err) {
    input.logger?.warn(
      { op: "claude_agent_sdk.model_card_lookup_failed", err: err instanceof Error ? err.message : String(err) },
      "model card lookup failed — falling back to global env provider",
    );
    return null;
  }
}

// Synthetic inherited/platform-default model card. HTTP-only: never written
// to D1, so validateModel's empty-list → allow path stays intact. Surfaced
// on GET /v1/model_cards so `oma models list` has a model id to pass when
// the tenant has zero cards (issue #432 / #435).

import { DEFAULT_AGENT_MODEL } from "@duyet/oma-agents-store";
import {
  ANYROUTER_API_BASE,
  ANYROUTER_API_COMPAT,
  toGatewayModelId,
} from "@duyet/oma-anyrouter";

export const PLATFORM_DEFAULT_CARD_ID = "platform_default";

export interface ModelCardPlatformEnv {
  ANTHROPIC_API_KEY?: string;
  ANYROUTER_API_KEY?: string;
}

export interface PlatformDefaultCard {
  id: typeof PLATFORM_DEFAULT_CARD_ID;
  model_id: string;
  model: string;
  provider: string;
  api_key_preview?: string;
  base_url?: string;
  is_default: boolean;
  source: "platform";
  created_at: string;
  archived_at: null;
}

export function buildPlatformDefaultCard(opts: {
  hasTenantCards: boolean;
  platformEnv?: ModelCardPlatformEnv;
}): PlatformDefaultCard {
  const handle = DEFAULT_AGENT_MODEL;
  const anthropicKey = opts.platformEnv?.ANTHROPIC_API_KEY;
  const anyrouterKey = opts.platformEnv?.ANYROUTER_API_KEY;
  const useAnthropic = Boolean(anthropicKey);
  const useAnyrouter = !useAnthropic && Boolean(anyrouterKey);
  // Neither key visible on this process (hosted main worker has no
  // ANYROUTER_API_KEY binding): still advertise the gateway wire id —
  // that's the production env-credential fallback the agent worker uses.
  const provider = useAnthropic ? "ant" : ANYROUTER_API_COMPAT;
  const model = useAnthropic ? handle : toGatewayModelId(handle);
  return {
    id: PLATFORM_DEFAULT_CARD_ID,
    model_id: handle,
    model,
    provider,
    is_default: !opts.hasTenantCards,
    source: "platform",
    created_at: "2026-01-01T00:00:00.000Z",
    archived_at: null,
    ...(useAnyrouter ? { base_url: ANYROUTER_API_BASE } : {}),
  };
}

export function shouldInjectPlatformDefault(opts: {
  cursor?: string;
  q?: string;
  provider?: string;
  createdAfter?: number;
  createdBefore?: number;
  hasTenantCards: boolean;
  card: PlatformDefaultCard;
}): boolean {
  if (opts.hasTenantCards) return false;
  if (opts.cursor) return false;
  if (opts.createdAfter !== undefined || opts.createdBefore !== undefined) return false;
  if (opts.provider && opts.provider !== opts.card.provider) return false;
  if (opts.q) {
    const needle = opts.q.toLowerCase();
    const hay = `${opts.card.id} ${opts.card.model_id} ${opts.card.model}`.toLowerCase();
    if (!hay.includes(needle)) return false;
  }
  return true;
}

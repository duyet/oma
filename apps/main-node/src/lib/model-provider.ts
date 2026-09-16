import type { ApiCompat } from "@duyet/oma-agent/harness/provider";
import { selectHarnessName } from "./harness-select";
import {
  resolveAgentModelBinding,
  type ModelCardBinding,
  type ModelCardLookup,
} from "./claude-sdk-model";

/** Resolve the tenant's card before consulting deployment-wide credentials.
 *  All turn builders use this so model, tools and harness auth agree. */
export async function resolveAgentProvider(input: {
  modelCards: ModelCardLookup;
  tenantId: string;
  agent: {
    model: string | { id: string };
    metadata?: Record<string, unknown> | null;
  };
  env: Record<string, string | undefined>;
  activeProvider?: { apiKey: string; baseUrl: string; compat: ApiCompat } | null;
  logger?: {
    warn: (ctx: Record<string, unknown>, msg: string) => void;
    info?: (ctx: Record<string, unknown>, msg: string) => void;
  };
}): Promise<ModelCardBinding> {
  const binding = await resolveAgentModelBinding(input);
  if (binding) return binding;

  const { agent, env, activeProvider } = input;
  const model = typeof agent.model === "string" ? agent.model : agent.model.id;
  if (activeProvider) {
    return {
      model, apiKey: activeProvider.apiKey,
      baseUrl: activeProvider.baseUrl, apiCompat: activeProvider.compat,
    };
  }

  const apiCompat: ApiCompat = ["ant", "ant-compatible", "oai", "oai-compatible"].includes(env.OMA_API_COMPAT ?? "")
    ? env.OMA_API_COMPAT as ApiCompat
    : "ant";
  if (env.ANTHROPIC_API_KEY) {
    return {
      model, apiKey: env.ANTHROPIC_API_KEY, baseUrl: env.ANTHROPIC_BASE_URL,
      apiCompat, customHeaders: parseCustomHeaders(env.ANTHROPIC_CUSTOM_HEADERS),
    };
  }

  // These harnesses authenticate inside run() and do not consume ctx.model.
  const harness = selectHarnessName(agent.metadata?.harness, env.DEFAULT_HARNESS);
  if (harness === "claude-agent-sdk" && env.CLAUDE_CODE_OAUTH_TOKEN) {
    return { model, apiKey: "", baseUrl: env.ANTHROPIC_BASE_URL, apiCompat };
  }
  if (harness === "poolside" && env.POOLSIDE_API_KEY) {
    return { model, apiKey: "", apiCompat };
  }

  throw new Error(
    `No model card credentials resolved for model "${model}". Configure a model card for this agent, ` +
      "or set ANTHROPIC_API_KEY, connect AnyRouter via the Console, " +
      "set CLAUDE_CODE_OAUTH_TOKEN for a claude-agent-sdk agent, or POOLSIDE_API_KEY for a poolside agent.",
  );
}

function parseCustomHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [name, ...rest] = part.split(":");
    if (!name || rest.length === 0) continue;
    out[name.trim()] = rest.join(":").trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

// Default "General" agent seeded into every freshly created tenant so a
// new workspace isn't empty. Called exactly once, from the branch of the
// sign-up flow that just inserted a brand-new tenant row — see
// `ensureTenant` (apps/main/src/auth-config.ts, CF) and `ensureTenantSqlite`
// (packages/auth-config/src/index.ts, self-host Node). Both runtimes go
// through this same AgentService.create() call so the seeded agent's shape
// never drifts between deployments.

import type { AgentService, NewAgentInput } from "./service";
import type { AgentRow } from "./types";

/** Matches the built-in toolset type string used across the platform
 *  (agents.ts default, AGENTS.md examples). */
const DEFAULT_TOOLSET_TYPE = "agent_toolset_20260401";

/** Platform default model — kept in sync with the CLI's own default
 *  (packages/cli/src/index.ts). */
export const DEFAULT_AGENT_MODEL = "claude-sonnet-4-6";

export const DEFAULT_AGENT_INPUT: NewAgentInput = {
  name: "General",
  description: "A general-purpose assistant with the full built-in toolset.",
  model: DEFAULT_AGENT_MODEL,
  system:
    "You are a helpful, general-purpose assistant. Use your tools — bash, read, write, edit, glob, grep, web_fetch, and web_search — to answer questions, write and run code, and get things done accurately and efficiently.",
  tools: [{ type: DEFAULT_TOOLSET_TYPE }],
};

/**
 * Create the initial "General" agent for a freshly created tenant.
 * Returns the created row (existing callers only use it for logging).
 *
 * Idempotency is the CALLER's responsibility: this must only be invoked
 * from the code path that just inserted a brand-new tenant row (not on
 * every sign-in) — both `ensureTenant` and `ensureTenantSqlite` already
 * early-return before reaching their seed call when the tenant already
 * existed, so a tenant only ever gets this once.
 */
export async function seedDefaultAgent(
  agents: AgentService,
  tenantId: string,
): Promise<AgentRow> {
  return agents.create({ tenantId, input: DEFAULT_AGENT_INPUT });
}

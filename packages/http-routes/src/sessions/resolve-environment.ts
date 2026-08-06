/**
 * Session environment resolution — see docs/sandbox-runtime-selection.md.
 *
 * Launch-time selection is authoritative. Explicit body.environment_id wins;
 * otherwise agent.metadata.default_environment_id is used. The model never
 * re-picks a provider mid-turn.
 */

/** Agent metadata key holding the environment new sessions should default to. */
export const DEFAULT_ENV_METADATA_KEY = "default_environment_id";

export type EnvironmentIdSource = "body" | "agent_default" | "none";

/**
 * Read a non-empty default environment id from agent metadata.
 * Returns null when missing, wrong type, or blank.
 */
export function defaultEnvironmentIdFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): string | null {
  if (!metadata || typeof metadata !== "object") return null;
  const v = metadata[DEFAULT_ENV_METADATA_KEY];
  if (typeof v !== "string") return null;
  const id = v.trim();
  return id.length > 0 ? id : null;
}

/**
 * Resolve which environment id a session create should use.
 * Body always wins over the agent default (caller override).
 */
export function resolveSessionEnvironmentId(input: {
  bodyEnvironmentId?: string | null;
  agentMetadata?: Record<string, unknown> | null;
}): { environmentId: string | null; source: EnvironmentIdSource } {
  const body =
    typeof input.bodyEnvironmentId === "string" ? input.bodyEnvironmentId.trim() : "";
  if (body) return { environmentId: body, source: "body" };
  const fromAgent = defaultEnvironmentIdFromMetadata(input.agentMetadata);
  if (fromAgent) return { environmentId: fromAgent, source: "agent_default" };
  return { environmentId: null, source: "none" };
}

/**
 * Validate agent.metadata.default_environment_id when present.
 * - non-string → 422
 * - missing / wrong tenant → 422
 * - archived → 422
 * - empty string / nullish key → ok (cleared)
 *
 * When `environments` is unavailable (tests without the store), only the
 * type check runs so create/update still works offline.
 */
export async function validateDefaultEnvironmentMetadata(input: {
  tenantId: string;
  metadata: Record<string, unknown> | null | undefined;
  getEnvironment?: (opts: {
    tenantId: string;
    environmentId: string;
  }) => Promise<{ id: string; archived_at?: string | null } | null>;
}): Promise<{ ok: true } | { ok: false; error: string; status: 422 }> {
  if (input.metadata === undefined || input.metadata === null) return { ok: true };
  if (typeof input.metadata !== "object" || Array.isArray(input.metadata)) {
    return { ok: true }; // other validators own "must be object"
  }
  if (!Object.prototype.hasOwnProperty.call(input.metadata, DEFAULT_ENV_METADATA_KEY)) {
    return { ok: true };
  }
  const raw = input.metadata[DEFAULT_ENV_METADATA_KEY];
  // Explicit null/empty clears the preference.
  if (raw === null || raw === undefined || raw === "") return { ok: true };
  if (typeof raw !== "string") {
    return {
      ok: false,
      status: 422,
      error: "metadata.default_environment_id must be a string environment id",
    };
  }
  const id = raw.trim();
  if (!id) return { ok: true };
  if (!input.getEnvironment) return { ok: true };
  const env = await input.getEnvironment({
    tenantId: input.tenantId,
    environmentId: id,
  });
  if (!env) {
    return {
      ok: false,
      status: 422,
      error: `metadata.default_environment_id "${id}" is not a valid environment for this tenant`,
    };
  }
  if (env.archived_at) {
    return {
      ok: false,
      status: 422,
      error: `metadata.default_environment_id "${id}" is archived — pick an active environment`,
    };
  }
  return { ok: true };
}

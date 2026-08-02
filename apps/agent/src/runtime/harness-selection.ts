// Which HarnessInterface a turn runs under. Extracted from session-do.ts as a
// pure decision so it is unit-testable without a Durable Object (same pattern
// as resolve-sub-agent-sandbox).

import type { EnvironmentConfig } from "@duyet/oma-api-types";

/**
 * Harness-to-environment migration: which HarnessInterface a turn runs
 * under is now selected from the session's (or sub-agent turn's)
 * environment, not `agent.harness` (removed from AgentConfig). Formula
 * (AGENTS.md):
 *   harness = env.kind === "local" ? "acp-proxy" : (env.config.harness ?? "default")
 * `kind: "local"` is never independently overridable by `config.harness` —
 * the ACP proxy loop is implied. A missing environment snapshot (legacy
 * sessions created before this migration, or test fixtures) defaults to
 * the unchanged pre-migration behavior: "default".
 */
export function resolveHarnessNameForEnvironment(
  env: EnvironmentConfig | null | undefined,
): string {
  if (env?.config?.kind === "local") return "acp-proxy";
  // Federated environments (issue #132 M1): the whole session is proxied to
  // another OMA instance, so — like `kind: "local"` — the harness is implied
  // by the environment and `config.harness` is ignored.
  if (env?.config?.sandbox_provider === "oma-remote") return "oma-remote";
  return env?.config?.harness ?? "default";
}

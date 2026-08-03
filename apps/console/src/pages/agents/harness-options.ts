/**
 * Harness catalog for the agent create/edit dialog.
 *
 * A harness is the loop implementation that drives a turn — think of it as a
 * runtime template: *what* drives the model loop, *where* it runs, and what
 * it's good at. Names here must match the ids registered with
 * `registerHarness()` (apps/agent/src/index.ts for the Cloudflare deployment;
 * apps/main-node/src/index.ts additionally serves "claude-agent-sdk").
 *
 * `acp-proxy` is listed for orientation only — the dialog selects it through
 * the Cloud/Local segmented control (a runtime binding *is* the selection),
 * so its card flips the form into Local mode rather than writing
 * `_oma.harness` directly.
 */

/** Harness ids the cloud (non-local) picker can write to `form.harness`. */
export type CloudHarnessId = "claude-agent-sdk";

export interface HarnessOption {
  id: string;
  name: string;
  /** One-line "what it is". */
  summary: string;
  /** Where it can run. */
  badge: "Cloud + self-host" | "Self-host only" | "Local machine";
  /** Short "best for" hint. */
  bestFor: string;
  recommended?: boolean;
  /** Model id suggested when this harness is selected. */
  defaultModel?: string;
  /**
   * True when the per-agent `model` field only partly drives this harness —
   * the dialog explains inline how it is (and isn't) applied instead of
   * pretending it behaves like the standard harness.
   */
  modelCaveat?: boolean;
  /** Extra deployment requirement surfaced inline under the model field. */
  note?: string;
  /**
   * True for harness ids the picker no longer offers. Existing agents keep
   * their value — the card renders read-only so an edit never silently
   * rewrites the harness.
   */
  legacy?: boolean;
}

/** Harnesses that run inside OMA (selected by writing `_oma.harness`). */
export const CLOUD_HARNESS_OPTIONS: HarnessOption[] = [
  {
    id: "claude-agent-sdk",
    name: "Claude Agent SDK",
    summary: "Delegates the loop to the real Claude Code CLI, running in OMA's cloud.",
    badge: "Cloud + self-host",
    bestFor: "Best for the exact Claude Code experience, skills and all.",
    recommended: true,
    modelCaveat: true,
  },
];

/** Harnesses that run outside OMA, on a machine the user has paired. */
export const LOCAL_HARNESS_OPTIONS: HarnessOption[] = [
  {
    id: "acp-proxy",
    name: "ACP Runtime",
    summary: "Runs the loop on your own machine via `oma bridge` — Claude Code, Codex, any ACP agent.",
    badge: "Local machine",
    bestFor: "Best for working against local checkouts and local tooling.",
  },
];

/**
 * Harnesses that are still registered server-side but are no longer offered in
 * the picker. Kept so an existing agent's value renders with a real label.
 */
export const LEGACY_HARNESS_OPTIONS: HarnessOption[] = [
  {
    id: "default",
    name: "Standard",
    summary: "OMA's built-in tool loop, running in the platform sandbox.",
    badge: "Cloud + self-host",
    bestFor: "Kept for existing agents.",
    defaultModel: "claude-sonnet-4-6",
    legacy: true,
  },
  {
    id: "long-running",
    name: "Long-running",
    summary: "The same tool loop, plus structured progress heartbeats.",
    badge: "Cloud + self-host",
    bestFor: "Kept for existing agents.",
    defaultModel: "claude-sonnet-4-6",
    legacy: true,
  },
  {
    id: "poolside",
    name: "Poolside",
    summary:
      "The standard tool loop on poolside's agentic coding models (laguna/malibu), via their OpenAI-compatible API.",
    badge: "Cloud + self-host",
    bestFor: "Kept for existing agents.",
    defaultModel: "poolside/laguna-s-2.1",
    note: "Requires POOLSIDE_API_KEY configured on the deployment.",
    legacy: true,
  },
];

export function harnessOption(id: string): HarnessOption | undefined {
  return [...CLOUD_HARNESS_OPTIONS, ...LOCAL_HARNESS_OPTIONS, ...LEGACY_HARNESS_OPTIONS].find(
    (h) => h.id === id,
  );
}

/** A card for an unrecognised harness value, so editing never loses it. */
export function legacyHarnessOption(id: string): HarnessOption {
  return (
    harnessOption(id) ?? {
      id,
      name: id,
      summary: "Configured outside the console.",
      badge: "Cloud + self-host",
      bestFor: "Kept for existing agents.",
      legacy: true,
    }
  );
}

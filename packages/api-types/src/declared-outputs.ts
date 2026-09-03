import type { SessionDeclaredOutput } from "./types";

/**
 * Derive `GET /v1/sessions/:id` `outputs[]` from the event log.
 * No new table: every `agent.output_declared` row becomes one entry, in
 * log order. Inline `data` is left on the event and never copied here.
 */
export function declaredOutputsFromEvents(
  events: readonly unknown[],
): SessionDeclaredOutput[] {
  const out: SessionDeclaredOutput[] = [];
  for (const raw of events) {
    if (!raw || typeof raw !== "object") continue;
    const e = raw as Record<string, unknown>;
    if (e.type !== "agent.output_declared") continue;
    if (typeof e.path !== "string" || e.path.length === 0) continue;
    if (typeof e.tool_use_id !== "string" || e.tool_use_id.length === 0) continue;

    const item: SessionDeclaredOutput = {
      path: e.path,
      tool_use_id: e.tool_use_id,
    };
    if (typeof e.description === "string" && e.description.length > 0) {
      item.description = e.description;
    }
    if (typeof e.media_type === "string" && e.media_type.length > 0) {
      item.media_type = e.media_type;
    }
    if (typeof e.size_bytes === "number" && Number.isFinite(e.size_bytes) && e.size_bytes >= 0) {
      item.size_bytes = e.size_bytes;
    }
    if (typeof e.sha256 === "string" && e.sha256.length > 0) {
      item.sha256 = e.sha256;
    }
    const declaredAt =
      (typeof e.processed_at === "string" && e.processed_at) ||
      (typeof e.ts === "string" && e.ts) ||
      undefined;
    if (declaredAt) item.declared_at = declaredAt;
    out.push(item);
  }
  return out;
}

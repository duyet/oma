import type { AgentOutputDeclaredEvent, ContentBlock, SessionEvent } from "@duyet/oma-shared";

/**
 * Build `agent.output_declared` from an `output_file` tool result.
 * Returns null when the call failed (`Error: …`) or the result has no path.
 *
 * Inline `data` is taken from the original tool input (not the model-facing
 * result string) so the event log can recover the payload without stuffing
 * base64 into the tool result the model sees.
 */
export function parseOutputFileDeclaration(
  toolCallId: string,
  content: string | ContentBlock[],
  input?: Record<string, unknown>,
): AgentOutputDeclaredEvent | null {
  if (!toolCallId) return null;
  const text = contentToText(content);
  if (text.startsWith("Error:")) return null;

  const fromResult = parseResultJson(text);
  const path = firstString(
    fromResult?.path,
    input?.path,
    filenameToPath(input?.filename),
  );
  if (!path) return null;

  const event: AgentOutputDeclaredEvent = {
    type: "agent.output_declared",
    path,
    tool_use_id: toolCallId,
    parent_event_id: toolCallId,
  };

  const description = firstString(fromResult?.description, input?.description);
  if (description) event.description = description;

  const mediaType = firstString(fromResult?.media_type, input?.media_type);
  if (mediaType) event.media_type = mediaType;

  const size = firstNumber(fromResult?.size_bytes);
  if (size !== undefined) event.size_bytes = size;

  const sha = firstString(fromResult?.sha256);
  if (sha) event.sha256 = sha;

  const data = firstString(input?.data);
  if (data) event.data = data;

  return event;
}

/** Emit `agent.output_declared` after a successful `output_file` tool result. */
export function maybeBroadcastOutputDeclared(
  broadcast: (event: SessionEvent) => void,
  toolName: string,
  toolCallId: string,
  content: string | ContentBlock[],
  input?: Record<string, unknown>,
): void {
  if (toolName !== "output_file") return;
  const event = parseOutputFileDeclaration(toolCallId, content, input);
  if (event) broadcast(event);
}

function contentToText(content: string | ContentBlock[]): string {
  if (typeof content === "string") return content;
  return content
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("");
}

function parseResultJson(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function filenameToPath(filename: unknown): string | undefined {
  if (typeof filename !== "string" || filename.length === 0) return undefined;
  return `/mnt/session/outputs/${filename}`;
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  }
  return undefined;
}

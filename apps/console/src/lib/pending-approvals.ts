import type { Event } from "./events"

export interface PendingApproval {
  toolUseId: string
  toolName: string
  input: Record<string, unknown>
  sessionThreadId: string
}

const USE_TYPES = new Set([
  "agent.tool_use",
  "agent.custom_tool_use",
  "agent.mcp_tool_use",
])

function resultKey(event: Event): string | undefined {
  if (event.type === "agent.tool_result") return event.tool_use_id
  if (event.type === "agent.mcp_tool_result") {
    return event.mcp_tool_use_id ?? event.tool_use_id
  }
  if (event.type === "user.tool_confirmation") return event.tool_use_id
  return undefined
}

function lastIdle(events: Event[]): Event | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === "session.status_idle") return events[i]
  }
  return undefined
}

/**
 * Tool calls waiting on `user.tool_confirmation`. Custom-tool pauses
 * (`action_type: "custom_tool_result"`) are a different client payload
 * and stay out of this list.
 */
export function derivePendingApprovals(events: Event[]): PendingApproval[] {
  const idle = lastIdle(events)
  const stop = idle?.stop_reason as
    | { type?: string; action_type?: string }
    | undefined
  const waitingOnConfirm =
    stop?.type === "requires_action" && stop.action_type !== "custom_tool_result"

  const resolved = new Set<string>()
  for (const event of events) {
    const key = resultKey(event)
    if (key) resolved.add(key)
  }

  const pending: PendingApproval[] = []
  for (const event of events) {
    if (!USE_TYPES.has(event.type)) continue
    const id = event.id
    if (!id || resolved.has(id)) continue
    const asked = (event as { evaluated_permission?: string }).evaluated_permission === "ask"
    if (!asked && !waitingOnConfirm) continue
    if (event.type === "agent.custom_tool_use" && !asked) continue
    pending.push({
      toolUseId: id,
      toolName: event.name ?? "tool",
      input: (event.input ?? {}) as Record<string, unknown>,
      sessionThreadId:
        (event as { session_thread_id?: string }).session_thread_id ?? "sthr_primary",
    })
  }
  return pending
}

export function previewToolInput(input: Record<string, unknown> | undefined): string {
  if (!input) return ""
  const keys = Object.keys(input)
  if (keys.length === 1 && typeof input[keys[0]] === "string") {
    const value = input[keys[0]] as string
    return value.length > 280 ? `${value.slice(0, 280)}…` : value
  }
  const json = JSON.stringify(input)
  return json.length > 280 ? `${json.slice(0, 280)}…` : json
}

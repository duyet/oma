import { describe, expect, it } from "vitest"

import type { Event } from "./events"
import { derivePendingApprovals, previewToolInput } from "./pending-approvals"

function ev(type: string, extra: Record<string, unknown> = {}): Event {
  return { type, ...extra } as Event
}

describe("derivePendingApprovals", () => {
  it("returns unpaired always_ask tool_use events after requires_action idle", () => {
    const pending = derivePendingApprovals([
      ev("agent.tool_use", {
        id: "call_1",
        name: "bash",
        input: { command: "rm -rf /workspace/build" },
        evaluated_permission: "ask",
      }),
      ev("session.status_idle", {
        stop_reason: { type: "requires_action", action_type: "tool_confirmation" },
      }),
    ])
    expect(pending).toEqual([
      {
        toolUseId: "call_1",
        toolName: "bash",
        input: { command: "rm -rf /workspace/build" },
        sessionThreadId: "sthr_primary",
      },
    ])
  })

  it("drops a call once user.tool_confirmation lands", () => {
    expect(
      derivePendingApprovals([
        ev("agent.tool_use", {
          id: "call_1",
          name: "bash",
          input: { command: "ls" },
          evaluated_permission: "ask",
        }),
        ev("session.status_idle", {
          stop_reason: { type: "requires_action", action_type: "tool_confirmation" },
        }),
        ev("user.tool_confirmation", { tool_use_id: "call_1", result: "allow" }),
      ]),
    ).toEqual([])
  })

  it("drops a call once agent.tool_result lands", () => {
    expect(
      derivePendingApprovals([
        ev("agent.tool_use", {
          id: "call_1",
          name: "bash",
          input: { command: "ls" },
          evaluated_permission: "ask",
        }),
        ev("agent.tool_result", { tool_use_id: "call_1", content: "ok" }),
        ev("session.status_idle", { stop_reason: { type: "end_turn" } }),
      ]),
    ).toEqual([])
  })

  it("ignores custom_tool_result pauses", () => {
    expect(
      derivePendingApprovals([
        ev("agent.custom_tool_use", {
          id: "call_custom",
          name: "send_email",
          input: { to: "ops@example.com" },
        }),
        ev("session.status_idle", {
          stop_reason: { type: "requires_action", action_type: "custom_tool_result" },
        }),
      ]),
    ).toEqual([])
  })

  it("keeps evaluated_permission=ask even without an idle event yet", () => {
    expect(
      derivePendingApprovals([
        ev("agent.tool_use", {
          id: "call_1",
          name: "bash",
          input: { command: "pwd" },
          evaluated_permission: "ask",
        }),
      ]),
    ).toHaveLength(1)
  })
})

describe("previewToolInput", () => {
  it("shows a single string arg inline", () => {
    expect(previewToolInput({ command: "pwd" })).toBe("pwd")
  })

  it("stringifies objects and truncates", () => {
    const long = "x".repeat(400)
    const preview = previewToolInput({ command: long })
    expect(preview.endsWith("…")).toBe(true)
    expect(preview.length).toBe(281)
  })
})

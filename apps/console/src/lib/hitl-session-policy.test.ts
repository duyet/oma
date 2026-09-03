import { describe, expect, it, beforeEach } from "vitest"

import { allowToolThisSession, isToolAllowedThisSession } from "./hitl-session-policy"

describe("hitl session allowlist", () => {
  beforeEach(() => {
    sessionStorage.clear()
  })

  it("starts empty and remembers a tool name for this session only", () => {
    expect(isToolAllowedThisSession("sess_1", "bash")).toBe(false)
    allowToolThisSession("sess_1", "bash")
    expect(isToolAllowedThisSession("sess_1", "bash")).toBe(true)
    expect(isToolAllowedThisSession("sess_1", "edit")).toBe(false)
    expect(isToolAllowedThisSession("sess_2", "bash")).toBe(false)
  })
})

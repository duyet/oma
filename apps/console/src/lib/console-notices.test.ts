import { describe, expect, it } from "vitest"

import {
  loadNotices,
  markAllNoticesRead,
  NOTICE_WINDOW_MS,
  pruneNotices,
  unreadNoticeCount,
  upsertNotice,
  type ConsoleNotice,
} from "./console-notices"

function notice(partial: Partial<ConsoleNotice> = {}): ConsoleNotice {
  return {
    id: "approval:sess_1",
    kind: "approval",
    sessionId: "sess_1",
    title: "Approval required",
    body: "bash on sess_1",
    href: "/sessions/sess_1",
    createdAt: 1_000,
    read: false,
    ...partial,
  }
}

describe("console notices", () => {
  it("dedupes by session + kind, keeping the newest body", () => {
    const first = upsertNotice([], {
      kind: "approval",
      sessionId: "sess_1",
      title: "Approval required",
      body: "bash",
      href: "/sessions/sess_1",
      createdAt: 1,
    })
    const next = upsertNotice(first, {
      kind: "approval",
      sessionId: "sess_1",
      title: "Approval required",
      body: "edit",
      href: "/sessions/sess_1",
      createdAt: 2,
    })
    expect(next).toHaveLength(1)
    expect(next[0].body).toBe("edit")
  })

  it("drops notices older than 24h", () => {
    const now = NOTICE_WINDOW_MS + 50
    expect(
      pruneNotices(
        [notice({ createdAt: 0 }), notice({ id: "error:sess_1", kind: "error", createdAt: now })],
        now,
      ),
    ).toEqual([notice({ id: "error:sess_1", kind: "error", createdAt: now })])
  })

  it("counts unread and marks the list read", () => {
    const list = [notice(), notice({ id: "error:sess_2", kind: "error", sessionId: "sess_2", read: true })]
    expect(unreadNoticeCount(list)).toBe(1)
    expect(unreadNoticeCount(markAllNoticesRead(list))).toBe(0)
  })

  it("loads a persisted window and skips junk", () => {
    const raw = JSON.stringify([
      notice({ createdAt: 10 }),
      { nope: true },
      notice({ id: "completion:sess_9", kind: "completion", sessionId: "sess_9", createdAt: 11 }),
    ])
    const loaded = loadNotices(raw, 20)
    expect(loaded.map((n) => n.id)).toEqual(["approval:sess_1", "completion:sess_9"])
  })
})

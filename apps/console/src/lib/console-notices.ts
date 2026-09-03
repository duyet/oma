export type ConsoleNoticeKind = "approval" | "completion" | "error"

export interface ConsoleNotice {
  id: string
  kind: ConsoleNoticeKind
  sessionId: string
  title: string
  body: string
  href: string
  createdAt: number
  read: boolean
}

export const NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000
export const NOTICE_STORAGE_KEY = "oma.console.notifications"

export function noticeDedupeId(kind: ConsoleNoticeKind, sessionId: string): string {
  return `${kind}:${sessionId}`
}

export function pruneNotices(notices: ConsoleNotice[], now: number): ConsoleNotice[] {
  const cutoff = now - NOTICE_WINDOW_MS
  return notices.filter((n) => n.createdAt >= cutoff)
}

export function upsertNotice(
  notices: ConsoleNotice[],
  next: Omit<ConsoleNotice, "id" | "read"> & { id?: string; read?: boolean },
  now = Date.now(),
): ConsoleNotice[] {
  const id = next.id ?? noticeDedupeId(next.kind, next.sessionId)
  const pruned = pruneNotices(notices, now)
  const rest = pruned.filter((n) => n.id !== id)
  return [
    {
      id,
      kind: next.kind,
      sessionId: next.sessionId,
      title: next.title,
      body: next.body,
      href: next.href,
      createdAt: next.createdAt,
      read: next.read ?? false,
    },
    ...rest,
  ].sort((a, b) => b.createdAt - a.createdAt)
}

export function dismissNotice(notices: ConsoleNotice[], id: string): ConsoleNotice[] {
  return notices.filter((n) => n.id !== id)
}

export function markAllNoticesRead(notices: ConsoleNotice[]): ConsoleNotice[] {
  return notices.map((n) => (n.read ? n : { ...n, read: true }))
}

export function unreadNoticeCount(notices: ConsoleNotice[]): number {
  return notices.reduce((n, item) => n + (item.read ? 0 : 1), 0)
}

export function loadNotices(raw: string | null, now = Date.now()): ConsoleNotice[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const notices: ConsoleNotice[] = []
    for (const item of parsed) {
      if (!item || typeof item !== "object") continue
      const row = item as Partial<ConsoleNotice>
      if (
        typeof row.id !== "string" ||
        typeof row.sessionId !== "string" ||
        typeof row.title !== "string" ||
        typeof row.body !== "string" ||
        typeof row.href !== "string" ||
        typeof row.createdAt !== "number"
      ) {
        continue
      }
      if (row.kind !== "approval" && row.kind !== "completion" && row.kind !== "error") {
        continue
      }
      notices.push({
        id: row.id,
        kind: row.kind,
        sessionId: row.sessionId,
        title: row.title,
        body: row.body,
        href: row.href,
        createdAt: row.createdAt,
        read: Boolean(row.read),
      })
    }
    return pruneNotices(notices, now)
  } catch {
    return []
  }
}

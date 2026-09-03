const storageKey = (sessionId: string) => `oma.hitl.allow:${sessionId}`

function readList(sessionId: string): string[] {
  try {
    const raw = sessionStorage.getItem(storageKey(sessionId))
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : []
  } catch {
    return []
  }
}

function writeList(sessionId: string, names: string[]): void {
  try {
    sessionStorage.setItem(storageKey(sessionId), JSON.stringify(names))
  } catch {
    /* private mode */
  }
}

export function isToolAllowedThisSession(sessionId: string, toolName: string): boolean {
  return readList(sessionId).includes(toolName)
}

export function allowToolThisSession(sessionId: string, toolName: string): void {
  const current = readList(sessionId)
  if (current.includes(toolName)) return
  writeList(sessionId, [...current, toolName])
}

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useNavigate } from "react-router"
import { BellIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { formatRelative } from "@/lib/format"
import {
  loadNotices,
  markAllNoticesRead,
  NOTICE_STORAGE_KEY,
  unreadNoticeCount,
  upsertNotice,
  type ConsoleNotice,
  type ConsoleNoticeKind,
} from "@/lib/console-notices"

const DESKTOP_ALERTS_KEY = "oma.console.desktop-alerts"

interface NoticeContextValue {
  notices: ConsoleNotice[]
  publish: (notice: Omit<ConsoleNotice, "id" | "read"> & { id?: string; read?: boolean }) => void
  markAllRead: () => void
  desktopAlerts: boolean
  setDesktopAlerts: (on: boolean) => void
}

const NoticeContext = createContext<NoticeContextValue | null>(null)

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [notices, setNotices] = useState<ConsoleNotice[]>(() => {
    try {
      return loadNotices(localStorage.getItem(NOTICE_STORAGE_KEY))
    } catch {
      return []
    }
  })
  const [desktopAlerts, setDesktopAlertsState] = useState(() => {
    try {
      return localStorage.getItem(DESKTOP_ALERTS_KEY) === "on"
    } catch {
      return false
    }
  })

  const persist = useCallback((next: ConsoleNotice[]) => {
    try {
      localStorage.setItem(NOTICE_STORAGE_KEY, JSON.stringify(next))
    } catch {
      /* private mode */
    }
    return next
  }, [])

  const publish = useCallback<NoticeContextValue["publish"]>((notice) => {
    setNotices((prev) => persist(upsertNotice(prev, notice)))
  }, [persist])

  const markAllRead = useCallback(() => {
    setNotices((prev) => persist(markAllNoticesRead(prev)))
  }, [persist])

  const setDesktopAlerts = useCallback((on: boolean) => {
    setDesktopAlertsState(on)
    try {
      localStorage.setItem(DESKTOP_ALERTS_KEY, on ? "on" : "off")
    } catch {
      /* private mode */
    }
  }, [])

  const notifiedRef = useRef(new Set<string>())
  useEffect(() => {
    if (!desktopAlerts) return
    if (typeof Notification === "undefined") return
    if (Notification.permission !== "granted") return
    if (typeof document !== "undefined" && document.visibilityState !== "hidden") return
    for (const notice of notices) {
      if (notice.read || notice.kind !== "approval") continue
      if (notifiedRef.current.has(notice.id)) continue
      notifiedRef.current.add(notice.id)
      try {
        new Notification(notice.title, { body: notice.body, tag: notice.id })
      } catch {
        /* unsupported */
      }
    }
  }, [desktopAlerts, notices])

  const value = useMemo(
    () => ({ notices, publish, markAllRead, desktopAlerts, setDesktopAlerts }),
    [notices, publish, markAllRead, desktopAlerts, setDesktopAlerts],
  )

  return <NoticeContext.Provider value={value}>{children}</NoticeContext.Provider>
}

export function useConsoleNotices(): NoticeContextValue {
  const ctx = useContext(NoticeContext)
  if (!ctx) {
    return {
      notices: [],
      publish: () => {},
      markAllRead: () => {},
      desktopAlerts: false,
      setDesktopAlerts: () => {},
    }
  }
  return ctx
}

function kindLabel(kind: ConsoleNoticeKind): string {
  switch (kind) {
    case "approval":
      return "Needs approval"
    case "error":
      return "Session error"
    case "completion":
      return "Session finished"
    default: {
      const _exhaustive: never = kind
      return _exhaustive
    }
  }
}

export function NotificationBell() {
  const nav = useNavigate()
  const { notices, markAllRead, desktopAlerts, setDesktopAlerts } = useConsoleNotices()
  const unread = unreadNoticeCount(notices)

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (open) markAllRead()
      }}
    >
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <BellIcon />
          {unread > 0 ? (
            <span className="absolute top-1 right-1 size-1.5 rounded-full bg-danger" aria-hidden />
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {notices.length === 0 ? (
          <div className="px-2 py-6 text-center text-sm text-muted-foreground">
            No session alerts in the last 24 hours.
          </div>
        ) : (
          notices.map((notice) => (
            <DropdownMenuItem
              key={notice.id}
              className="flex flex-col items-start gap-0.5 py-2"
              onSelect={() => nav(notice.href)}
            >
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {kindLabel(notice.kind)}
              </span>
              <span className="text-sm text-foreground">{notice.title}</span>
              <span className="text-xs text-muted-foreground">{notice.body}</span>
              <span className="text-[11px] text-muted-foreground">
                {formatRelative(Date.now() - notice.createdAt)}
              </span>
            </DropdownMenuItem>
          ))
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault()
            if (desktopAlerts) {
              setDesktopAlerts(false)
              return
            }
            if (typeof Notification === "undefined") return
            void Notification.requestPermission().then((perm) => {
              setDesktopAlerts(perm === "granted")
            })
          }}
        >
          {desktopAlerts ? "Disable desktop alerts" : "Enable desktop alerts"}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

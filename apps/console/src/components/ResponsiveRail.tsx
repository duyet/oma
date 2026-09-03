import type { ReactNode } from "react"

import { cn } from "@/lib/utils"
import {
  Sheet,
  SheetContent,
  SheetTitle,
} from "@/components/ui/sheet"
import { railPresentation, useViewportMode } from "@/hooks/use-viewport-mode"

export function ResponsiveRail({
  open,
  onClose,
  title,
  label,
  desktopClassName,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  label: string
  desktopClassName: string
  children: ReactNode
}) {
  const presentation = railPresentation(useViewportMode())
  if (!open) return null

  if (presentation.kind === "aside") {
    return (
      <aside className={desktopClassName} aria-label={label}>
        {children}
      </aside>
    )
  }

  return (
    <Sheet open onOpenChange={(next) => { if (!next) onClose() }}>
      <SheetContent
        side={presentation.side}
        showCloseButton={false}
        className={cn("p-0 gap-0", presentation.frameClass)}
      >
        <SheetTitle className="sr-only">{title}</SheetTitle>
        {presentation.side === "bottom" ? (
          <div className="flex justify-center pt-2 shrink-0" aria-hidden>
            <div className="h-1 w-10 rounded-full bg-border" />
          </div>
        ) : null}
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">{children}</div>
      </SheetContent>
    </Sheet>
  )
}

import * as React from "react"

import { MOBILE_BREAKPOINT } from "./use-mobile"

/** Upper bound of the tablet band. Desktop is this width and above. */
export const TABLET_MAX_BREAKPOINT = 1024

export type ViewportMode = "mobile" | "tablet" | "desktop"

function modeForWidth(width: number): ViewportMode {
  if (width < MOBILE_BREAKPOINT) return "mobile"
  if (width < TABLET_MAX_BREAKPOINT) return "tablet"
  return "desktop"
}

/**
 * Viewport band for Compact Console rails. `mobile` is <768, `tablet` is
 * 768–1023, `desktop` is ≥1024. Defaults to `desktop` until the first
 * layout read so SSR/jsdom first paint matches the existing `useIsMobile`
 * falsey start.
 */
export function useViewportMode(): ViewportMode {
  const [mode, setMode] = React.useState<ViewportMode>("desktop")

  React.useEffect(() => {
    const update = () => setMode(modeForWidth(window.innerWidth))
    update()
    const mobileMql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const tabletMql = window.matchMedia(`(max-width: ${TABLET_MAX_BREAKPOINT - 1}px)`)
    mobileMql.addEventListener("change", update)
    tabletMql.addEventListener("change", update)
    return () => {
      mobileMql.removeEventListener("change", update)
      tabletMql.removeEventListener("change", update)
    }
  }, [])

  return mode
}

export function railPresentation(mode: ViewportMode): RailPresentation {
  switch (mode) {
    case "desktop":
      return { kind: "aside" }
    case "tablet":
      return { kind: "sheet", side: "bottom", frameClass: "h-[60vh] max-h-[60vh]" }
    case "mobile":
      return {
        kind: "sheet",
        side: "right",
        frameClass: "inset-0 h-svh w-full max-w-none sm:max-w-none border-0",
      }
    default: {
      const _exhaustive: never = mode
      return _exhaustive
    }
  }
}

export type RailPresentation =
  | { kind: "aside" }
  | { kind: "sheet"; side: "bottom" | "right"; frameClass: string }

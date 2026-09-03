import { describe, expect, it } from "vitest"

import { MOBILE_BREAKPOINT } from "./use-mobile"
import { railPresentation, TABLET_MAX_BREAKPOINT, type ViewportMode } from "./use-viewport-mode"

describe("railPresentation", () => {
  it("keeps a desktop aside so the inspector stays a sibling column", () => {
    expect(railPresentation("desktop")).toEqual({ kind: "aside" })
  })

  it("opens a 60vh bottom sheet on tablet", () => {
    expect(railPresentation("tablet")).toEqual({
      kind: "sheet",
      side: "bottom",
      frameClass: "h-[60vh] max-h-[60vh]",
    })
  })

  it("opens a full-screen overlay on mobile", () => {
    const shown = railPresentation("mobile")
    expect(shown.kind).toBe("sheet")
    if (shown.kind !== "sheet") return
    expect(shown.side).toBe("right")
    expect(shown.frameClass).toContain("h-svh")
    expect(shown.frameClass).toContain("sm:max-w-none")
  })

  it("covers every ViewportMode without a default fallthrough", () => {
    const modes: ViewportMode[] = ["mobile", "tablet", "desktop"]
    for (const mode of modes) {
      expect(railPresentation(mode).kind).toMatch(/aside|sheet/)
    }
  })

  it("keeps the 768 / 1024 bands the issue named", () => {
    expect(MOBILE_BREAKPOINT).toBe(768)
    expect(TABLET_MAX_BREAKPOINT).toBe(1024)
  })
})

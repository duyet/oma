import { useMemo, useRef, useState } from "react";
import { Outlet, Navigate, useLocation, useNavigate } from "react-router";

import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";

import { useAuth } from "../lib/auth";
import { useChordKeybinding, type ChordBinding } from "../lib/useChordKeybinding";
import { ROUTE_CHORDS } from "../lib/route-chords";

import { AppSidebar } from "./AppSidebar";
import { AppBreadcrumb } from "./AppBreadcrumb";
import { BrandLoader } from "./BrandLoader";
import { CommandPalette } from "./CommandPalette";
import { NavigationProgress } from "./NavigationProgress";

/**
 * AppShell — sidebar + main outlet (anyrouter-aligned inset density).
 *
 *   ┌─sidebar──┬───────────────────────────┐
 *   │ brand    │ trigger + breadcrumb      │
 *   │ nav      ├───────────────────────────┤
 *   │ ...      │ rounded-2xl inset panel   │
 *   │ user     │  pageHeaderSlot           │
 *   │          │  <Outlet> (scrolls)       │
 *   └──────────┴───────────────────────────┘
 *
 * Sidebar uses `variant="inset"`; main content sits in `SidebarInset`
 * with rounded-2xl + shadow so the stage reads as a card on the sidebar
 * canvas — same seam as anyrouter's DashboardShell.
 *
 * PageHeader is portaled into a `shrink-0` slot ABOVE `<main>` (the
 * scroll context) — sticky by construction, no CSS positioning.
 */
export interface AppOutletContext {
  pageHeaderSlot: HTMLDivElement | null;
}

export function AppShell() {
  const { isAuthenticated, isLoading } = useAuth();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [pageHeaderSlot, setPageHeaderSlot] = useState<HTMLDivElement | null>(null);

  const chordBindings = useMemo<ChordBinding[]>(
    () =>
      Object.entries(ROUTE_CHORDS).map(([path, key]) => ({
        prefix: "g",
        key,
        handler: () => navigate(path),
        label: path,
      })),
    [navigate],
  );
  useChordKeybinding(chordBindings);

  const outletContext: AppOutletContext = useMemo(
    () => ({ pageHeaderSlot }),
    [pageHeaderSlot],
  );

  const mainRef = useRef<HTMLElement | null>(null);
  const [scrolled, setScrolled] = useState(false);
  useMemo(() => {
    void pathname;
  }, [pathname]);

  if (isLoading) {
    return (
      <div className="flex h-screen items-center justify-center bg-background">
        <BrandLoader size="lg" label="Loading session" />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return (
    <TooltipProvider delayDuration={250}>
      <SidebarProvider
        className="h-svh overflow-hidden"
        style={{
          "--sidebar-width": "14rem",
          "--sidebar-width-icon": "3.25rem",
        } as React.CSSProperties}
      >
        <NavigationProgress />
        <CommandPalette />

        {/* Autofill honeypot — Chrome/Safari ignore autoComplete="off"
            and fill the first plausible input. Sit a hidden username/
            password pair at the top of the authenticated DOM so the
            browser fills it instead of any real input below. */}
        <div
          aria-hidden="true"
          style={{
            position: "absolute",
            left: "-9999px",
            top: "-9999px",
            height: 0,
            width: 0,
            overflow: "hidden",
            pointerEvents: "none",
          }}
        >
          <input type="text" tabIndex={-1} autoComplete="username" name="username" />
          <input
            type="password"
            tabIndex={-1}
            autoComplete="current-password"
            name="password"
          />
        </div>

        <AppSidebar />

        <SidebarInset className="min-w-0 overflow-hidden bg-background">
          <header
            className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-background/90 px-3 backdrop-blur supports-[backdrop-filter]:bg-background/80"
            role="banner"
          >
            <SidebarTrigger className="text-muted-foreground hover:text-foreground" />
            <Separator orientation="vertical" className="mx-1 h-4" />
            <AppBreadcrumb />
          </header>

          <div
            ref={setPageHeaderSlot}
            role="region"
            aria-label="Page header"
            className={[
              "empty:hidden shrink-0 px-4 py-3 transition-[border-color] duration-150 md:px-6",
              scrolled ? "border-b border-border" : "border-b border-transparent",
            ].join(" ")}
          />
          <main
            ref={(el) => {
              mainRef.current = el;
              if (!el) {
                setScrolled(false);
                return;
              }
              const onScroll = () => setScrolled(el.scrollTop > 0);
              onScroll();
              el.addEventListener("scroll", onScroll, { passive: true });
            }}
            key={pathname}
            role="main"
            aria-label="Page content"
            className="flex-1 min-h-0 overflow-y-auto bg-background px-4 pb-5 pt-0 md:px-6 [scrollbar-gutter:stable] [&::-webkit-scrollbar]:hidden [scrollbar-width:none]"
          >
            <Outlet context={outletContext} />
          </main>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

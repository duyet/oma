import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { NavLink, Outlet, useLocation, useOutletContext } from "react-router";

import { cn } from "@/lib/utils";

import type { AppOutletContext } from "./AppShell";

/**
 * A single tab in a hub's tab strip. `path` is an absolute route
 * (e.g. `/environments`) so the same hub config works regardless of the
 * base path the layout is mounted under. `end` opts into exact matching
 * for the active state (default: active on the tab's nested paths too, so
 * a detail route keeps its parent tab highlighted).
 */
export interface HubTab {
  label: string;
  path: string;
  end?: boolean;
  /** Shown under the h1 while this tab is active; falls back to the hub's
   *  own description when unset. */
  description?: string;
}

export interface HubConfig {
  title: string;
  description: string;
  tabs: HubTab[];
}

/**
 * HubLayout — a tabbed hub page. Renders a page header (title +
 * description) and a tab strip of `NavLink`s, with the active tab's route
 * rendering below via `<Outlet/>`. Tabs are real nested routes, not
 * component state, so each tab has its own URL, deep-links, and history.
 *
 * The header is portaled into AppShell's frozen `pageHeaderSlot` (the
 * `shrink-0` band above the scroll container) so title + tabs stay pinned
 * while content scrolls — the same slot every `PageHeader` uses. Because
 * child pages (via `DataTable`/`PageHeader`) also portal their toolbar +
 * frozen table header into that slot, HubLayout hands children a *nested*
 * slot placed directly below the tab strip: it overrides the outlet
 * context's `pageHeaderSlot` with its own sub-slot. That guarantees the
 * vertical order title → tabs → child toolbar → content, all frozen.
 *
 * When no frozen slot exists (e.g. unit tests without AppShell), the
 * header renders inline instead so the hub still works standalone.
 */
export function HubLayout({ title, description, tabs }: HubConfig) {
  const parentCtx = useOutletContext<AppOutletContext | undefined>();
  // The h1 tracks the ACTIVE tab (e.g. "Vaults" on /vaults), not the hub's
  // umbrella name — longest path prefix wins so detail routes still match.
  const { pathname } = useLocation();
  const activeTab = tabs
    .filter((t) => pathname === t.path || pathname.startsWith(`${t.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const slot = parentCtx?.pageHeaderSlot ?? null;
  const [subSlot, setSubSlot] = useState<HTMLDivElement | null>(null);

  // Child pages read `pageHeaderSlot` from the outlet context and portal
  // their own PageHeader into it. Point them at our sub-slot so their
  // toolbar/table-header lands under the tab strip, not above it.
  const childContext = useMemo<AppOutletContext>(
    () => ({ pageHeaderSlot: subSlot }),
    [subSlot],
  );

  const header = (
    <div className="bg-background">
      <div className="pt-3">
        <h1 className="text-xl font-semibold tracking-tight truncate">{activeTab?.label ?? title}</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{activeTab?.description ?? description}</p>
      </div>
      <nav
        aria-label={`${title} sections`}
        className="mt-3 inline-flex h-8 w-fit items-center gap-1 overflow-x-auto rounded-lg bg-muted p-[3px] text-muted-foreground"
      >
        {tabs.map((tab) => (
          <NavLink
            key={tab.path}
            to={tab.path}
            end={tab.end}
            className={({ isActive }) =>
              cn(
                "relative inline-flex h-[calc(100%-1px)] items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-transparent px-2.5 text-sm font-medium transition-all",
                isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "text-foreground/60 hover:text-foreground",
              )
            }
          >
            {tab.label}
          </NavLink>
        ))}
      </nav>
      {/* Sub-slot for child PageHeaders — sits below the tab strip. */}
      <div ref={setSubSlot} />
    </div>
  );

  return (
    <>
      {slot ? createPortal(header, slot) : header}
      <Outlet context={childContext} />
    </>
  );
}

import type { ComponentType } from "react";
import { useMemo } from "react";
import { useEffect, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import {
  PlusIcon,
  ChevronRightIcon,
  SquareKanbanIcon,
  CircleCheckBigIcon,
  ChartColumnIcon,
  UsersIcon,
  BlocksIcon,
} from "lucide-react";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Button } from "@/components/ui/button";

import { TenantSwitcher } from "./TenantSwitcher";
import { Logo } from "./Logo";
import { UserProfile } from "./UserProfile";
import {
  AgentIcon,
  ApiKeysIcon,
  DashboardIcon,
  EnvIcon,
  FilesIcon,
  MemoryIcon,
  ModelCardsIcon,
  RuntimesIcon,
  SessionsIcon,
  SkillsIcon,
  VaultIcon,
} from "./icons";
import { consolePlugins } from "../plugins/registry";
import { useApiQuery } from "../lib/useApiQuery";
import { cn } from "@/lib/utils";
import { IntegrationsApi } from "../integrations/api/client";
import type {
  LinearInstallation,
  GitHubInstallation,
  SlackInstallation,
} from "../integrations/api/types";

/* ── Sidebar counters ──
 * Two cheap reads back every badge: `/v1/stats` (one covering-index
 * COUNT(*) per resource — never a "fetch every row and take .length")
 * and `/v1/runtimes`, which is the only thing carrying liveness rather
 * than a count. Both are ordinary `useApiQuery` calls, so the pages that
 * already read them (Dashboard, RuntimesList) share the same cache entry
 * instead of issuing a second fetch. */
interface SidebarStats {
  agents: number;
  sessions: number;
  environments: number;
  vaults: number;
  skills: number;
  model_cards: number;
  api_keys: number;
}

interface SidebarRuntime {
  status: "online" | "offline";
}

/** Which counter feeds an item's badge. Keys are stable ids rather than
 *  the route path so a route rename doesn't silently drop a badge. */
type BadgeKey =
  | "agents"
  | "sessions"
  | "environments"
  | "vaults"
  | "skills"
  | "model_cards"
  | "api_keys"
  | "runtimes";

interface NavItem {
  to: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  end?: boolean;
  badge?: BadgeKey;
  /** When set, renders a connection-status badge for the given integration
   *  provider (dot + count when at least one installation exists). "total"
   *  renders the aggregate count across every provider as a single badge
   *  on a hub-level item. */
  integrationStatus?: "linear" | "github" | "slack" | "total";
  /** Sub-destinations nested under this item, revealed via a chevron toggle
   *  next to the (still directly clickable) parent link. */
  children?: NavItem[];
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

interface IntegrationStatusMap {
  linear?: number;
  github?: number;
  slack?: number;
  /** Sum of all provider installation counts — shown on the collapsed
   *  "Integrations" hub item instead of per-provider rows. */
  total?: number;
}

/* ── Navigation — single source of truth for sidebar items ──
 * Every page gets its own item, filed under a labeled group, so the whole
 * surface is legible at rest rather than hidden one tab-click deep behind
 * a hub. The groups deliberately mirror the hub boundaries defined in
 * `main.tsx` (SESSIONS_HUB / RESOURCES_HUB / SETTINGS_HUB) — an item
 * deep-links straight to a tab, and the hub page still renders its own
 * tab strip, so the two navigations agree instead of describing different
 * structures. The Integrations hub (My Bots + Linear/GitHub/Slack, which
 * has no tab strip of its own) is filed under Resources here with an
 * aggregate count badge rather than a per-provider sub-menu, collapsing
 * three provider rows into one. Agents keeps a chevron sub-item (New
 * Agent) for its fast-path create flow. */
const navGroups: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { to: "/", label: "Overview", icon: DashboardIcon, end: true },
      {
        to: "/agents",
        label: "Agents",
        icon: AgentIcon,
        badge: "agents",
      },
      { to: "/sessions", label: "Sessions", icon: SessionsIcon, badge: "sessions" },
      { to: "/kanban", label: "Kanban Board", icon: SquareKanbanIcon },
      { to: "/usage", label: "Usage", icon: ChartColumnIcon },
    ],
  },
  {
    label: "Resources",
    items: [
      { to: "/environments", label: "Environments", icon: EnvIcon, badge: "environments" },
      { to: "/vaults", label: "Credential Vaults", icon: VaultIcon, badge: "vaults" },
      { to: "/memory", label: "Memory Stores", icon: MemoryIcon },
      { to: "/skills", label: "Skills", icon: SkillsIcon, badge: "skills" },
      { to: "/files", label: "Files", icon: FilesIcon },
      { to: "/model-cards", label: "Model Cards", icon: ModelCardsIcon, badge: "model_cards" },
      {
        to: "/integrations",
        label: "Integrations",
        icon: BlocksIcon,
        end: true,
        integrationStatus: "total",
      },
    ],
  },
  {
    label: "Advanced",
    items: [
      { to: "/members", label: "Members", icon: UsersIcon },
      { to: "/evals", label: "Eval Runs", icon: CircleCheckBigIcon },
      { to: "/api-keys", label: "API Keys", icon: ApiKeysIcon, badge: "api_keys" },
      { to: "/runtimes", label: "Sandbox Runtime", icon: RuntimesIcon, badge: "runtimes" },
    ],
  },
];

export function AppSidebar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();

  // Counts are decoration, never a gate: a failed/absent fetch just leaves
  // the badges off rather than erroring or toasting in the chrome. Runtimes
  // poll a little faster because their badge carries liveness, not a count
  // that only moves when the user creates something.
  const { data: stats } = useApiQuery<SidebarStats>("/v1/stats", undefined, {
    staleTime: 60_000,
  });
  const { data: runtimesRes } = useApiQuery<{ runtimes: SidebarRuntime[] }>(
    "/v1/runtimes",
    undefined,
    { staleTime: 30_000, refetchInterval: 60_000 },
  );

  // Integration installation counts for sidebar badges. Failed/absent fetches
  // leave the badges off; never errors the sidebar.
  const integrationsApi = useMemo(() => new IntegrationsApi(), []);
  const { data: linearInstalls } = useApiQuery<LinearInstallation[]>(
    "/v1/integrations/linear/installations",
    undefined,
    { staleTime: 60_000 },
  );
  const { data: githubInstalls } = useApiQuery<GitHubInstallation[]>(
    "/v1/integrations/github/installations",
    undefined,
    { staleTime: 60_000 },
  );
  const { data: slackInstalls } = useApiQuery<SlackInstallation[]>(
    "/v1/integrations/slack/installations",
    undefined,
    { staleTime: 60_000 },
  );
  const integrationStatus: IntegrationStatusMap = useMemo(
    () => {
      const linear = Array.isArray(linearInstalls) && linearInstalls.length ? linearInstalls.length : 0;
      const github = Array.isArray(githubInstalls) && githubInstalls.length ? githubInstalls.length : 0;
      const slack = Array.isArray(slackInstalls) && slackInstalls.length ? slackInstalls.length : 0;
      const total = linear + github + slack;
      return {
        ...(linear ? { linear } : {}),
        ...(github ? { github } : {}),
        ...(slack ? { slack } : {}),
        ...(total ? { total } : {}),
      };
    },
    [linearInstalls, githubInstalls, slackInstalls],
  );

  const runtimes = runtimesRes?.runtimes;
  const runtimesOnline = runtimes?.filter((r) => r.status === "online").length;

  // Renders the badge for an item, or null when the counter hasn't loaded
  // (or is zero — a "0" badge is visual noise, the empty page says it
  // better). Runtimes is the one status badge: a dot that goes green only
  // when at least one machine is actually attached.
  const renderBadge = (key: BadgeKey | undefined, providerKey?: "linear" | "github" | "slack" | "total") => {
    if (key === "runtimes") {
      if (runtimes === undefined || runtimes.length === 0) return null;
      return (
        <SidebarMenuBadge className="gap-1 text-fg-subtle">
          <span
            className={cn(
              "size-1.5 rounded-full",
              runtimesOnline ? "bg-success" : "bg-fg-subtle",
            )}
          />
          {runtimesOnline}/{runtimes.length}
        </SidebarMenuBadge>
      );
    }
    if (key && stats) {
      const count = stats?.[key];
      if (!count) return null;
      return <SidebarMenuBadge className="text-fg-subtle">{count}</SidebarMenuBadge>;
    }
    if (providerKey) {
      const count = integrationStatus[providerKey];
      if (count == null) return null;
      return (
        <SidebarMenuBadge className="gap-1 text-success">
          <span className="size-1.5 rounded-full bg-success" />
          {count}
        </SidebarMenuBadge>
      );
    }
    return null;
  };

  const matchesPrefix = (base: string) =>
    pathname === base || pathname.startsWith(`${base}/`);

  const isItemActive = (to: string, end?: boolean) => {
    if (end) return pathname === to;
    return matchesPrefix(to);
  };

  const itemHasActiveChild = (item: NavItem) =>
    item.children?.some((c) => isItemActive(c.to, c.end)) ?? false;

  // Item-level chevron submenus (Agents) default open when the current
  // route lives inside them, collapsed otherwise. A pathname-driven effect
  // re-expands whichever contains the active route on navigation (e.g. a
  // deep link) without re-collapsing anything the user opened by hand.
  const [openItems, setOpenItems] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      navGroups
        .flatMap((g) => g.items)
        .filter((item) => item.children)
        .map((item) => [item.to, itemHasActiveChild(item)]),
    ),
  );

  useEffect(() => {
    setOpenItems((prev) => {
      const next = { ...prev };
      for (const item of navGroups.flatMap((g) => g.items)) {
        if (item.children && itemHasActiveChild(item)) next[item.to] = true;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  const groups = [
    ...navGroups,
    ...consolePlugins.flatMap((p) => p.navGroups ?? []),
  ];

  const renderItem = (item: NavItem) => {
    const active = isItemActive(item.to, item.end);
    const hasChildren = !!item.children?.length;

    const button = (
      <SidebarMenuButton
        asChild
        isActive={active}
        tooltip={item.label}
        className={
          active
            ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium"
            : "!bg-transparent hover:!bg-sidebar-accent/50 !text-sidebar-foreground hover:!text-sidebar-foreground"
        }
      >
        <NavLink to={item.to} end={item.end}>
          <item.icon className="size-4 opacity-80" />
          <span>{item.label}</span>
        </NavLink>
      </SidebarMenuButton>
    );

    if (!hasChildren) {
      // The badge is absolutely positioned in the item's right slot — the
      // same slot the chevron would take — so items with children skip it
      // rather than stacking two things on top of each other.
      return (
        <SidebarMenuItem key={item.to}>
          {button}
          {(item.badge || item.integrationStatus) ? renderBadge(item.badge, item.integrationStatus) : null}
        </SidebarMenuItem>
      );
    }

    const isOpen = openItems[item.to] ?? false;

    return (
      <Collapsible
        key={item.to}
        open={isOpen}
        onOpenChange={(open) => setOpenItems((prev) => ({ ...prev, [item.to]: open }))}
        className="group"
      >
        <SidebarMenuItem>
          {button}
          <CollapsibleTrigger asChild>
            <SidebarMenuAction>
              <ChevronRightIcon className="transition-transform group-data-[state=open]:rotate-90" />
              <span className="sr-only">Toggle {item.label} submenu</span>
            </SidebarMenuAction>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <SidebarMenuSub>
              {item.children!.map((child) => {
                const childActive = isItemActive(child.to, child.end);
                return (
                  <SidebarMenuSubItem key={child.to}>
                    <SidebarMenuSubButton asChild isActive={childActive}>
                      <NavLink to={child.to} end={child.end}>
                        <child.icon className="size-4 opacity-80" />
                        <span>{child.label}</span>
                      </NavLink>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                );
              })}
            </SidebarMenuSub>
          </CollapsibleContent>
        </SidebarMenuItem>
      </Collapsible>
    );
  };

  const renderGroup = (g: NavGroup) => (
    <SidebarGroup key={g.label}>
      {g.label ? <SidebarGroupLabel>{g.label}</SidebarGroupLabel> : null}
      <SidebarMenu>{g.items.map(renderItem)}</SidebarMenu>
    </SidebarGroup>
  );

  return (
    <Sidebar
      collapsible="icon"
      className="bg-sidebar border-0 group-data-[side=left]:border-r-0"
    >
      <SidebarHeader className="bg-sidebar h-11 px-3 flex-row items-center gap-2">
        <Logo size="sm" />
        <span className="font-mono font-bold text-base text-brand group-data-[collapsible=icon]:hidden">
          oma
        </span>
      </SidebarHeader>

      <div className="mt-2">
        <TenantSwitcher />
      </div>

      {/* Quick action: New Agent — always visible, gets you started fast */}
      <div className="px-3 pt-3 pb-1 group-data-[collapsible=icon]:hidden">
        <Button
          onClick={() => navigate("/agents/new")}
          className="w-full gap-1.5 text-sm h-9"
          size="sm"
        >
          <PlusIcon className="size-4" />
          New Agent
        </Button>
      </div>

      <SidebarContent className="bg-sidebar [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
        {groups.map(renderGroup)}
      </SidebarContent>

      <SidebarFooter className="bg-sidebar p-0">
        <UserProfile />
      </SidebarFooter>
    </Sidebar>
  );
}

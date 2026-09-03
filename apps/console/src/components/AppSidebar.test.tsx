import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../mocks/server";
import { SidebarProvider } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppSidebar, buildNavGroups } from "./AppSidebar";

vi.mock("../lib/auth", () => ({
  useAuth: () => ({
    user: null,
    isLoading: false,
    isAuthenticated: false,
    authDisabled: false,
  }),
}));
vi.mock("./UserProfile", () => ({ UserProfile: () => null }));
vi.mock("./TenantSwitcher", () => ({ TenantSwitcher: () => <div /> }));

function mockSidebarDeps() {
  server.use(
    http.get("/v1/stats", () =>
      HttpResponse.json({
        agents: 1,
        sessions: 1,
        environments: 1,
        vaults: 0,
        skills: 0,
        model_cards: 0,
        api_keys: 0,
      }),
    ),
    http.get("/v1/runtimes", () => HttpResponse.json({ runtimes: [] })),
    ...[
      "/v1/integrations/linear/installations",
      "/v1/integrations/github/installations",
      "/v1/integrations/slack/installations",
    ].map((p) => http.get(p, () => HttpResponse.json([]))),
  );
}

function renderSidebar(path = "/") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <SidebarProvider>
          <TooltipProvider>
            <AppSidebar />
          </TooltipProvider>
        </SidebarProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("buildNavGroups", () => {
  it("puts Agents and Sessions first on the daily path", () => {
    const items = buildNavGroups()[0].items;
    expect(items.map((i) => i.label).slice(0, 2)).toEqual(["Agents", "Sessions"]);
    expect(items.map((i) => i.label)).toEqual([
      "Agents",
      "Sessions",
      "Overview",
      "Usage",
      "Analytics",
      "Resources",
      "Settings",
    ]);
  });

  it("nests resource pages under one Resources parent instead of top-level rows", () => {
    const items = buildNavGroups()[0].items;
    const topLevelHrefs = items.map((i) => i.to);
    for (const path of ["/environments", "/vaults", "/memory", "/skills", "/files"]) {
      // Parent Resources deep-links at /environments; the rest must not be
      // siblings on the daily path.
      if (path === "/environments") {
        expect(items.filter((i) => i.to === path).map((i) => i.label)).toEqual([
          "Resources",
        ]);
        continue;
      }
      expect(topLevelHrefs).not.toContain(path);
    }
    const resources = items.find((i) => i.label === "Resources");
    expect(resources?.children?.map((c) => c.label)).toEqual([
      "Environments",
      "Credential Vaults",
      "Memory Stores",
      "Skills",
      "Files",
      "Model Cards",
      "Integrations",
    ]);
  });

  it("does not put Launch on the sidebar", () => {
    const items = buildNavGroups()[0].items;
    expect(items.some((i) => i.to === "/launch" || i.label === "Launch")).toBe(
      false,
    );
    expect(
      items.flatMap((i) => i.children ?? []).some((c) => c.to === "/launch"),
    ).toBe(false);
  });
});

describe("<AppSidebar />", () => {
  beforeEach(() => {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });
  });
  it("shows the daily path and keeps resource pages behind Resources", async () => {
    mockSidebarDeps();
    renderSidebar();

    expect(await screen.findByTestId("sidebar-item-Agents")).toBeInTheDocument();
    expect(screen.getByTestId("sidebar-item-Sessions")).toBeInTheDocument();

    const daily = ["Agents", "Sessions", "Overview", "Usage", "Analytics", "Resources", "Settings"];
    const hrefs = daily.map((label) =>
      screen.getByTestId(`sidebar-item-${label}`).getAttribute("href"),
    );
    expect(hrefs).toEqual([
      "/agents",
      "/sessions",
      "/",
      "/usage",
      "/analytics",
      "/environments",
      "/members",
    ]);

    expect(screen.queryByRole("link", { name: "Launch" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Environments" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Credential Vaults" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Memory Stores" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Skills" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Files" })).toBeNull();

    await userEvent.click(
      screen.getByRole("button", { name: "Toggle Resources submenu" }),
    );

    expect(
      await screen.findByRole("link", { name: "Environments" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Credential Vaults" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Files" })).toBeInTheDocument();
  });

  it("expands Resources when the current route is a nested resource page", async () => {
    mockSidebarDeps();
    renderSidebar("/vaults");

    await waitFor(() => {
      expect(screen.getByRole("link", { name: "Credential Vaults" })).toBeInTheDocument();
    });
    expect(screen.getByRole("link", { name: "Environments" })).toBeInTheDocument();
  });
});

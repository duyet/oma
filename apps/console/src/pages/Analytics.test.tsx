import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { server } from "../mocks/server";
import { Analytics } from "./Analytics";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Analytics />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const fullUsage = {
  period: { days: 7, since: "2026-08-27T00:00:00.000Z" },
  total_active_seconds: 4 * 3600 + 32 * 60,
  total_sessions: 12,
  by_kind: [
    { kind: "sandbox_active_seconds", total: 4 * 3600 + 32 * 60 },
    { kind: "model_input_tokens", total: 1_000_000 },
    { kind: "model_output_tokens", total: 0 },
    { kind: "model_cache_read_tokens", total: 45_000 },
    { kind: "model_cache_creation_tokens", total: 12_000 },
    { kind: "model_reasoning_tokens", total: 3_000 },
  ],
  daily: [
    { date: "2026-07-15", active_seconds: 600, runs: 2 },
    { date: "2026-07-16", active_seconds: 1200, runs: 3 },
  ],
  by_agent: [
    {
      agent_id: "agent_1",
      agent_name: "Research Bot",
      total_active_seconds: 3600,
      total_sessions: 8,
      by_kind: [{ kind: "model_input_tokens", total: 800_000 }],
    },
    {
      agent_id: null,
      agent_name: null,
      total_active_seconds: 1920,
      total_sessions: 4,
      by_kind: [{ kind: "model_input_tokens", total: 200_000 }],
    },
  ],
};

const emptyUsage = {
  period: { days: 7, since: null },
  total_active_seconds: 0,
  total_sessions: 0,
  by_kind: [],
  daily: [],
  by_agent: [],
};

const agentsFixture = {
  data: [
    {
      id: "agent_1",
      name: "Lead",
      multiagent: {
        type: "coordinator",
        agents: [{ type: "agent", id: "agent_2", version: 1 }],
      },
    },
    { id: "agent_2", name: "Researcher" },
  ],
};

function mockOk(usage: object = fullUsage, agents: object = agentsFixture) {
  server.use(
    http.get("/v1/usage", () => HttpResponse.json(usage)),
    http.get("/v1/agents", () => HttpResponse.json(agents)),
  );
}

describe("<Analytics />", () => {
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

  it("renders heading, KPIs, cost bar, token mix, daily chart, and declared delegation", async () => {
    mockOk();
    renderPage();

    expect(await screen.findByRole("heading", { name: "Analytics" })).toBeInTheDocument();
    expect(await screen.findByText("$3.00")).toBeInTheDocument();
    expect(screen.getByText("1.1M")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("Research Bot")).toBeInTheDocument();
    expect(screen.getByText("Token mix")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Daily sandbox activity" })).toBeInTheDocument();
    expect(screen.getByText("Lead → Researcher")).toBeInTheDocument();
  });

  it("requests /v1/usage with days=7 and group_by=agent, and refetches days=30", async () => {
    let lastParams: URLSearchParams | null = null;
    server.use(
      http.get("/v1/usage", ({ request }) => {
        lastParams = new URL(request.url).searchParams;
        return HttpResponse.json(fullUsage);
      }),
      http.get("/v1/agents", () => HttpResponse.json(agentsFixture)),
    );
    renderPage();

    await screen.findByRole("heading", { name: "Analytics" });
    await waitFor(() => expect(lastParams!.get("days")).toBe("7"));
    expect(lastParams!.get("group_by")).toBe("agent");

    await userEvent.click(screen.getByRole("button", { name: "30d" }));
    await waitFor(() => expect(lastParams!.get("days")).toBe("30"));
  });

  it("shows an error state with Retry when /v1/usage fails, without hiding declared delegation", async () => {
    server.use(
      http.get("/v1/usage", () => HttpResponse.json({ error: "Internal error" }, { status: 500 })),
      http.get("/v1/agents", () => HttpResponse.json(agentsFixture)),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText("Couldn't load analytics")).toBeInTheDocument());
    expect(screen.getByText("Internal error")).toBeInTheDocument();
    expect(screen.queryByText("No usage in this period")).not.toBeInTheDocument();
    expect(await screen.findByText("Lead → Researcher")).toBeInTheDocument();

    const retryButton = screen.getByRole("button", { name: "Retry" });
    server.use(http.get("/v1/usage", () => HttpResponse.json(fullUsage)));
    await userEvent.click(retryButton);

    await waitFor(() => expect(screen.getByText("$3.00")).toBeInTheDocument());
    expect(screen.queryByText("Couldn't load analytics")).not.toBeInTheDocument();
  });

  it('shows "No usage in this period" when the tenant has recorded nothing, and still lists declared delegation', async () => {
    mockOk(emptyUsage);
    renderPage();

    expect(await screen.findByText("No usage in this period")).toBeInTheDocument();
    expect(screen.queryByText("$0.00")).not.toBeInTheDocument();
    expect(await screen.findByText("Lead → Researcher")).toBeInTheDocument();
  });

  it("does not depend on a charting library", () => {
    const pkg = JSON.parse(
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8"),
    ) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const banned = [
      "recharts",
      "chart.js",
      "chartjs",
      "victory",
      "@visx/visx",
      "@nivo/core",
      "highcharts",
      "d3",
      "plotly.js",
      "echarts",
    ];
    for (const name of banned) {
      expect(names).not.toContain(name);
    }
  });
});

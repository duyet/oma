import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../../mocks/server";
import { AgentDailySummaryTab } from "./AgentDailySummaryTab";
import type { AgentHubContext } from "../AgentDetail";
import type { AgentRecord } from "../../types/agent";
import type { AgentDailySummary } from "./daily-summary-types";

const agent: AgentRecord = {
  id: "agent_1",
  name: "My Agent",
  model: "claude-new",
  version: 2,
  created_at: "2026-01-01T00:00:00Z",
};

const ctx: AgentHubContext = {
  pageHeaderSlot: null,
  agent,
  versions: [agent],
  refetchAgent: () => {},
  refetchVersions: () => {},
};

function emptyTokens() {
  return { input: 0, output: 0, cache_read: 0, cache_creation: 0, reasoning: 0 };
}

function summary(over: Partial<AgentDailySummary> = {}): AgentDailySummary {
  return {
    agent_id: "agent_1",
    period: { since: "2026-08-28T00:00:00.000Z", days: 7 },
    runs: { total: 3, successful: 2, failed: 1, skipped_concurrency: 0 },
    tokens: { input: 2000, output: 800, cache_read: 500, cache_creation: 0, reasoning: 100 },
    estimated_cost_usd: 0.02,
    cache_hit_ratio: 0.2,
    sessions: 2,
    avg_session_duration_seconds: 40,
    top_outputs: [],
    daily: [
      { date: "2026-09-01", runs: 1, successful: 1, failed: 0, skipped_concurrency: 0, tokens: emptyTokens(), estimated_cost_usd: 0 },
      { date: "2026-09-02", runs: 0, successful: 0, failed: 0, skipped_concurrency: 0, tokens: emptyTokens(), estimated_cost_usd: 0 },
      { date: "2026-09-03", runs: 2, successful: 1, failed: 1, skipped_concurrency: 0, tokens: emptyTokens(), estimated_cost_usd: 0 },
    ],
    recent_runs: [
      {
        id: "srun_1",
        schedule_id: "sch_1",
        session_id: "sess_9",
        status: "ok",
        error: null,
        started_at: "2026-09-03T12:00:00.000Z",
        created_at: "2026-09-03T12:00:00.000Z",
      },
      {
        id: "srun_2",
        schedule_id: "sch_1",
        session_id: null,
        status: "error",
        error: "launch failed",
        started_at: "2026-09-03T11:00:00.000Z",
        created_at: "2026-09-03T11:00:00.000Z",
      },
    ],
    assumptions: { model_usd_per_mtok_in: 3, model_usd_per_mtok_out: 15 },
    ...over,
  };
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Routes>
          <Route element={<Outlet context={ctx} />}>
            <Route path="*" element={<AgentDailySummaryTab />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("<AgentDailySummaryTab />", () => {
  it("renders KPIs, sparkline, and recent runs when there is data", async () => {
    server.use(
      http.get("/v1/agents/agent_1/daily-summary", () => HttpResponse.json(summary())),
    );
    renderTab();

    expect(await screen.findByText("Runs")).toBeInTheDocument();
    expect(screen.getByText("2 ok · 1 failed · 0 skipped")).toBeInTheDocument();
    expect(screen.getByText("Cache hit")).toBeInTheDocument();
    expect(screen.getByText("20%")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Scheduled runs" })).toBeInTheDocument();
    expect(screen.getByText("Recent runs")).toBeInTheDocument();
    expect(screen.getByText("ok")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "sess_9" })).toHaveAttribute("href", "/sessions/sess_9");
    expect(screen.getByText("launch failed")).toBeInTheDocument();
  });

  it("shows an empty state when there are no runs and no tokens", async () => {
    server.use(
      http.get("/v1/agents/agent_1/daily-summary", () =>
        HttpResponse.json(
          summary({
            runs: { total: 0, successful: 0, failed: 0, skipped_concurrency: 0 },
            tokens: emptyTokens(),
            estimated_cost_usd: 0,
            cache_hit_ratio: 0,
            recent_runs: [],
            daily: [],
          }),
        ),
      ),
    );
    renderTab();

    expect(await screen.findByText("No scheduled runs in this period")).toBeInTheDocument();
    expect(screen.queryByText("Recent runs")).not.toBeInTheDocument();
  });

  it("requests days=1 when the 1d chip is clicked", async () => {
    const seen: string[] = [];
    server.use(
      http.get("/v1/agents/agent_1/daily-summary", ({ request }) => {
        seen.push(new URL(request.url).searchParams.get("days") ?? "");
        return HttpResponse.json(summary({ period: { since: "2026-09-03T00:00:00.000Z", days: 1 } }));
      }),
    );
    renderTab();
    expect(await screen.findByText("Runs")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "1d" }));
    expect(await screen.findByRole("button", { name: "1d" })).toBeInTheDocument();
    expect(seen).toContain("7");
    expect(seen).toContain("1");
  });
});

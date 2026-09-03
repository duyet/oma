import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../../mocks/server";
import { AgentMonitorTab } from "./AgentMonitorTab";
import type { AgentHubContext } from "../AgentDetail";
import type { AgentRecord } from "../../types/agent";

const agent: AgentRecord = {
  id: "agent_1",
  name: "Daily Digest",
  model: "claude-sonnet-4-6",
  version: 1,
  created_at: "2026-01-01T00:00:00Z",
};

const ctx: AgentHubContext = {
  pageHeaderSlot: null,
  agent,
  versions: [agent],
  refetchAgent: () => {},
  refetchVersions: () => {},
};

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <Routes>
          <Route element={<Outlet context={ctx} />}>
            <Route path="*" element={<AgentMonitorTab />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("<AgentMonitorTab />", () => {
  it("shows an empty state when the agent has no sessions", async () => {
    server.use(
      http.get("/v1/sessions", () => HttpResponse.json({ data: [] })),
    );
    renderTab();
    expect(await screen.findByText("No runs yet")).toBeInTheDocument();
  });

  it("renders the current run, step bar, blocked warning, and heartbeat log", async () => {
    const idle = {
      id: "sess_last",
      title: "Digest",
      agent: { id: "agent_1", version: 1 },
      status: "idle",
      created_at: "2026-09-03T18:00:00.000Z",
      stats: { duration_seconds: 263 },
    };
    server.use(
      http.get("/v1/sessions", ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("status") === "running") {
          return HttpResponse.json({ data: [] });
        }
        return HttpResponse.json({ data: [idle] });
      }),
      http.get("/v1/sessions/sess_last/events", () =>
        HttpResponse.json({
          data: [
            {
              seq: 1,
              type: "agent.status",
              ts: "2026-09-03T18:00:00.000Z",
              data: {
                type: "agent.status",
                state: "working",
                summary: "started",
                step: 1,
                total_steps: 5,
              },
            },
            {
              seq: 2,
              type: "agent.status",
              ts: "2026-09-03T18:01:00.000Z",
              data: {
                type: "agent.status",
                state: "blocked",
                summary: "Paused",
                step: 3,
                total_steps: 5,
                blocked_on: "tool confirmation",
              },
            },
          ],
        }),
      ),
    );
    renderTab();

    expect(await screen.findByText("Current run")).toBeInTheDocument();
    expect(screen.getByText("sess_last")).toBeInTheDocument();
    expect(await screen.findByText("Step 3/5")).toBeInTheDocument();
    expect(screen.getByTestId("monitor-blocked")).toHaveTextContent(
      "Waiting for: tool confirmation",
    );
    expect(screen.getByText(/Step 3\/5: Paused/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View session" })).toHaveAttribute(
      "href",
      "/sessions/sess_last",
    );
    expect(screen.getByText("Upgrade log")).toBeInTheDocument();
  });
});

import { describe, expect, it, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../../mocks/server";
import { ConfirmProvider } from "../../hooks/useConfirm";
import { AgentDetail } from "../AgentDetail";
import { AgentOverviewTab } from "./AgentOverviewTab";
import { AgentSessionsTab } from "./AgentSessionsTab";
import { AgentDeploymentsTab } from "./AgentDeploymentsTab";
import { AgentPublishingTab } from "./AgentPublishingTab";
import { AgentMonitorTab } from "./AgentMonitorTab";

const agentV2 = {
  id: "agent_1",
  name: "My Agent",
  model: "claude-new",
  system: "NEW SYSTEM PROMPT",
  version: 2,
  tools: [{ type: "agent_toolset_20260401" }],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};
const agentV1 = {
  ...agentV2,
  model: "claude-old",
  system: "OLD SYSTEM PROMPT",
  version: 1,
};

function mountHubHandlers() {
  server.use(
    http.get("/v1/agents/agent_1", () => HttpResponse.json(agentV2)),
    http.get("/v1/agents/agent_1/versions", () =>
      HttpResponse.json({ data: [agentV1, agentV2] }),
    ),
    http.get("/v1/integrations/:provider/agents/agent_1/publications", () =>
      HttpResponse.json({ data: [] }),
    ),
    http.get("/v1/sessions", () => HttpResponse.json({ data: [] })),
    http.get("/v1/deployments", () => HttpResponse.json({ data: [] })),
    http.get("/v1/agents/agent_1/publications", () => HttpResponse.json({ data: [] })),
    http.get("/v1/agents/agent_1/schedules", () => HttpResponse.json({ data: [] })),
    http.get("/v1/agents/agent_1/stats", () =>
      HttpResponse.json({
        sessions: 0,
        est_model_cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
        sandbox_seconds: 0,
        est_sandbox_cost_usd: 0,
      }),
    ),
    http.get("/v1/agents/agent_1/analytics", () =>
      HttpResponse.json({
        range: "30d",
        total_sessions: 0,
        completed_sessions: 0,
        error_count: 0,
        error_rate: 0,
        tokens: {
          input: 0,
          output: 0,
          total: 0,
          per_session: {
            input: { p50: 0, p90: 0, p95: 0 },
            output: { p50: 0, p90: 0, p95: 0 },
            total: { p50: 0, p90: 0, p95: 0 },
          },
        },
        total_turns: 0,
        turns_per_session: { p50: 0, p90: 0, p95: 0 },
        total_tool_calls: 0,
        sessions_over_time: [],
      }),
    ),
    // AgentRunReadiness checklist probes.
    http.get("/v1/environments", () =>
      HttpResponse.json({ data: [{ id: "env_1", name: "Default" }] }),
    ),
    http.get("/v1/vaults", () => HttpResponse.json({ data: [] })),
  );
}

function renderHub(initial = "/agents/agent_1") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route path="/agents/:id" element={<AgentDetail />}>
              <Route index element={<AgentOverviewTab />} />
              <Route path="sessions" element={<AgentSessionsTab />} />
              <Route path="deployments" element={<AgentDeploymentsTab />} />
              <Route path="publishing" element={<AgentPublishingTab />} />
              <Route path="monitor" element={<AgentMonitorTab />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

describe("<AgentDetail /> hub layout", () => {
  beforeEach(mountHubHandlers);

  it("renders run readiness with a deep-link to session create", async () => {
    renderHub();
    expect(await screen.findByTestId("agent-run-readiness")).toBeInTheDocument();
    const sessionCta = await screen.findByRole("link", { name: /new session/i });
    expect(sessionCta.getAttribute("href")).toContain("/sessions?new=1");
    expect(sessionCta.getAttribute("href")).toContain("agent=agent_1");
  });

  it("hides run readiness once the agent already has a session", async () => {
    server.use(
      http.get("/v1/sessions", () =>
        HttpResponse.json({ data: [{ id: "sess_1" }] }),
      ),
    );
    renderHub();
    await screen.findByRole("heading", { name: "My Agent" });
    expect(screen.queryByTestId("agent-run-readiness")).toBeNull();
  });

  it("renders the header + tab strip once the agent loads", async () => {
    renderHub();
    expect(await screen.findByRole("heading", { name: "My Agent" })).toBeInTheDocument();
    // Tab strip — real nested-route links.
    expect(screen.getByRole("link", { name: "Agent" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sessions" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Deployments" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Daily Summary" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Monitor" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Observability" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Publishing" })).toBeInTheDocument();
    // Active tab (Agent) shows the config view.
    expect(screen.getByRole("heading", { name: "System Prompt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Version:/ })).toBeInTheDocument();
  });

  it("navigates to the Sessions tab and shows its empty state", async () => {
    renderHub();
    await screen.findByRole("heading", { name: "My Agent" });
    await userEvent.click(screen.getByRole("link", { name: "Sessions" }));
    expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
  });

  it("navigates to the Deployments tab and shows the No deployments empty state", async () => {
    renderHub();
    await screen.findByRole("heading", { name: "My Agent" });
    await userEvent.click(screen.getByRole("link", { name: "Deployments" }));
    expect(await screen.findByText("No deployments")).toBeInTheDocument();
    expect(
      screen.getByText("Deploy this agent to run it on a schedule, via webhook, or manually."),
    ).toBeInTheDocument();
  });

  it("navigates to the Publishing tab and shows the Not published empty state", async () => {
    renderHub();
    await screen.findByRole("heading", { name: "My Agent" });
    await userEvent.click(screen.getByRole("link", { name: "Publishing" }));
    expect(await screen.findByText("Not published")).toBeInTheDocument();
    expect(
      screen.getByText("Publish this agent to share a public chat page, embed widget, or QR code."),
    ).toBeInTheDocument();
  });

  it("navigates to the Monitor tab and shows the empty-run state", async () => {
    renderHub();
    await screen.findByRole("heading", { name: "My Agent" });
    await userEvent.click(screen.getByRole("link", { name: "Monitor" }));
    expect(await screen.findByText("No runs yet")).toBeInTheDocument();
    expect(await screen.findByText("never run")).toBeInTheDocument();
    expect(screen.getByTestId("agent-health-strip")).toHaveTextContent("Last run");
  });
});

describe("<AgentDetail /> New Session dialog", () => {
  beforeEach(mountHubHandlers);

  it("opens a dialog instead of creating a session immediately", async () => {
    server.use(
      http.get("/v1/environments", () =>
        HttpResponse.json({ data: [{ id: "env_1", name: "Default" }] }),
      ),
      http.get("/v1/environments/env_1", () =>
        HttpResponse.json({ id: "env_1", name: "Default" }),
      ),
    );
    let created = false;
    server.use(
      http.post("/v1/sessions", () => {
        created = true;
        return HttpResponse.json({ id: "sess_1" });
      }),
    );

    renderHub();
    await screen.findByRole("heading", { name: "My Agent" });

    await userEvent.click(screen.getByRole("button", { name: "+ New Session" }));

    // Dialog opens — no session created yet.
    expect(await screen.findByRole("heading", { name: "New session" })).toBeInTheDocument();
    expect(created).toBe(false);

    await userEvent.click(screen.getByRole("button", { name: "Create session" }));
    await waitFor(() => expect(created).toBe(true));
  });
});

describe("<AgentOverviewTab /> version picker", () => {
  beforeEach(mountHubHandlers);

  it("switches the viewed version and shows the historical banner", async () => {
    renderHub();
    await screen.findByRole("heading", { name: "My Agent" });

    // Default: latest (v2).
    const trigger = screen.getByRole("button", { name: /Version:/ });
    expect(trigger).toHaveTextContent("v2");
    expect(screen.queryByText(/Viewing v1/)).not.toBeInTheDocument();

    // Open the picker and select v1.
    await userEvent.click(trigger);
    const item = await screen.findByRole("menuitemcheckbox", { name: /^v1/ });
    await userEvent.click(item);

    // Banner appears; the config now reflects v1.
    expect(
      await screen.findByText(/Viewing v1 — the active version is v2/),
    ).toBeInTheDocument();
    const pre = document.querySelector("pre");
    expect(pre).toHaveTextContent("OLD SYSTEM PROMPT");

    // Back-to-latest clears the banner.
    await userEvent.click(screen.getByRole("button", { name: "Back to latest" }));
    await waitFor(() =>
      expect(screen.queryByText(/Viewing v1/)).not.toBeInTheDocument(),
    );
  });

  it("still lists the current version when the versions endpoint returns none", async () => {
    // An agent that has never been updated can come back with an empty
    // versions list; the menu used to open onto just its header, which
    // reads as broken.
    server.use(
      http.get("/v1/agents/agent_1", () => HttpResponse.json({ ...agentV2, version: 1 })),
      http.get("/v1/agents/agent_1/versions", () => HttpResponse.json({ data: [] })),
    );
    renderHub();
    await screen.findByRole("heading", { name: "My Agent" });

    await userEvent.click(screen.getByRole("button", { name: /Version:/ }));
    const items = await screen.findAllByRole("menuitemcheckbox");
    expect(items).toHaveLength(1);
    expect(items[0]).toHaveTextContent("v1");
    expect(items[0]).toHaveTextContent("latest");
    // The active version is check-marked, not just listed.
    expect(items[0]).toHaveAttribute("aria-checked", "true");
  });
});

import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { AgentHealthStrip } from "./AgentHealthStrip";

function mountStripHandlers(home: {
  session: { id: string; status: string } | null;
  runtime: { status?: string; last_heartbeat?: number } | null;
  created: boolean;
}) {
  server.use(
    http.get("/v1/agents/agent_1/schedules", () => HttpResponse.json({ data: [] })),
    http.get("/v1/sessions", () => HttpResponse.json({ data: [] })),
    http.get("/v1/agents/agent_1/stats", () =>
      HttpResponse.json({ sessions: 0, est_model_cost_usd: 0 }),
    ),
    http.get("/v1/agents/agent_1/analytics", () =>
      HttpResponse.json({ completed_sessions: 0, error_count: 0 }),
    ),
    http.get("/v1/runtimes", () => HttpResponse.json({ runtimes: [] })),
    http.get("/v1/sessions/home", () => HttpResponse.json(home)),
  );
}

function renderStrip() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AgentHealthStrip agentId="agent_1" now={1_700_000_090_000} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("<AgentHealthStrip /> home presence", () => {
  it("links the inbox when a home session exists", async () => {
    mountStripHandlers({
      session: { id: "sess_home", status: "idle" },
      runtime: { status: "offline", last_heartbeat: 1 },
      created: false,
    });
    renderStrip();
    const link = await screen.findByTestId("home-session-link");
    expect(link).toHaveAttribute("href", "/sessions/sess_home");
    expect(link).toHaveTextContent(/inbox idle/i);
    expect(screen.getByTestId("home-runtime-presence").textContent).toMatch(/Home\s*offline/i);
  });

  it("offers Open home when GET returns no session", async () => {
    mountStripHandlers({ session: null, runtime: null, created: false });
    renderStrip();
    expect(await screen.findByTestId("open-home")).toHaveTextContent(/Open home/i);
    expect(screen.getByTestId("home-runtime-presence").textContent).toMatch(
      /Home\s*provisioning/i,
    );
  });
});

import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../mocks/server";
import { Dashboard } from "./Dashboard";

vi.mock("@/hooks/use-mobile", () => ({
  MOBILE_BREAKPOINT: 768,
  useIsMobile: () => true,
}));

function mockAssemblyDeps() {
  server.use(
    ...[
      "/v1/agents",
      "/v1/model_cards",
      "/v1/skills",
      "/v1/environments",
      "/v1/vaults",
      "/v1/publications",
      "/v1/api_keys",
      "/v1/memory_stores",
      "/v1/files",
    ].map((path) => http.get(path, () => HttpResponse.json({ data: [] }))),
    http.get("/v1/integrations/linear/installations", () =>
      HttpResponse.json({ data: [] }),
    ),
    http.get("/v1/integrations/github/installations", () =>
      HttpResponse.json({ data: [] }),
    ),
    http.get("/v1/integrations/slack/installations", () =>
      HttpResponse.json({ data: [] }),
    ),
    http.get("/v1/hosting_types", () => HttpResponse.json({ data: [] })),
    http.get("/v1/usage", () =>
      HttpResponse.json({
        daily: [],
        by_kind: [],
        total_sessions: 0,
        total_active_seconds: 0,
      }),
    ),
  );
}

describe("<Dashboard /> on a phone viewport", () => {
  it("renders recent sessions as cards instead of table rows", async () => {
    mockAssemblyDeps();
    server.use(
      http.get("/v1/stats", () =>
        HttpResponse.json({
          agents: 1,
          sessions: 1,
          environments: 1,
          vaults: 1,
          skills: 1,
          model_cards: 1,
          api_keys: 1,
          total_sandbox_seconds: 60,
          total_usage_sessions: 1,
        }),
      ),
      http.get("/v1/sessions", () =>
        HttpResponse.json({
          data: [
            {
              id: "sess_1",
              title: "Investigate the checkout 500s",
              agent_id: "agent_1",
              status: "idle",
              created_at: "2026-01-01T00:00:00.000Z",
              input_tokens: 100,
              output_tokens: 20,
            },
          ],
        }),
      ),
    );

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>
          <Dashboard />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("button", { name: /Investigate the checkout 500s/i }),
    ).toBeInTheDocument();
    const recent = screen.getByTestId("recent-sessions");
    expect(recent.querySelector("tr")).toBeNull();
  });
});

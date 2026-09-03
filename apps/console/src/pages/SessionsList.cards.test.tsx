import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../mocks/server";
import { ConfirmProvider } from "../hooks/useConfirm";
import { SessionsList } from "./SessionsList";

vi.mock("@/hooks/use-mobile", () => ({
  MOBILE_BREAKPOINT: 768,
  useIsMobile: () => true,
}));

describe("<SessionsList /> cards", () => {
  it("renders each session as a card on a phone viewport", async () => {
    server.use(
      http.get("/v1/agents", () =>
        HttpResponse.json({
          data: [{ id: "agent_digest", name: "Nightly Digest Bot" }],
        }),
      ),
      http.get("/v1/environments", () => HttpResponse.json({ data: [] })),
      http.get("/v1/vaults", () => HttpResponse.json({ data: [] })),
      http.get("/v1/files", () => HttpResponse.json({ data: [] })),
      http.get("/v1/memory_stores", () => HttpResponse.json({ data: [] })),
      http.get("/v1/sessions", () =>
        HttpResponse.json({
          data: [
            {
              id: "sess_1",
              title: "Nightly digest",
              agent: { id: "agent_digest", version: 1 },
              environment_id: "env_1",
              status: "running",
              created_at: "2026-01-01T00:00:00.000Z",
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
        <ConfirmProvider>
          <MemoryRouter initialEntries={["/sessions"]}>
            <SessionsList />
          </MemoryRouter>
        </ConfirmProvider>
      </QueryClientProvider>,
    );

    expect(
      await screen.findByRole("button", { name: /Nightly digest/i }),
    ).toBeInTheDocument();
    expect(screen.getByText("Nightly Digest Bot")).toBeInTheDocument();
    expect(screen.queryByRole("columnheader")).toBeNull();
  });
});

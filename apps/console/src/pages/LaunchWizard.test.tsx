import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { LaunchWizard } from "./LaunchWizard";

function renderWizard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <LaunchWizard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("LaunchWizard", () => {
  it("renders ordered stages and marks completed steps from stats", async () => {
    server.use(
      http.get("/v1/stats", () =>
        HttpResponse.json({
          agents: 1,
          sessions: 0,
          environments: 1,
          vaults: 0,
          model_cards: 1,
          api_keys: 0,
        }),
      ),
      http.get("/v1/agents", () =>
        HttpResponse.json({ data: [{ id: "agent_1", name: "Helper" }] }),
      ),
    );

    renderWizard();

    expect(await screen.findByTestId("launch-wizard-steps")).toBeTruthy();
    for (const id of ["agent", "environment", "vault", "session"]) {
      expect(screen.getByTestId(`launch-step-${id}`)).toBeTruthy();
    }

    await waitFor(() => {
      expect(screen.getByTestId("launch-step-agent").dataset.done).toBe("true");
      expect(screen.getByTestId("launch-step-environment").dataset.done).toBe("true");
      expect(screen.getByTestId("launch-step-vault").dataset.done).toBe("false");
      expect(screen.getByTestId("launch-step-session").dataset.done).toBe("false");
    });
    expect(screen.getByText("2/4")).toBeTruthy();

    // Dual-runtime note stays visible (CF + k3s) — may appear more than once.
    expect(screen.getAllByText(/Cloudflare Workers/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/k3s/i).length).toBeGreaterThan(0);
  });

  it("collapses to a pointer back to Overview once any session exists", async () => {
    server.use(
      http.get("/v1/stats", () =>
        HttpResponse.json({
          agents: 1,
          sessions: 1,
          environments: 1,
          vaults: 0,
          model_cards: 0,
          api_keys: 0,
        }),
      ),
      http.get("/v1/agents", () =>
        HttpResponse.json({ data: [{ id: "agent_1", name: "Helper" }] }),
      ),
    );

    renderWizard();

    expect(await screen.findByTestId("launch-wizard-complete")).toBeTruthy();
    expect(screen.queryByTestId("launch-wizard-steps")).toBeNull();
    expect(screen.queryByText("Create agent")).toBeNull();
    expect(screen.getByRole("button", { name: "Back to Overview" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "View sessions" })).toBeTruthy();
  });
});

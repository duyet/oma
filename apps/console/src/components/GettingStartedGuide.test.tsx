import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import {
  GettingStartedGuide,
  GETTING_STARTED_DISMISSED_KEY,
} from "./GettingStartedGuide";

function mockDeps({
  agents = 0,
  environments = 0,
  vaults = 0,
  sessions = 0,
}: Partial<Record<"agents" | "environments" | "vaults" | "sessions", number>> = {}) {
  server.use(
    http.get("/v1/stats", () =>
      HttpResponse.json({ agents, environments, vaults, sessions }),
    ),
    http.get("/v1/sessions", () =>
      HttpResponse.json({
        data: Array.from({ length: sessions }, (_, i) => ({ id: `sess_${i}` })),
      }),
    ),
    ...[
      "/v1/integrations/linear/installations",
      "/v1/integrations/github/installations",
      "/v1/integrations/slack/installations",
    ].map((p) => http.get(p, () => HttpResponse.json({ data: [] }))),
  );
}

function renderGuide() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GettingStartedGuide />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("GettingStartedGuide", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("renders all four onboarding steps", async () => {
    mockDeps();
    renderGuide();

    expect(await screen.findByTestId("getting-started-guide")).toBeTruthy();
    for (const id of ["agent", "session", "environment", "vault"]) {
      expect(screen.getByTestId(`guide-step-${id}`)).toBeTruthy();
    }
    expect(screen.getByText("Getting started")).toBeTruthy();
  });

  // The whole point of the panel: it must reflect real tenant state, not a
  // static checklist a user has to tick by hand.
  it("checks off steps whose resource already exists", async () => {
    mockDeps({ agents: 2, sessions: 1 });
    renderGuide();

    await waitFor(() => {
      expect(screen.getByTestId("guide-step-agent").dataset.done).toBe("true");
    });
    expect(screen.getByTestId("guide-step-session").dataset.done).toBe("true");
    expect(screen.getByTestId("guide-step-environment").dataset.done).toBe("false");
    expect(screen.getByText("2/4 done")).toBeTruthy();
  });

  it("reports completion when every step is satisfied", async () => {
    mockDeps({ agents: 1, sessions: 1, environments: 1, vaults: 1 });
    renderGuide();

    expect(await screen.findByText("You're all set up")).toBeTruthy();
  });

  it("hides on dismiss and persists the dismissal", async () => {
    mockDeps();
    const user = userEvent.setup();
    renderGuide();

    await user.click(await screen.findByLabelText("Dismiss getting started"));

    expect(screen.queryByTestId("getting-started-guide")).toBeNull();
    expect(localStorage.getItem(GETTING_STARTED_DISMISSED_KEY)).toBe("1");
  });

  it("stays hidden when the dismissal was persisted earlier", async () => {
    localStorage.setItem(GETTING_STARTED_DISMISSED_KEY, "1");
    mockDeps();
    renderGuide();

    expect(screen.queryByTestId("getting-started-guide")).toBeNull();
  });

  it("walks the tour dialog forward and back", async () => {
    mockDeps();
    const user = userEvent.setup();
    renderGuide();

    await user.click(await screen.findByRole("button", { name: "Take the tour" }));

    expect(await screen.findByTestId("tour-step-agent")).toBeTruthy();
    expect(screen.getByText("Step 1 of 4")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(await screen.findByTestId("tour-step-session")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByTestId("tour-step-agent")).toBeTruthy();
  });
});

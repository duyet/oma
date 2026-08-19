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
    sessionStorage.clear();
  });

  it("renders all four onboarding steps in dependency order", async () => {
    mockDeps();
    renderGuide();

    expect(await screen.findByTestId("getting-started-guide")).toBeTruthy();
    // agent → environment → vault → session (env before session for cloud)
    for (const id of ["agent", "environment", "vault", "session"]) {
      expect(screen.getByTestId(`guide-step-${id}`)).toBeTruthy();
    }
    expect(screen.getByText("Getting started")).toBeTruthy();
  });

  // The whole point of the panel: it must reflect real tenant state, not a
  // static checklist a user has to tick by hand.
  it("checks off steps whose resource already exists", async () => {
    mockDeps({ agents: 2, environments: 1 });
    renderGuide();

    await waitFor(() => {
      expect(screen.getByTestId("guide-step-agent").dataset.done).toBe("true");
    });
    expect(screen.getByTestId("guide-step-environment").dataset.done).toBe("true");
    expect(screen.getByTestId("guide-step-vault").dataset.done).toBe("false");
    expect(screen.getByTestId("guide-step-session").dataset.done).toBe("false");
    expect(screen.getByText("2/4 done")).toBeTruthy();
  });

  // First incomplete step is the only "Next" target — equal-weight rows
  // made operators scan without a clear primary action.
  it("marks the first incomplete step as Next", async () => {
    mockDeps({ agents: 2 });
    renderGuide();

    await waitFor(() => {
      expect(screen.getByTestId("guide-step-environment").dataset.next).toBe("true");
    });
    expect(screen.getByTestId("guide-step-agent").dataset.next).toBe("false");
    expect(screen.getByTestId("guide-step-vault").dataset.next).toBe("false");
    expect(screen.getByTestId("guide-step-session").dataset.next).toBe("false");
    expect(screen.getByText("Next")).toBeTruthy();
  });

  it("does not complete the vault step via integrations alone", async () => {
    // Vault done only when stats.vaults > 0 — channel installs don't count.
    mockDeps({ agents: 1, environments: 1, vaults: 0, sessions: 0 });
    server.use(
      http.get("/v1/integrations/github/installations", () =>
        HttpResponse.json({ data: [{ id: "gh_1" }] }),
      ),
    );
    renderGuide();

    await waitFor(() => {
      expect(screen.getByTestId("guide-step-agent").dataset.done).toBe("true");
    });
    expect(screen.getByTestId("guide-step-environment").dataset.done).toBe("true");
    expect(screen.getByTestId("guide-step-vault").dataset.done).toBe("false");
    expect(screen.getByTestId("guide-step-vault").dataset.next).toBe("true");
  });

  it("hides once any session exists, even if vault is still open", async () => {
    mockDeps({ agents: 1, environments: 0, vaults: 0, sessions: 1 });
    renderGuide();

    await waitFor(() => {
      expect(screen.queryByTestId("getting-started-guide")).toBeNull();
    });
    expect(screen.queryByText("Launch wizard")).toBeNull();
  });

  it("does not offer a second Launch wizard during first-run", async () => {
    mockDeps();
    renderGuide();

    expect(await screen.findByTestId("getting-started-guide")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Launch wizard" })).toBeNull();
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
    // Tour order: agent → environment → vault → session
    expect(await screen.findByTestId("tour-step-environment")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByTestId("tour-step-agent")).toBeTruthy();
  });
});

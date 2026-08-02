import { beforeEach, describe, expect, it } from "vitest";
import { render, screen, within, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { KanbanBoard } from "./KanbanBoard";

function renderBoard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <KanbanBoard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function session(overrides: Partial<{
  id: string;
  title: string;
  status: string;
  agentId: string;
  created_at: string;
}> = {}) {
  return {
    id: overrides.id ?? "ses_1",
    title: overrides.title ?? "A session",
    agent: { id: overrides.agentId ?? "agt_1", version: 1 },
    environment_id: "env_1",
    status: overrides.status ?? "idle",
    created_at: overrides.created_at ?? new Date().toISOString(),
  };
}

describe("<KanbanBoard />", () => {
  // The board always resolves agent names / models / sandbox providers for
  // its facets; individual tests override only what they assert on.
  beforeEach(() => {
    localStorage.clear();
    server.use(
      http.get("/v1/schedules", () => HttpResponse.json({ data: [] })),
      http.get("/v1/agents", () =>
        HttpResponse.json({
          data: [{ id: "agt_1", name: "Digest bot", model: "claude-sonnet-4-6" }],
        }),
      ),
      http.get("/v1/environments", () =>
        HttpResponse.json({ data: [{ id: "env_1", config: { sandbox_provider: "cloud" } }] }),
      ),
    );
  });

  it("renders an empty state when there are no sessions", async () => {
    server.use(
      http.get("/v1/sessions", () => HttpResponse.json({ data: [] })),
    );
    renderBoard();
    expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
  });

  it("places sessions into queued / running / blocked / done based on status + last event", async () => {
    const sessions = [
      session({ id: "ses_queued", status: "idle" }), // no events → queued
      session({ id: "ses_running", status: "running" }),
      session({ id: "ses_blocked", status: "idle" }), // requires_action → blocked
      session({ id: "ses_done", status: "idle" }), // end_turn → done
      session({ id: "ses_terminated", status: "terminated" }),
    ];

    server.use(
      http.get("/v1/sessions", () => HttpResponse.json({ data: sessions })),
      http.get("/v1/sessions/ses_queued/events", () => HttpResponse.json({ data: [] })),
      http.get("/v1/sessions/ses_blocked/events", () =>
        HttpResponse.json({
          data: [
            {
              seq: 3,
              type: "session.status_idle",
              data: { type: "session.status_idle", stop_reason: { type: "requires_action" } },
            },
          ],
        }),
      ),
      http.get("/v1/sessions/ses_done/events", () =>
        HttpResponse.json({
          data: [
            {
              seq: 5,
              type: "session.status_idle",
              data: { type: "session.status_idle", stop_reason: { type: "end_turn" } },
            },
          ],
        }),
      ),
    );

    renderBoard();

    await waitFor(() => {
      expect(screen.getByTestId("kanban-board")).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(within(screen.getByTestId("kanban-column-queued")).getByText("1")).toBeInTheDocument();
    });
    expect(within(screen.getByTestId("kanban-column-running")).getByText("1")).toBeInTheDocument();
    expect(within(screen.getByTestId("kanban-column-blocked")).getByText("1")).toBeInTheDocument();
    expect(within(screen.getByTestId("kanban-column-done")).getByText("2")).toBeInTheDocument();
  });

  it("renders both board tabs with the session board as the default", async () => {
    server.use(http.get("/v1/sessions", () => HttpResponse.json({ data: [] })));
    renderBoard();

    expect(
      await screen.findByRole("tab", { name: "Agent Session Board" }),
    ).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("tab", { name: "GitHub Issues" })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    // Default tab is the session board.
    expect(await screen.findByText("No sessions yet")).toBeInTheDocument();
  });

  it("renders an enabled schedule as a repeat card in Queued with a countdown", async () => {
    server.use(
      http.get("/v1/sessions", () => HttpResponse.json({ data: [] })),
      http.get("/v1/schedules", () =>
        HttpResponse.json({
          data: [
            {
              id: "sch_1",
              agent_id: "agt_1",
              cron_expression: "0 9 * * 1",
              timezone: "UTC",
              input: "Weekly digest",
              environment_id: "env_1",
              next_run_at: new Date(Date.now() + 90 * 60_000).toISOString(),
              enabled: 1,
              created_at: new Date().toISOString(),
            },
          ],
        }),
      ),
    );
    renderBoard();

    const card = await screen.findByTestId("kanban-schedule-card");
    expect(within(card).getByText("Weekly digest")).toBeInTheDocument();
    expect(within(card).getByText("Weekly Mon 09:00")).toBeInTheDocument();
    expect(within(card).getByTestId("kanban-schedule-countdown").textContent).toMatch(/^in 1h/);
    // Enabled ⇒ waiting to fire ⇒ Queued.
    expect(within(screen.getByTestId("kanban-column-queued")).getByText("1")).toBeInTheDocument();
    // Schedule cards are the only draggable ones (Queued ↔ Paused).
    expect(card).toHaveAttribute("draggable", "true");
  });

  it("parks a disabled schedule in Paused and links it to its last run", async () => {
    server.use(
      http.get("/v1/sessions", () => HttpResponse.json({ data: [] })),
      http.get("/v1/schedules", () =>
        HttpResponse.json({
          data: [
            {
              id: "sch_off",
              agent_id: "agt_1",
              cron_expression: "*/15 * * * *",
              input: "Poll the queue",
              enabled: 0,
              last_session_id: "ses_prev",
              created_at: new Date().toISOString(),
            },
          ],
        }),
      ),
    );
    renderBoard();

    const card = await screen.findByTestId("kanban-schedule-card");
    expect(within(screen.getByTestId("kanban-column-paused")).getByText("1")).toBeInTheDocument();
    expect(within(card).getByTestId("kanban-schedule-countdown")).toHaveTextContent("paused");
    expect(within(card).getByRole("link", { name: /last run/ })).toHaveAttribute(
      "href",
      "/sessions/ses_prev",
    );
  });

  it("does not let a session card be dragged — its column is derived", async () => {
    server.use(
      http.get("/v1/sessions", () =>
        HttpResponse.json({ data: [session({ id: "ses_run", status: "running" })] }),
      ),
    );
    renderBoard();

    const card = await screen.findByTestId("kanban-session-card");
    expect(card).not.toHaveAttribute("draggable", "true");
    expect(card.getAttribute("title")).toMatch(/derived from its own lifecycle/);
  });

  it("collapses the Done column and remembers it", async () => {
    server.use(
      http.get("/v1/sessions", () =>
        HttpResponse.json({ data: [session({ id: "ses_done", status: "terminated" })] }),
      ),
    );
    renderBoard();

    const doneToggle = await screen.findByRole("button", { name: "Done" });
    expect(doneToggle).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(doneToggle);

    await waitFor(() => expect(doneToggle).toHaveAttribute("aria-expanded", "false"));
    expect(
      within(screen.getByTestId("kanban-column-done")).queryByTestId("kanban-session-card"),
    ).toBeNull();
    expect(localStorage.getItem("oma.kanban.doneCollapsed")).toBe("1");
  });

  it("truncates a long column behind a Show more expander", async () => {
    const many = Array.from({ length: 14 }, (_, i) =>
      session({ id: `ses_${i}`, status: "running" }),
    );
    server.use(http.get("/v1/sessions", () => HttpResponse.json({ data: many })));
    renderBoard();

    await waitFor(() => {
      expect(screen.getAllByTestId("kanban-session-card")).toHaveLength(10);
    });
    fireEvent.click(screen.getByRole("button", { name: "Show 4 more" }));
    await waitFor(() => {
      expect(screen.getAllByTestId("kanban-session-card")).toHaveLength(14);
    });
  });

  it("shows a connect CTA on the GitHub Issues tab when no installation exists", async () => {
    server.use(
      http.get("/v1/sessions", () => HttpResponse.json({ data: [] })),
      http.get("/v1/integrations/github/installations", () =>
        HttpResponse.json({ data: [] }),
      ),
    );
    renderBoard();

    fireEvent.click(await screen.findByRole("tab", { name: "GitHub Issues" }));

    expect(await screen.findByText("Connect GitHub")).toBeInTheDocument();
    expect(
      screen.getByText("Connect GitHub to build an issues board"),
    ).toBeInTheDocument();
  });
});

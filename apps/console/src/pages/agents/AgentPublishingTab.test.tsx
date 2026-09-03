import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../../mocks/server";
import { ConfirmProvider } from "../../hooks/useConfirm";
import { AgentDetail } from "../AgentDetail";
import { AgentPublishingTab } from "./AgentPublishingTab";
import type { Publication } from "./publication-types";

const agent = {
  id: "agent_1",
  name: "My Agent",
  model: "claude-new",
  system: "SYSTEM",
  version: 1,
  tools: [{ type: "agent_toolset_20260401" }],
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
};

function pub(overrides: Partial<Publication> = {}): Publication {
  return {
    id: "pub_1",
    agent_id: "agent_1",
    agent_version: 1,
    slug: "my-agent",
    title: "My Agent",
    description: null,
    avatar_url: null,
    visibility: "public",
    status: "live",
    greeting: null,
    suggested_prompts: [],
    pricing_ref: null,
    rate_limit_ref: null,
    environment_id: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/** Agent + versions handlers every test needs; publications handlers are
 *  added per-test since they vary (empty / seeded / mutated by POST-PATCH). */
function mountAgentHandlers() {
  server.use(
    http.get("/v1/agents/agent_1", () => HttpResponse.json(agent)),
    http.get("/v1/agents/agent_1/versions", () => HttpResponse.json({ data: [agent] })),
    http.get("/v1/agents/agent_1/schedules", () => HttpResponse.json({ data: [] })),
    http.get("/v1/sessions", () => HttpResponse.json({ data: [] })),
    http.get("/v1/agents/agent_1/stats", () =>
      HttpResponse.json({ sessions: 0, est_model_cost_usd: 0 }),
    ),
    http.get("/v1/agents/agent_1/analytics", () =>
      HttpResponse.json({ completed_sessions: 0, error_count: 0 }),
    ),
  );
}

function renderTab(initial = "/agents/agent_1/publishing") {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[initial]}>
          <Routes>
            <Route path="/agents/:id" element={<AgentDetail />}>
              <Route path="publishing" element={<AgentPublishingTab />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

describe("<AgentPublishingTab />", () => {
  it("shows the Not published empty state and opens the Publish dialog prefilled from the agent", async () => {
    mountAgentHandlers();
    server.use(http.get("/v1/agents/agent_1/publications", () => HttpResponse.json({ data: [] })));
    renderTab();

    await waitFor(() => expect(screen.getByText("Not published")).toBeInTheDocument());

    // Toolbar + empty-state both render a "+ Publish as bot" button (same
    // convention as AgentDeploymentsTab's "+ Create deployment"); either
    // opens the same dialog.
    const publishButtons = screen.getAllByRole("button", { name: "+ Publish as bot" });
    await userEvent.click(publishButtons[0]);

    await waitFor(() => expect(screen.getByText("Publish as public bot")).toBeInTheDocument());
    // Slug + title prefilled from the agent name.
    expect(screen.getByDisplayValue("my-agent")).toBeInTheDocument();
    expect(screen.getByDisplayValue("My Agent")).toBeInTheDocument();
  });

  it("links to the agent's test-chat page in a new tab (issue #227)", async () => {
    mountAgentHandlers();
    server.use(http.get("/v1/agents/agent_1/publications", () => HttpResponse.json({ data: [] })));
    renderTab();

    await waitFor(() => expect(screen.getByText("Not published")).toBeInTheDocument());

    const link = screen.getByRole("link", { name: /open test chat/i });
    expect(link).toHaveAttribute("href", "/publish/agent_1");
    expect(link).toHaveAttribute("target", "_blank");
    // Keyboard accessible: real <a>, focusable and activatable — no onClick-only handler.
    expect(link.tagName).toBe("A");
  });

  it("publishes an agent live and lists it", async () => {
    mountAgentHandlers();
    const pubs: Publication[] = [];
    let posted: Record<string, unknown> | undefined;
    server.use(
      http.get("/v1/agents/agent_1/publications", () => HttpResponse.json({ data: pubs })),
      http.post("/v1/agents/agent_1/publications", async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        const created = pub({ ...posted, id: "pub_new" } as Partial<Publication>);
        pubs.push(created);
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    renderTab();

    await waitFor(() => expect(screen.getByText("Not published")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("button", { name: "+ Publish as bot" })[0]);
    await waitFor(() => expect(screen.getByText("Publish as public bot")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() =>
      expect(posted).toMatchObject({
        slug: "my-agent",
        title: "My Agent",
        visibility: "public",
        environment_id: null,
        status: "live",
      }),
    );
    // Dialog closes and the new publication now shows up as live.
    await waitFor(() =>
      expect(screen.queryByText("Publish as public bot")).not.toBeInTheDocument(),
    );
    expect(await screen.findByText("/p/my-agent")).toBeInTheDocument();
    expect(screen.getByText("live")).toBeInTheDocument();
  });

  it("includes the selected environment_id when one is picked (issue #225)", async () => {
    mountAgentHandlers();
    const pubs: Publication[] = [];
    let posted: Record<string, unknown> | undefined;
    server.use(
      http.get("/v1/environments", () =>
        HttpResponse.json({ data: [{ id: "env_1", name: "Prod" }] }),
      ),
      http.get("/v1/agents/agent_1/publications", () => HttpResponse.json({ data: pubs })),
      http.post("/v1/agents/agent_1/publications", async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        const created = pub({ ...posted, id: "pub_new" } as Partial<Publication>);
        pubs.push(created);
        return HttpResponse.json(created, { status: 201 });
      }),
    );
    renderTab();

    await waitFor(() => expect(screen.getByText("Not published")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("button", { name: "+ Publish as bot" })[0]);
    await waitFor(() => expect(screen.getByText("Publish as public bot")).toBeInTheDocument());

    await userEvent.click(
      screen.getByText("No environment — required for cloud agents to chat"),
    );
    await waitFor(() => expect(screen.getByText("Prod")).toBeInTheDocument());
    await userEvent.click(screen.getByText("Prod"));

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(posted).toMatchObject({ environment_id: "env_1" }));
  });

  it("shows an inline slug error on a 409 conflict and keeps the dialog open", async () => {
    mountAgentHandlers();
    server.use(
      http.get("/v1/agents/agent_1/publications", () => HttpResponse.json({ data: [] })),
      http.post("/v1/agents/agent_1/publications", () =>
        HttpResponse.json({ error: "Slug already in use" }, { status: 409 }),
      ),
    );
    renderTab();

    await waitFor(() => expect(screen.getByText("Not published")).toBeInTheDocument());
    await userEvent.click(screen.getAllByRole("button", { name: "+ Publish as bot" })[0]);
    await waitFor(() => expect(screen.getByText("Publish as public bot")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));

    expect(await screen.findByText("Slug already in use")).toBeInTheDocument();
    // Dialog stays open so the user can fix the slug.
    expect(screen.getByText("Publish as public bot")).toBeInTheDocument();
  });

  it("pauses a live publication via the row actions menu", async () => {
    mountAgentHandlers();
    const pubs: Publication[] = [pub()];
    let patched: Record<string, unknown> | undefined;
    server.use(
      http.get("/v1/agents/agent_1/publications", () => HttpResponse.json({ data: pubs })),
      http.patch("/v1/agents/agent_1/publications/pub_1", async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        pubs[0] = { ...pubs[0], ...patched } as Publication;
        return HttpResponse.json(pubs[0]);
      }),
    );
    renderTab();

    expect(await screen.findByText("live")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Actions for My Agent" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Pause" }));

    await waitFor(() => expect(patched).toEqual({ status: "paused" }));
    await waitFor(() => expect(screen.getByText("paused")).toBeInTheDocument());
  });

  it("resumes a paused publication via the row actions menu", async () => {
    mountAgentHandlers();
    const pubs: Publication[] = [pub({ status: "paused" })];
    let patched: Record<string, unknown> | undefined;
    server.use(
      http.get("/v1/agents/agent_1/publications", () => HttpResponse.json({ data: pubs })),
      http.patch("/v1/agents/agent_1/publications/pub_1", async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        pubs[0] = { ...pubs[0], ...patched } as Publication;
        return HttpResponse.json(pubs[0]);
      }),
    );
    renderTab();

    expect(await screen.findByText("paused")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Actions for My Agent" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Resume" }));

    await waitFor(() => expect(patched).toEqual({ status: "live" }));
    await waitFor(() => expect(screen.getByText("live")).toBeInTheDocument());
  });

  it("edits a published bot's title/description/greeting/visibility/slug (issue #237)", async () => {
    mountAgentHandlers();
    const pubs: Publication[] = [pub()];
    let patched: Record<string, unknown> | undefined;
    server.use(
      http.get("/v1/agents/agent_1/publications", () => HttpResponse.json({ data: pubs })),
      http.patch("/v1/agents/agent_1/publications/pub_1", async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        pubs[0] = { ...pubs[0], ...patched } as Publication;
        return HttpResponse.json(pubs[0]);
      }),
    );
    renderTab();

    expect(await screen.findByText("live")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Actions for My Agent" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));

    await waitFor(() => expect(screen.getByText("Edit My Agent")).toBeInTheDocument());
    // Prefilled from the existing publication.
    expect(screen.getByDisplayValue("my-agent")).toBeInTheDocument();
    expect(screen.getByDisplayValue("My Agent")).toBeInTheDocument();

    const titleInput = screen.getByDisplayValue("My Agent");
    await userEvent.clear(titleInput);
    await userEvent.type(titleInput, "Renamed Bot");

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(patched).toMatchObject({
        slug: "my-agent",
        title: "Renamed Bot",
        visibility: "public",
      }),
    );
    // Dialog closes and the table reflects the new title.
    await waitFor(() => expect(screen.queryByText("Edit My Agent")).not.toBeInTheDocument());
    expect(await screen.findByText("Renamed Bot")).toBeInTheDocument();
  });

  it("shows an inline slug error on a 409 conflict while editing and keeps the dialog open", async () => {
    mountAgentHandlers();
    const pubs: Publication[] = [pub()];
    server.use(
      http.get("/v1/agents/agent_1/publications", () => HttpResponse.json({ data: pubs })),
      http.patch("/v1/agents/agent_1/publications/pub_1", () =>
        HttpResponse.json({ error: "Slug already in use" }, { status: 409 }),
      ),
    );
    renderTab();

    expect(await screen.findByText("live")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Actions for My Agent" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: "Edit" }));
    await waitFor(() => expect(screen.getByText("Edit My Agent")).toBeInTheDocument());

    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Slug already in use")).toBeInTheDocument();
    expect(screen.getByText("Edit My Agent")).toBeInTheDocument();
  });

  it("shows an error state with Retry instead of the empty state when the fetch fails", async () => {
    mountAgentHandlers();
    server.use(
      http.get("/v1/agents/agent_1/publications", () =>
        HttpResponse.json({ error: "Internal error" }, { status: 500 }),
      ),
    );
    renderTab();

    await waitFor(() =>
      expect(screen.getByText("Couldn't load publications")).toBeInTheDocument(),
    );
    expect(screen.getByText("Internal error")).toBeInTheDocument();
    expect(screen.queryByText("Not published")).not.toBeInTheDocument();

    server.use(http.get("/v1/agents/agent_1/publications", () => HttpResponse.json({ data: [] })));
    await userEvent.click(screen.getByRole("button", { name: "Retry" }));

    await waitFor(() => expect(screen.getByText("Not published")).toBeInTheDocument());
  });
});

import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../mocks/server";
import { ConfirmProvider } from "../hooks/useConfirm";
import { SessionsList } from "./SessionsList";

const agent = {
  id: "agent_digest",
  name: "Nightly Digest Bot",
};

const session = {
  id: "sess_1",
  title: "Nightly digest",
  agent: { id: "agent_digest", version: 1 },
  environment_id: "env_1",
  status: "running",
  created_at: "2026-01-01T00:00:00.000Z",
};

/** Aux lists the create modal + filter chip need on mount. Keep them empty
 *  (or agent-only) so assertions stay on the sessions table itself. */
function mountAux({ agents = [agent] }: { agents?: typeof agent[] } = {}) {
  server.use(
    http.get("/v1/agents", () => HttpResponse.json({ data: agents })),
    http.get("/v1/environments", () => HttpResponse.json({ data: [] })),
    http.get("/v1/vaults", () => HttpResponse.json({ data: [] })),
    http.get("/v1/files", () => HttpResponse.json({ data: [] })),
    http.get("/v1/memory_stores", () => HttpResponse.json({ data: [] })),
  );
}

function renderPage(initialPath = "/sessions") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <SessionsList />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

async function sessionRow(title: string) {
  const cell = await screen.findByText(title);
  const row = cell.closest("tr");
  if (!row) throw new Error(`no <tr> for session "${title}"`);
  return within(row);
}

describe("<SessionsList /> agent names", () => {
  it("resolves agent id to a display name when /v1/agents has the agent", async () => {
    mountAux();
    server.use(
      http.get("/v1/sessions", () =>
        HttpResponse.json({ data: [session] }),
      ),
    );

    renderPage();

    const row = await sessionRow("Nightly digest");
    expect(row.getByText("Nightly Digest Bot")).toBeInTheDocument();
    // Mono id stays on the tooltip, not as the primary label.
    expect(row.queryByText("agent_digest")).toBeNull();
    expect(
      row.getByTitle("Nightly Digest Bot (agent_digest)"),
    ).toBeInTheDocument();
  });

  it("falls back to mono agent id when the agent is missing from the list", async () => {
    mountAux({ agents: [] });
    server.use(
      http.get("/v1/sessions", () =>
        HttpResponse.json({ data: [session] }),
      ),
    );

    renderPage();

    const row = await sessionRow("Nightly digest");
    expect(row.getByText("agent_digest")).toBeInTheDocument();
    expect(row.queryByText("Nightly Digest Bot")).toBeNull();
  });
});

describe("<SessionsList /> status URL deep-link", () => {
  // Filter chips portal into AppShell's pageHeaderSlot; without that
  // shell the chip UI is null. Assert the deep-link via the query the
  // list actually sends (and the rows that only arrive under that
  // filter) — same contract Overview's Active sessions card relies on.
  it("seeds the status filter from ?status=running and requests that filter", async () => {
    mountAux();
    const seenStatuses: string[] = [];
    server.use(
      http.get("/v1/sessions", ({ request }) => {
        const url = new URL(request.url);
        seenStatuses.push(url.searchParams.get("status") ?? "");
        // Only return the row when the server filter is applied so a
        // missing status param can't accidentally green the assertion.
        if (url.searchParams.get("status") === "running") {
          return HttpResponse.json({ data: [session] });
        }
        return HttpResponse.json({ data: [] });
      }),
    );

    renderPage("/sessions?status=running");

    await waitFor(() =>
      expect(seenStatuses.some((s) => s === "running")).toBe(true),
    );
    expect(await screen.findByText("Nightly digest")).toBeInTheDocument();
  });

  it("ignores unknown ?status= values so the list is not stuck empty", async () => {
    mountAux();
    const seenStatuses: string[] = [];
    server.use(
      http.get("/v1/sessions", ({ request }) => {
        const url = new URL(request.url);
        seenStatuses.push(url.searchParams.get("status") ?? "");
        return HttpResponse.json({ data: [session] });
      }),
    );

    renderPage("/sessions?status=nope");

    // No status filter sent; unknown value fell back to "any".
    await waitFor(() => expect(seenStatuses.length).toBeGreaterThan(0));
    expect(seenStatuses.every((s) => s === "")).toBe(true);
    expect(await screen.findByText("Nightly digest")).toBeInTheDocument();
  });
});

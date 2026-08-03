// Config-panel behaviour of the Kanban "GitHub Issues" board. The repo and
// assignee fields both read proxied, server-cached lists, and both have to
// stay usable when that list is missing — a picker with nothing in it is a
// control that visibly does nothing.

import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { GitHubIssuesBoard } from "./GitHubIssuesBoard";

const INSTALLATION = "ghi_1";

function renderBoard() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <GitHubIssuesBoard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function installations() {
  return http.get("/v1/integrations/github/installations", () =>
    HttpResponse.json({
      data: [{ id: INSTALLATION, workspace_name: "acme", vault_id: "vlt_1" }],
    }),
  );
}

describe("<GitHubIssuesBoard /> config panel", () => {
  it("offers the fetched repos in the picker, with no free-text fallback", async () => {
    let repoCalls = 0;
    server.use(
      installations(),
      http.get(`/v1/integrations/github/installations/${INSTALLATION}/repos`, () => {
        repoCalls += 1;
        return HttpResponse.json({
          data: [
            { owner: "acme", name: "widgets", full_name: "acme/widgets", private: false },
          ],
        });
      }),
      http.get(`/v1/integrations/github/installations/${INSTALLATION}/assignees`, () =>
        HttpResponse.json({ data: [] }),
      ),
    );
    renderBoard();

    await waitFor(() => expect(repoCalls).toBe(1));
    expect(await screen.findByLabelText("Select repository…")).toBeInTheDocument();
    expect(screen.queryByTestId("gh-board-repo-input")).toBeNull();
  });

  it("falls back to typing a slug when the repo list fails, and can retry", async () => {
    let repoCalls = 0;
    server.use(
      installations(),
      http.get(`/v1/integrations/github/installations/${INSTALLATION}/repos`, () => {
        repoCalls += 1;
        return HttpResponse.json({ error: "installation lost access" }, { status: 502 });
      }),
    );
    renderBoard();

    expect(await screen.findByTestId("gh-board-repo-input")).toBeInTheDocument();
    expect(screen.getByText(/installation lost access/)).toBeInTheDocument();

    const before = repoCalls;
    screen.getByRole("button", { name: "Retry" }).click();
    await waitFor(() => expect(repoCalls).toBeGreaterThan(before));
  });

  it("falls back to typing a slug when the installation exposes no repos", async () => {
    server.use(
      installations(),
      http.get(`/v1/integrations/github/installations/${INSTALLATION}/repos`, () =>
        HttpResponse.json({ data: [] }),
      ),
    );
    renderBoard();

    expect(await screen.findByTestId("gh-board-repo-input")).toBeInTheDocument();
    expect(screen.getByText(/exposes no repositories/)).toBeInTheDocument();
  });

  it("does not request assignees until a repo slug is selected", async () => {
    let assigneeCalls = 0;
    server.use(
      installations(),
      http.get(`/v1/integrations/github/installations/${INSTALLATION}/repos`, () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get(`/v1/integrations/github/installations/${INSTALLATION}/assignees`, () => {
        assigneeCalls += 1;
        return HttpResponse.json({ data: [] });
      }),
    );
    renderBoard();

    await screen.findByTestId("gh-board-repo-input");
    expect(assigneeCalls).toBe(0);
  });

  it("offers fetched logins as combobox options while still accepting free text", async () => {
    localStorage.setItem(
      "oma.kanban.github-board.v1",
      JSON.stringify({ installationId: INSTALLATION, repo: "acme/widgets", state: "open" }),
    );
    server.use(
      installations(),
      http.get(`/v1/integrations/github/installations/${INSTALLATION}/repos`, () =>
        HttpResponse.json({
          data: [
            { owner: "acme", name: "widgets", full_name: "acme/widgets", private: false },
          ],
        }),
      ),
      http.get(`/v1/integrations/github/installations/${INSTALLATION}/assignees`, ({ request }) => {
        expect(new URL(request.url).searchParams.get("repo")).toBe("acme/widgets");
        return HttpResponse.json({
          data: [{ login: "octocat", avatar_url: null }, { login: "hubot", avatar_url: null }],
        });
      }),
      http.get(`/v1/integrations/github/installations/${INSTALLATION}/issues`, () =>
        HttpResponse.json({ data: [], total_count: 0 }),
      ),
    );
    renderBoard();

    const input = await screen.findByTestId("gh-board-assignee-input");
    await waitFor(() =>
      expect(screen.getByTestId("gh-board-assignee-options")).toBeInTheDocument(),
    );
    const options = Array.from(
      screen.getByTestId("gh-board-assignee-options").querySelectorAll("option"),
    ).map((o) => o.getAttribute("value"));
    expect(options).toEqual(["octocat", "hubot", "none"]);
    // The list is a suggestion, not a constraint — the field stays free text.
    expect(input).toHaveAttribute("list", "gh-board-assignees");
    expect(input.tagName).toBe("INPUT");
    localStorage.clear();
  });

  it("keeps the assignee field as plain free text when no assignees resolve", async () => {
    localStorage.setItem(
      "oma.kanban.github-board.v1",
      JSON.stringify({ installationId: INSTALLATION, repo: "acme/widgets", state: "open" }),
    );
    server.use(
      installations(),
      http.get(`/v1/integrations/github/installations/${INSTALLATION}/repos`, () =>
        HttpResponse.json({ data: [] }),
      ),
      http.get(`/v1/integrations/github/installations/${INSTALLATION}/assignees`, () =>
        HttpResponse.json({ error: "no access" }, { status: 502 }),
      ),
      http.get(`/v1/integrations/github/installations/${INSTALLATION}/issues`, () =>
        HttpResponse.json({ data: [], total_count: 0 }),
      ),
    );
    renderBoard();

    const input = await screen.findByTestId("gh-board-assignee-input");
    await waitFor(() => expect(input).not.toHaveAttribute("list"));
    expect(screen.queryByTestId("gh-board-assignee-options")).toBeNull();
    localStorage.clear();
  });
});

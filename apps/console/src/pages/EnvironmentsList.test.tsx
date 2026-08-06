import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { ConfirmProvider } from "../hooks/useConfirm";
import { EnvironmentsList } from "./EnvironmentsList";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <MemoryRouter>
          <EnvironmentsList />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

/** Same as renderPage but with a real target route mounted at
 *  /environments/:id so a row-click/keyboard-activation navigation can be
 *  observed by asserting the sentinel destination renders. */
function renderPageWithDetailRoute() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={["/environments"]}>
          <Routes>
            <Route path="/environments" element={<EnvironmentsList />} />
            <Route path="/environments/:id" element={<div>ENV DETAIL env_123</div>} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

describe("<EnvironmentsList />", () => {
  it("opens the Add Environment dialog without crashing on the Instance Type select", async () => {
    server.use(
      http.get("/v1/environments", () => HttpResponse.json({ data: [] })),
      // Simulate a self-host response that also includes an empty-id entry —
      // the exact shape that previously crashed the page with "A
      // <Select.Item /> must have a value prop that is not an empty string."
      http.get("/v1/hosting_types", () =>
        HttpResponse.json({
          data: [
            { id: "", label: "Legacy" },
            { id: "cloud", label: "Cloudflare Sandbox" },
          ],
        }),
      ),
    );
    renderPage();

    await waitFor(() => expect(screen.getByText("No environments yet")).toBeInTheDocument());

    const addButtons = screen.getAllByRole("button", { name: "+ Add environment" });
    await userEvent.click(addButtons[0]);

    // The dialog renders (proves the Select.Item empty-value crash didn't
    // white-screen the page) and the "Provider default" sentinel option
    // is visible.
    await waitFor(() => expect(screen.getByText("Add Environment")).toBeInTheDocument());
    expect(screen.getByText("Provider default")).toBeInTheDocument();
  });

  it("only lists ready hosting types in the create dialog (drops needs_config / unavailable)", async () => {
    server.use(
      http.get("/v1/environments", () => HttpResponse.json({ data: [] })),
      http.get("/v1/hosting_types", () =>
        HttpResponse.json({
          data: [
            {
              id: "cloud",
              label: "Cloudflare Sandbox",
              availability: { state: "available", reason: "ok" },
            },
            {
              id: "subprocess",
              label: "Local (subprocess)",
              availability: { state: "available", reason: "bridge" },
            },
            {
              id: "boxrun",
              label: "BoxRun",
              availability: { state: "needs_config", reason: "Set BOXRUN_URL", missing_env: ["BOXRUN_URL"] },
            },
            {
              id: "k8s",
              label: "Kubernetes",
              availability: { state: "unavailable", reason: "Node-only" },
            },
          ],
        }),
      ),
    );
    renderPage();
    await waitFor(() => expect(screen.getByText("No environments yet")).toBeInTheDocument());

    await userEvent.click(screen.getAllByRole("button", { name: "+ Add environment" })[0]);
    await waitFor(() => expect(screen.getByText("Add Environment")).toBeInTheDocument());

    // Hosting Type is the first combobox (Instance Type may also render for cloud).
    const comboboxes = screen.getAllByRole("combobox");
    await userEvent.click(comboboxes[0]);

    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Cloudflare Sandbox" })).toBeInTheDocument();
    });
    expect(screen.getByRole("option", { name: "Local (subprocess)" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "BoxRun" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Kubernetes" })).not.toBeInTheDocument();
  });

  // Issue #182 — a failed list fetch must render a distinct error state
  // with a Retry action, never the "Nothing here yet" empty-state copy.
  it("shows an error state with Retry instead of the empty state when the fetch fails", async () => {
    server.use(
      http.get("/v1/environments", () => HttpResponse.json({ error: "Internal error" }, { status: 500 })),
      http.get("/v1/hosting_types", () => HttpResponse.json({ data: [] })),
    );
    renderPage();

    await waitFor(() =>
      expect(screen.getByText("Couldn't load environments")).toBeInTheDocument(),
    );
    expect(screen.getByText("Internal error")).toBeInTheDocument();
    expect(screen.queryByText("No environments yet")).not.toBeInTheDocument();

    const retryButton = screen.getByRole("button", { name: "Retry" });

    // Recovery: once the endpoint is healthy again, Retry re-fires the
    // fetch and the error state is replaced by the normal empty state.
    server.use(http.get("/v1/environments", () => HttpResponse.json({ data: [] })));
    await userEvent.click(retryButton);

    await waitFor(() => expect(screen.getByText("No environments yet")).toBeInTheDocument());
    expect(screen.queryByText("Couldn't load environments")).not.toBeInTheDocument();
  });

  // Issue #181 — a row that navigates on click must also be reachable and
  // activatable from the keyboard (Enter), not just the mouse.
  it("navigates to the environment detail page when Enter is pressed on a focused row", async () => {
    server.use(
      http.get("/v1/environments", () =>
        HttpResponse.json({
          data: [
            {
              id: "env_123",
              name: "env-alpha",
              config: { type: "cloud" },
              created_at: "2026-01-01T00:00:00.000Z",
            },
          ],
        }),
      ),
      http.get("/v1/hosting_types", () => HttpResponse.json({ data: [] })),
    );
    renderPageWithDetailRoute();

    await waitFor(() => expect(screen.getByText("env-alpha")).toBeInTheDocument());

    const row = screen.getByText("env-alpha").closest("tr");
    expect(row).not.toBeNull();
    expect(row).toHaveAttribute("tabindex", "0");
    expect(row).toHaveAttribute("role", "button");

    row!.focus();
    fireEvent.keyDown(row!, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("ENV DETAIL env_123")).toBeInTheDocument());
  });
});

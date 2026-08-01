import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { IntegrationsGitHubList } from "./IntegrationsGitHubList";

function installation(overrides: Record<string, unknown> = {}) {
  return {
    id: "ghinst_1",
    workspace_id: "42",
    workspace_name: "acme",
    install_kind: "dedicated",
    bot_login: "oma-app[bot]",
    vault_id: "vlt_1",
    created_at: Date.now(),
    ...overrides,
  };
}

/** Wire the four endpoints the page loads on mount. Installations default to
 *  one workspace-level install (no publications) unless overridden. */
function mockEndpoints(
  opts: {
    installations?: Record<string, unknown>[];
    publications?: Record<string, unknown>[];
    available?: boolean;
  } = {},
) {
  const installs = opts.installations ?? [installation()];
  server.use(
    http.get("/v1/integrations/github/managed-availability", () =>
      HttpResponse.json({ available: opts.available ?? true }),
    ),
    http.get("/v1/integrations/github/installations", () =>
      HttpResponse.json({ data: installs }),
    ),
    http.get("/v1/integrations/github/publications", () =>
      HttpResponse.json({ data: [] }),
    ),
    http.get("/v1/integrations/github/installations/:id/publications", () =>
      HttpResponse.json({ data: opts.publications ?? [] }),
    ),
  );
}

function renderPage(entry = "/integrations/github") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <IntegrationsGitHubList />
    </MemoryRouter>,
  );
}

describe("<IntegrationsGitHubList />", () => {
  it("shows an installed org with a bind-agent CTA when it has no agents bound", async () => {
    mockEndpoints();
    renderPage();
    // The workspace-level install renders its org login…
    expect(await screen.findByText("acme")).toBeInTheDocument();
    // …and prompts the user to bind an agent (the below-the-fold step).
    expect(screen.getByText(/No agents bound yet/i)).toBeInTheDocument();
    const cta = screen.getByRole("link", { name: /Bind an agent/i });
    expect(cta).toHaveAttribute("href", "/integrations/github/bind?mode=managed");
  });

  it("surfaces the connected org on the ?managed_install=ok redirect", async () => {
    mockEndpoints();
    renderPage("/integrations/github?managed_install=ok&login=acme");
    await waitFor(() =>
      expect(screen.getByText(/Connected/i)).toBeInTheDocument(),
    );
    // The org login is echoed from the redirect query (?login=).
    expect(screen.getAllByText(/@acme/).length).toBeGreaterThan(0);
  });

  it("treats ?connected=1 as the success signal", async () => {
    mockEndpoints();
    renderPage("/integrations/github?connected=1&login=acme");
    await waitFor(() => expect(screen.getByText(/Connected/i)).toBeInTheDocument());
  });

  it("lists every connected account with its installation id and a disconnect action", async () => {
    mockEndpoints({
      installations: [
        installation(),
        installation({ id: "ghinst_2", workspace_id: "77", workspace_name: "widgets-inc" }),
      ],
    });
    const deleted: string[] = [];
    server.use(
      http.delete("/v1/integrations/github/installations/:id", ({ params }) => {
        deleted.push(String(params.id));
        return HttpResponse.json({ id: params.id, status: "disconnected" });
      }),
    );
    renderPage();

    expect(await screen.findByText("acme")).toBeInTheDocument();
    expect(screen.getByText("widgets-inc")).toBeInTheDocument();
    // The numeric GitHub installation id is shown per account.
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("77")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /Add another account/i }),
    ).toBeInTheDocument();

    await userEvent.click(screen.getAllByRole("button", { name: "Disconnect" })[0]);
    await waitFor(() => expect(deleted).toEqual(["ghinst_1"]));
    // Only the disconnected account disappears.
    await waitFor(() => expect(screen.queryByText("acme")).not.toBeInTheDocument());
    expect(screen.getByText("widgets-inc")).toBeInTheDocument();
  });

  it("starts the real managed-app install via a top-level navigation", async () => {
    mockEndpoints();
    const assign = vi.fn();
    const original = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, origin: original.origin, assign },
    });
    try {
      renderPage();
      await screen.findByText("acme");
      // ConnectModeChooser renders the managed path's Connect first.
      const [managedConnect] = screen.getAllByRole("button", { name: "Connect" });
      await userEvent.click(managedConnect);
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: original,
      });
    }
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign.mock.calls[0][0]).toContain(
      "/v1/integrations/github/managed/connect?returnUrl=",
    );
  });
});

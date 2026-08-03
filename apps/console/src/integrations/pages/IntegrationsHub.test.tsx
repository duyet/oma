import { describe, expect, it } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { IntegrationsHub } from "./IntegrationsHub";

/** Wire the three provider list endpoints the gallery reads on mount. */
function mockInstallations(
  opts: { github?: unknown[]; linear?: unknown[]; slack?: unknown[] } = {},
) {
  server.use(
    http.get("/v1/integrations/github/installations", () =>
      HttpResponse.json({ data: opts.github ?? [] }),
    ),
    http.get("/v1/integrations/linear/installations", () =>
      HttpResponse.json({ data: opts.linear ?? [] }),
    ),
    http.get("/v1/integrations/slack/installations", () =>
      HttpResponse.json({ data: opts.slack ?? [] }),
    ),
  );
}

function renderPage(entry = "/integrations") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <IntegrationsHub />
    </MemoryRouter>,
  );
}

/** Rows move between sections as status resolves, so always re-query the row
 *  rather than holding a node reference across a re-render. */
const row = (id: string) => screen.getByTestId(`integration-${id}`);

describe("<IntegrationsHub />", () => {
  it("reflects the live GitHub install state, and leaves other providers unconnected", async () => {
    mockInstallations({ github: [{ id: "ghinst_1", workspace_name: "acme" }] });
    renderPage();

    await waitFor(() =>
      expect(within(row("github")).getByText(/^Connected/)).toBeTruthy(),
    );
    // A connected provider gets the overflow menu; the Connect CTA only
    // makes sense before the first install.
    expect(within(row("github")).getByLabelText("GitHub options")).toBeTruthy();

    expect(within(row("slack")).queryByText("Not connected")).toBeNull();
    expect(within(row("slack")).getByRole("link", { name: "Connect" })).toBeTruthy();
  });

  it("lifts connected providers into a Connected section above the categories", async () => {
    mockInstallations({ linear: [{ id: "lin_1" }] });
    renderPage();

    await waitFor(() =>
      expect(within(row("linear")).getByText(/^Connected/)).toBeTruthy(),
    );
    const headings = screen
      .getAllByRole("heading", { level: 2 })
      .map((h) => h.textContent);
    expect(headings[0]).toBe("Connected");
    expect(headings).toContain("Development");
    // Linear left its category section for the Connected one.
    expect(headings).not.toContain("Productivity");
  });

  it("filters rows by the search box", async () => {
    mockInstallations();
    renderPage();
    await waitFor(() =>
      expect(within(row("github")).getByRole("link", { name: "Connect" })).toBeTruthy(),
    );

    await userEvent.type(screen.getByLabelText("Search integrations"), "slack");

    expect(screen.getByTestId("integration-slack")).toBeTruthy();
    expect(screen.queryByTestId("integration-github")).toBeNull();
  });

  it("renders a provider with no status API as not connected but still linked", async () => {
    mockInstallations();
    renderPage();

    await waitFor(() =>
      expect(within(row("telegram")).getByRole("link", { name: "Set up" })).toBeTruthy(),
    );
    const link = within(row("telegram")).getByRole("link", { name: "Set up" });
    expect(link.getAttribute("href")).toBe("/integrations/telegram");
  });
});

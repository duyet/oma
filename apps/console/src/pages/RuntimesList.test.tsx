import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { ConfirmProvider } from "../hooks/useConfirm";
import { RuntimesList } from "./RuntimesList";

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConfirmProvider>
        <MemoryRouter>
          <RuntimesList />
        </MemoryRouter>
      </ConfirmProvider>
    </QueryClientProvider>,
  );
}

function browserVmProvider(overrides: Record<string, unknown> = {}) {
  return {
    id: "browser-vm",
    label: "Browser VM (WASM)",
    description: "Agent sandbox running as a WASM VM inside a user's browser tab.",
    type: "system",
    provider: "browser-vm",
    external: false,
    capabilities: ["exec", "files"],
    health: {
      status: "not_configured",
      latency_ms: 0,
      last_checked: new Date().toISOString(),
      reason: "No browser sandbox tab connected.",
    },
    ...overrides,
  };
}

describe("<RuntimesList /> browser-vm", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mints a pairing code and opens the composed /sandbox-tab URL", async () => {
    server.use(
      http.get("/v1/hosting_types", () => HttpResponse.json({ data: [browserVmProvider()] })),
      http.get("/v1/runtimes", () => HttpResponse.json({ runtimes: [] })),
      http.post("/v1/runtimes/connect-runtime", async ({ request }) => {
        const body = (await request.json()) as { state?: string };
        expect(body.state).toBeTruthy();
        expect(body.state!.length).toBeGreaterThanOrEqual(8);
        return HttpResponse.json({ code: "deadbeef", expires_at: 1234567890 });
      }),
    );

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    renderPage();

    await waitFor(() => expect(screen.getByText("Browser VM (WASM)")).toBeInTheDocument());

    const button = await screen.findByRole("button", { name: "Open sandbox tab" });
    await userEvent.click(button);

    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    const [openedUrl, target] = openSpy.mock.calls[0];
    const url = new URL(String(openedUrl));
    expect(url.pathname).toBe("/sandbox-tab");
    expect(url.searchParams.get("code")).toBe("deadbeef");
    expect(url.searchParams.get("state")).toBeTruthy();
    expect(url.searchParams.get("state")!.length).toBeGreaterThanOrEqual(8);
    expect(target).toBe("_blank");
  });

  it("shows the health reason and no generic Set up button for browser-vm when not configured", async () => {
    server.use(
      http.get("/v1/hosting_types", () => HttpResponse.json({ data: [browserVmProvider()] })),
      http.get("/v1/runtimes", () => HttpResponse.json({ runtimes: [] })),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText("Browser VM (WASM)")).toBeInTheDocument());
    expect(screen.getByText("No browser sandbox tab connected.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Set up" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open sandbox tab" })).toBeInTheDocument();
  });

  it("surfaces a toast and does not open a tab when the mint call fails (not signed in)", async () => {
    server.use(
      http.get("/v1/hosting_types", () => HttpResponse.json({ data: [browserVmProvider()] })),
      http.get("/v1/runtimes", () => HttpResponse.json({ runtimes: [] })),
      http.post("/v1/runtimes/connect-runtime", () =>
        HttpResponse.json({ error: "unauthorized" }, { status: 401 }),
      ),
    );

    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);

    renderPage();

    await waitFor(() => expect(screen.getByText("Browser VM (WASM)")).toBeInTheDocument());
    const button = await screen.findByRole("button", { name: "Open sandbox tab" });
    await userEvent.click(button);

    // Give the rejected mutation a tick to settle before asserting the
    // negative — no tab should ever open on a failed mint.
    await waitFor(() => expect(button).toBeEnabled());
    expect(openSpy).not.toHaveBeenCalled();
  });
});

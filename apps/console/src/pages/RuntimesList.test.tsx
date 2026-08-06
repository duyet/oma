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

function provider(overrides: Record<string, unknown> = {}) {
  return {
    id: "cloud",
    label: "Cloudflare Sandbox",
    description: "Managed sandbox — uses Cloudflare Containers.",
    type: "system",
    provider: "cloud",
    external: false,
    capabilities: ["exec", "files"],
    health: null,
    ...overrides,
  };
}

describe("<RuntimesList /> provider availability", () => {
  it("renders an unavailable provider's reason instead of omitting it", async () => {
    server.use(
      http.get("/v1/hosting_types", () =>
        HttpResponse.json({
          runtime: "cloudflare",
          data: [
            provider(),
            provider({
              id: "k8s",
              label: "Kubernetes",
              provider: "k8s",
              availability: {
                state: "unavailable",
                reason: "Kubernetes is Node-only — use the self-host Node runtime instead.",
              },
            }),
          ],
        }),
      ),
      http.get("/v1/runtimes", () => HttpResponse.json({ runtimes: [] })),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText("Cloudflare Sandbox")).toBeInTheDocument());
    // Unavailable providers land on the Offline tab in the unified list.
    await userEvent.click(screen.getByRole("tab", { name: /Offline/i }));
    await waitFor(() => expect(screen.getByText("Kubernetes")).toBeInTheDocument());
    expect(
      screen.getByText("Kubernetes is Node-only — use the self-host Node runtime instead."),
    ).toBeInTheDocument();
    expect(screen.getByText("Unavailable here")).toBeInTheDocument();
  });

  it("shows the missing secret for a provider that needs configuration", async () => {
    server.use(
      http.get("/v1/hosting_types", () =>
        HttpResponse.json({
          runtime: "cloudflare",
          data: [
            provider({
              id: "boxrun",
              label: "BoxRun (remote micro-VM)",
              provider: "boxrun",
              availability: {
                state: "needs_config",
                reason: "Requires the BOXRUN_URL secret.",
                missing_env: ["BOXRUN_URL"],
              },
            }),
          ],
        }),
      ),
      http.get("/v1/runtimes", () => HttpResponse.json({ runtimes: [] })),
    );

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("BoxRun (remote micro-VM)")).toBeInTheDocument(),
    );
    expect(screen.getByText("Needs config")).toBeInTheDocument();
    // The missing-secret chip lives in the same note as the reason; scope to
    // it because the page's setup help copy also mentions env var names.
    const note = screen.getByText("Requires the BOXRUN_URL secret.").parentElement!;
    expect(note).toHaveTextContent("BOXRUN_URL");
    // Still usable here — it stays in the main grid, not the unavailable list.
    expect(screen.queryByText(/Not available on this deployment/)).not.toBeInTheDocument();
  });

  it("names the deployment the availability applies to", async () => {
    server.use(
      http.get("/v1/hosting_types", () =>
        HttpResponse.json({ runtime: "node", data: [provider()] }),
      ),
      http.get("/v1/runtimes", () => HttpResponse.json({ runtimes: [] })),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText("Cloudflare Sandbox")).toBeInTheDocument());
    expect(screen.getByText(/Self-host Node runtime/)).toBeInTheDocument();
  });

  it("offers no Set up button for a provider that cannot run here", async () => {
    server.use(
      http.get("/v1/hosting_types", () =>
        HttpResponse.json({
          runtime: "cloudflare",
          data: [
            provider({
              id: "docker-compose",
              label: "Docker Compose",
              provider: "docker-compose",
              health: {
                status: "not_configured",
                latency_ms: 0,
                last_checked: new Date().toISOString(),
                reason: "Not configured.",
              },
              availability: {
                state: "unavailable",
                reason: "Docker Compose is Node-only — it needs a Docker socket.",
              },
            }),
          ],
        }),
      ),
      http.get("/v1/runtimes", () => HttpResponse.json({ runtimes: [] })),
    );

    renderPage();

    await waitFor(() => expect(screen.getByText("Docker Compose")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Set up" })).not.toBeInTheDocument();
  });
});

// Add is a single dropdown that lists every setup path (connect machine,
// register provider, register k8s, open browser tab) — no separate header
// buttons and no Your machines / Built-in providers section split.
describe("<RuntimesList /> Add menu + Online/Offline tabs", () => {
  it("opens setup dialogs from the Add dropdown and shows Online/Offline tabs", async () => {
    server.use(
      http.get("/v1/hosting_types", () =>
        HttpResponse.json({ runtime: "cloudflare", data: [provider()] }),
      ),
      http.get("/v1/runtimes", () => HttpResponse.json({ runtimes: [] })),
    );

    renderPage();

    await waitFor(() => expect(screen.getByRole("button", { name: /Add/i })).toBeInTheDocument());
    expect(screen.getByRole("tab", { name: /Online/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Offline/i })).toBeInTheDocument();
    // Unified list — no section headers for machines vs built-in.
    expect(screen.queryByText("Your machines")).not.toBeInTheDocument();
    expect(screen.queryByText("Built-in providers")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Add/i }));
    await waitFor(() =>
      expect(screen.getByRole("menuitem", { name: /Connect machine/i })).toBeInTheDocument(),
    );
    expect(screen.getByRole("menuitem", { name: /Register provider/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Register k8s cluster/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Open sandbox tab/i })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("menuitem", { name: /Connect machine/i }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "Connect a machine" })).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Done" }));

    await userEvent.click(screen.getByRole("button", { name: /Add/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Register provider/i }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Register a sandbox provider" }),
      ).toBeInTheDocument(),
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await userEvent.click(screen.getByRole("button", { name: /Add/i }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Register k8s cluster/i }));
    await waitFor(() =>
      expect(
        screen.getByRole("heading", { name: "Register a Kubernetes cluster" }),
      ).toBeInTheDocument(),
    );
  });
});

import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { NewSessionDialog } from "./NewSessionDialog";

function renderDialog(props: Partial<Parameters<typeof NewSessionDialog>[0]> = {}) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onCreated = props.onCreated ?? (() => {});
  return {
    onCreated,
    ...render(
      <QueryClientProvider client={queryClient}>
        <NewSessionDialog
          open
          onClose={() => {}}
          agentId="agt_1"
          isLocalRuntime={false}
          onCreated={onCreated}
          {...props}
        />
      </QueryClientProvider>,
    ),
  };
}

describe("<NewSessionDialog />", () => {
  it("preselects the tenant's single environment and includes it in the create body, plus an optional initial message", async () => {
    server.use(
      http.get("/v1/environments", () =>
        HttpResponse.json({ data: [{ id: "env_1", name: "Default" }] }),
      ),
      http.get("/v1/environments/env_1", () =>
        HttpResponse.json({ id: "env_1", name: "Default" }),
      ),
      http.get("/v1/vaults", () => HttpResponse.json({ data: [] })),
      http.get("/v1/agents/agt_1", () =>
        HttpResponse.json({ id: "agt_1", mcp_servers: [] }),
      ),
    );
    let createBody: unknown = null;
    let eventsBody: unknown = null;
    server.use(
      http.post("/v1/sessions", async ({ request }) => {
        createBody = await request.json();
        return HttpResponse.json({ id: "sess_1" });
      }),
      http.post("/v1/sessions/sess_1/events", async ({ request }) => {
        eventsBody = await request.json();
        return HttpResponse.json({ ok: true });
      }),
    );

    let created: string | null = null;
    renderDialog({ onCreated: (id) => { created = id; } });

    // Single environment is preselected — no manual pick needed.
    await waitFor(() => expect(screen.getByText(/Default/)).toBeInTheDocument());

    await userEvent.type(
      screen.getByPlaceholderText(/what should this session do/i),
      "Get started",
    );
    await userEvent.click(screen.getByRole("button", { name: "Create session" }));

    await waitFor(() =>
      expect(createBody).toEqual({ agent: "agt_1", environment_id: "env_1" }),
    );
    await waitFor(() =>
      expect(eventsBody).toEqual({
        events: [{ type: "user.message", content: [{ type: "text", text: "Get started" }] }],
      }),
    );
    await waitFor(() => expect(created).toBe("sess_1"));
  });

  it("creates a default cloud environment inline when the tenant has none", async () => {
    let envList: Array<{ id: string; name: string }> = [];
    let envBody: unknown = null;
    let createBody: unknown = null;
    server.use(
      http.get("/v1/environments", () => HttpResponse.json({ data: envList })),
      http.get("/v1/environments/env_new", () =>
        HttpResponse.json({ id: "env_new", name: "Default" }),
      ),
      http.get("/v1/vaults", () => HttpResponse.json({ data: [] })),
      http.get("/v1/agents/agt_1", () =>
        HttpResponse.json({ id: "agt_1", mcp_servers: [] }),
      ),
      http.post("/v1/environments", async ({ request }) => {
        envBody = await request.json();
        const created = { id: "env_new", name: "Default" };
        envList = [created];
        return HttpResponse.json(created, { status: 201 });
      }),
      http.post("/v1/sessions", async ({ request }) => {
        createBody = await request.json();
        return HttpResponse.json({ id: "sess_1" });
      }),
    );

    let created: string | null = null;
    renderDialog({ onCreated: (id) => { created = id; } });

    const createEnv = await screen.findByRole("button", {
      name: "Create default environment",
    });
    expect(screen.getByRole("button", { name: "Create session" })).toBeDisabled();
    expect(screen.queryByRole("link", { name: /create an environment/i })).not.toBeInTheDocument();

    await userEvent.click(createEnv);

    await waitFor(() =>
      expect(envBody).toEqual({
        name: "Default",
        description: "Cloudflare sandbox (default).",
        config: { type: "cloud" },
      }),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Create session" })).toBeEnabled(),
    );
    expect(screen.queryByRole("button", { name: "Create default environment" })).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Create session" }));
    await waitFor(() =>
      expect(createBody).toEqual({ agent: "agt_1", environment_id: "env_new" }),
    );
    await waitFor(() => expect(created).toBe("sess_1"));
  });

  it("includes selected vault_ids in the create body", async () => {
    server.use(
      http.get("/v1/environments", () =>
        HttpResponse.json({ data: [{ id: "env_1", name: "Default" }] }),
      ),
      http.get("/v1/environments/env_1", () =>
        HttpResponse.json({ id: "env_1", name: "Default" }),
      ),
      http.get("/v1/vaults", () =>
        HttpResponse.json({
          data: [{ id: "vlt_1", name: "Prod" }],
          // limit=1 probe still returns data so the vaults section shows
        }),
      ),
      http.get("/v1/vaults/vlt_1/credentials", () => HttpResponse.json({ data: [] })),
      http.get("/v1/agents/agt_1", () =>
        HttpResponse.json({
          id: "agt_1",
          mcp_servers: [{ name: "github", url: "https://api.github.com/mcp" }],
        }),
      ),
    );
    let createBody: Record<string, unknown> | null = null;
    server.use(
      http.post("/v1/sessions", async ({ request }) => {
        createBody = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ id: "sess_1" });
      }),
    );

    renderDialog();
    await waitFor(() => expect(screen.getByText(/Default/)).toBeInTheDocument());
    // VaultsPicker uses combobox "Add vault..."
    const addVault = await screen.findByText(/add vault/i);
    await userEvent.click(addVault);
    const option = await screen.findByText(/Prod/);
    await userEvent.click(option);

    await userEvent.click(screen.getByRole("button", { name: "Create session" }));
    await waitFor(() =>
      expect(createBody).toEqual({
        agent: "agt_1",
        environment_id: "env_1",
        vault_ids: ["vlt_1"],
      }),
    );
  });

  it("skips the environment step entirely for local-runtime agents", async () => {
    server.use(
      // Fetched by useDefaultEnvironment regardless of isLocalRuntime, but
      // never surfaced in the UI or sent on create for a local-runtime agent.
      http.get("/v1/environments", () => HttpResponse.json({ data: [] })),
      http.get("/v1/vaults", () => HttpResponse.json({ data: [] })),
      http.get("/v1/agents/agt_1", () =>
        HttpResponse.json({ id: "agt_1", mcp_servers: [] }),
      ),
      http.post("/v1/sessions", async ({ request }) => {
        const body = await request.json();
        expect(body).toEqual({ agent: "agt_1" });
        return HttpResponse.json({ id: "sess_1" });
      }),
    );

    let created: string | null = null;
    renderDialog({ isLocalRuntime: true, onCreated: (id) => { created = id; } });

    expect(screen.queryByText(/environment/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create session" }));
    await waitFor(() => expect(created).toBe("sess_1"));
  });
});

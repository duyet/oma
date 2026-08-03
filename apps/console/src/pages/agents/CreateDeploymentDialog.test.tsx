import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";

import { server } from "../../mocks/server";
import { CreateDeploymentDialog } from "./CreateDeploymentDialog";
import type { AgentRecord } from "../../types/agent";

const agent: AgentRecord = {
  id: "agent_1",
  name: "My Agent",
  model: "claude-new",
  version: 2,
  created_at: "2026-01-01T00:00:00Z",
};

function renderDialog() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onCreated = vi.fn();
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={queryClient}>
      <CreateDeploymentDialog
        open
        onClose={onClose}
        agent={agent}
        versions={[agent]}
        onCreated={onCreated}
      />
    </QueryClientProvider>,
  );
  return { onCreated, onClose };
}

/** Fill Name + Initial message + pick the mocked environment. */
async function fillCommon(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByPlaceholderText("Nightly inbox triage"), "Nightly triage");
  await user.type(
    screen.getByPlaceholderText("Summarize today's support tickets and post to #digest"),
    "Do the thing",
  );
  // The custom Combobox trigger has no aria-label; target its placeholder.
  await user.click(screen.getByText("Select environment..."));
  await waitFor(() => expect(screen.getByText("Prod")).toBeInTheDocument());
  await user.click(screen.getByText("Prod"));
}

describe("<CreateDeploymentDialog />", () => {
  it("submits a manual-trigger deployment with the right POST body", async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | undefined;
    server.use(
      http.get("/v1/environments", () =>
        HttpResponse.json({ data: [{ id: "env_1", name: "Prod" }] }),
      ),
      http.post("/v1/deployments", async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...posted, id: "dep_1", trigger: { type: "manual" } }, { status: 201 });
      }),
    );
    const { onCreated } = renderDialog();

    await fillCommon(user);
    await user.click(screen.getByRole("button", { name: "Create deployment" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posted).toMatchObject({
      name: "Nightly triage",
      agent_id: "agent_1",
      agent_version: null,
      initial_message: "Do the thing",
      environment_id: "env_1",
      vault_ids: [],
      memory_store_ids: [],
      trigger: { type: "manual" },
    });
  });

  it("submits a schedule-trigger deployment with cron + timezone", async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | undefined;
    server.use(
      http.get("/v1/environments", () =>
        HttpResponse.json({ data: [{ id: "env_1", name: "Prod" }] }),
      ),
      http.post("/v1/deployments", async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ...posted, id: "dep_1" }, { status: 201 });
      }),
    );
    renderDialog();

    await fillCommon(user);
    // Switch the Trigger select to Schedule.
    await user.click(screen.getByRole("combobox", { name: /Select trigger/ }));
    await user.click(await screen.findByRole("option", { name: /Schedule/ }));
    // Cadence picker revealed — retarget it to every day at 6 AM.
    await user.click(screen.getByRole("combobox", { name: "Select cadence" }));
    await user.click(await screen.findByRole("option", { name: /Daily/ }));
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "06:00" } });

    await user.click(screen.getByRole("button", { name: "Create deployment" }));

    await waitFor(() => expect(posted).toBeDefined());
    expect(posted!.trigger).toEqual({
      type: "schedule",
      cron_expression: "0 6 * * *",
      timezone: "UTC",
    });
  });

  it("surfaces the webhook URL after creating a webhook deployment", async () => {
    const user = userEvent.setup();
    let posted: Record<string, unknown> | undefined;
    server.use(
      http.get("/v1/environments", () =>
        HttpResponse.json({ data: [{ id: "env_1", name: "Prod" }] }),
      ),
      http.post("/v1/deployments", async ({ request }) => {
        posted = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json(
          {
            ...posted,
            id: "dep_1",
            trigger: { type: "webhook" },
            webhook_url: "https://example.com/v1/deployment_hooks/dhk_abc",
          },
          { status: 201 },
        );
      }),
    );
    renderDialog();

    await fillCommon(user);
    await user.click(screen.getByRole("combobox", { name: /Select trigger/ }));
    await user.click(await screen.findByRole("option", { name: /Webhook/ }));
    await user.click(screen.getByRole("button", { name: "Create deployment" }));

    expect(posted!.trigger).toEqual({ type: "webhook" });
    expect(
      await screen.findByDisplayValue("https://example.com/v1/deployment_hooks/dhk_abc"),
    ).toBeInTheDocument();
  });
});

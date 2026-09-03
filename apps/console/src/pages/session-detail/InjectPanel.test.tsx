import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "../../mocks/server";
import { InjectPanel } from "./InjectPanel";
import { emptyInjectionOverlay } from "@duyet/oma-api-types";

const SECRET = "super_secret_token_should_never_render";

describe("<InjectPanel />", () => {
  it("shows the Inject heading and appends a system prompt via POST", async () => {
    let overlay = emptyInjectionOverlay();
    const posts: unknown[] = [];
    server.use(
      http.get("/v1/sessions/sess_1/injections", () => HttpResponse.json(overlay)),
      http.post("/v1/sessions/sess_1/injections", async ({ request }) => {
        const body = await request.json();
        posts.push(body);
        overlay = {
          ...overlay,
          prompt_appends: [
            ...overlay.prompt_appends,
            { id: "inj_1", text: (body as { text: string }).text, injected_at: "2026-09-03T00:00:00.000Z" },
          ],
        };
        return HttpResponse.json(overlay);
      }),
    );

    render(<InjectPanel sessionId="sess_1" agent={null} />);
    await waitFor(() => expect(screen.getByText("Inject")).toBeInTheDocument());

    const box = screen.getByPlaceholderText(/Append a correction/i);
    await userEvent.type(box, "Run npm test.");
    await userEvent.click(screen.getByRole("button", { name: "Append to system prompt" }));

    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ type: "system_prompt_append", text: "Run npm test." });
    expect(screen.queryByRole("button", { name: /schedule/ })).not.toBeInTheDocument();
  });

  it("toggles a tool via PATCH /v1/sessions/:id/tools", async () => {
    let overlay = emptyInjectionOverlay();
    const patches: unknown[] = [];
    server.use(
      http.get("/v1/sessions/sess_1/injections", () => HttpResponse.json(overlay)),
      http.patch("/v1/sessions/sess_1/tools", async ({ request }) => {
        const body = await request.json() as { enabled?: string[] };
        patches.push(body);
        overlay = {
          ...overlay,
          tool_overrides: { ...(overlay.tool_overrides), ...(body.enabled ? { [body.enabled[0]]: true } : {}) },
        };
        return HttpResponse.json(overlay);
      }),
    );

    render(<InjectPanel sessionId="sess_1" agent={null} />);
    await waitFor(() => expect(screen.getByText("Inject")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /off · browser/i }));
    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ enabled: ["browser"] });
  });

  it("lists credentials by display name and id, never the token", async () => {
    server.use(
      http.get("/v1/sessions/sess_1/injections", () => HttpResponse.json(emptyInjectionOverlay())),
      http.get("/v1/vaults/vlt_1/credentials", () =>
        HttpResponse.json({
          data: [
            {
              id: "cred_1",
              display_name: "GitHub PAT",
              auth: { type: "static_bearer", token: SECRET },
            },
          ],
        }),
      ),
    );

    const { container } = render(
      <InjectPanel sessionId="sess_1" agent={null} vaultIds={["vlt_1"]} />,
    );
    await waitFor(() =>
      expect(screen.getAllByText(/GitHub PAT \(cred_1\)/).length).toBeGreaterThan(0),
    );
    expect(container.textContent).not.toContain(SECRET);
  });
});

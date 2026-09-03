import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import { server } from "../../mocks/server";
import type { Event } from "../../lib/events";
import { ArtifactsPanel } from "./ArtifactsPanel";

if (typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}

const writeEvent = {
  type: "agent.tool_use",
  name: "write",
  tool_use_id: "w1",
  ts: "2026-01-01T00:00:01.000Z",
  input: { file_path: "/workspace/report.md", content: "# Report\n\nDone.\n" },
} as Event;

describe("<ArtifactsPanel />", () => {
  it("lists a write artifact and opens a CodeBlock preview", async () => {
    server.use(
      http.get("/v1/sessions/sess_1/outputs", () =>
        HttpResponse.json({
          data: [
            {
              filename: "chart.png",
              size_bytes: 4096,
              uploaded_at: "2026-01-01T00:00:08.000Z",
              media_type: "image/png",
            },
          ],
        }),
      ),
    );

    const user = userEvent.setup();
    render(<ArtifactsPanel sessionId="sess_1" events={[writeEvent]} />);

    expect(await screen.findByText("report.md")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText("chart.png")).toBeInTheDocument();
    });

    expect(screen.getByRole("heading", { name: /Artifacts \(2\)/ })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "List view" }));
    expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute("aria-pressed", "true");

    await user.click(screen.getByRole("button", { name: "Tool output" }));
    expect(screen.getByText("report.md")).toBeInTheDocument();
    expect(screen.queryByText("chart.png")).not.toBeInTheDocument();

    await user.click(screen.getByText("report.md"));
    expect(await screen.findByRole("button", { name: "Download" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "report.md" })).toBeInTheDocument();
  });

  it("shows an empty state when the log and listing are empty", async () => {
    server.use(
      http.get("/v1/sessions/sess_empty/outputs", () =>
        HttpResponse.json({ data: [] }),
      ),
    );
    render(<ArtifactsPanel sessionId="sess_empty" events={[]} />);
    expect(
      await screen.findByText(/No artifacts yet/),
    ).toBeInTheDocument();
  });
});

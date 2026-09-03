import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SessionCard } from "./SessionCard";

describe("<SessionCard />", () => {
  it("shows title, agent, status, and tokens, then activates on click", async () => {
    const onActivate = vi.fn();
    render(
      <SessionCard
        session={{
          id: "sess_1",
          title: "Nightly digest",
          status: "running",
          created_at: "2026-01-01T00:00:00.000Z",
          agentLabel: "Nightly Digest Bot",
          input_tokens: 1200,
          output_tokens: 300,
        }}
        onActivate={onActivate}
      />,
    );

    expect(screen.getByText("Nightly digest")).toBeInTheDocument();
    expect(screen.getByText("Nightly Digest Bot")).toBeInTheDocument();
    expect(screen.getByText("Running")).toBeInTheDocument();
    expect(screen.getByText(/1\.5K tokens/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Nightly digest/i }));
    expect(onActivate).toHaveBeenCalledOnce();
  });
});

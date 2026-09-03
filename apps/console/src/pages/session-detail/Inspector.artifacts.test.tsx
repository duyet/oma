import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DeclaredOutputsList } from "./Inspector";
import type { Event } from "../../lib/events";

describe("Inspector Artifacts tab — declared outputs (issue #341)", () => {
  it("shows an empty state when nothing was declared", () => {
    render(<DeclaredOutputsList events={[{ type: "user.message" } as Event]} />);
    expect(screen.getByText("No declared outputs yet.")).toBeInTheDocument();
  });

  it("lists declared outputs with the badge and agent description", () => {
    const events: Event[] = [
      {
        type: "agent.output_declared",
        path: "/workspace/output/report.pdf",
        description: "Weekly metrics digest",
        media_type: "application/pdf",
        size_bytes: 89432,
        tool_use_id: "toolu_1",
        processed_at: "2026-08-03T14:32:00Z",
        data: "aGVsbG8=",
      } as Event,
      {
        type: "agent.output_declared",
        path: "/workspace/output/summary.md",
        tool_use_id: "toolu_2",
      } as Event,
    ];
    render(<DeclaredOutputsList events={events} />);
    const list = screen.getByTestId("declared-outputs-list");
    expect(list).toHaveTextContent("report.pdf");
    expect(list).toHaveTextContent("Weekly metrics digest");
    expect(list).toHaveTextContent("★ Declared output");
    expect(list).toHaveTextContent("summary.md");
    expect(list).not.toHaveTextContent("aGVsbG8=");
  });
});

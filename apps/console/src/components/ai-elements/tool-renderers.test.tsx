import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { getToolTitle, renderToolCall } from "./tool-renderers";

describe("output_file conversation card (issue #341)", () => {
  it("titles the tool after the declared filename", () => {
    expect(
      getToolTitle("output_file", { path: "/workspace/output/report.pdf" }, undefined),
    ).toBe("report.pdf");
  });

  it("renders a deliverable card instead of raw JSON", () => {
    render(
      <>
        {renderToolCall({
          name: "output_file",
          input: {
            path: "/workspace/output/report.pdf",
            description: "Weekly metrics digest for the engineering team",
            data: "aGVsbG8=",
          },
          output: JSON.stringify({
            ok: true,
            path: "/workspace/output/report.pdf",
            description: "Weekly metrics digest for the engineering team",
            media_type: "application/pdf",
            size_bytes: 89432,
          }),
          errorText: undefined,
          state: "output-available",
          mcpServerName: undefined,
          timestamp: "2026-08-03T14:32:00Z",
        })}
      </>,
    );
    const card = screen.getByTestId("output-file-card");
    expect(card).toHaveTextContent("report.pdf");
    expect(card).toHaveTextContent("Weekly metrics digest for the engineering team");
    expect(card).toHaveTextContent("★ Declared output");
    expect(card).toHaveTextContent("87.3 KB");
    expect(card).toHaveTextContent("14:32 UTC");
    expect(card).not.toHaveTextContent("aGVsbG8=");
    expect(card).not.toHaveTextContent('"ok": true');
  });
});

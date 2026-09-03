import { describe, expect, it } from "vitest";
import { parseOutputFileDeclaration, maybeBroadcastOutputDeclared } from "./output-declared";

describe("parseOutputFileDeclaration", () => {
  it("builds the event from a successful JSON tool result", () => {
    const event = parseOutputFileDeclaration(
      "toolu_1",
      JSON.stringify({
        ok: true,
        path: "/workspace/output/report.pdf",
        description: "Weekly metrics digest",
        media_type: "application/pdf",
        size_bytes: 12,
        sha256: "ab",
      }),
      { path: "/workspace/output/report.pdf", data: "aGVsbG8=" },
    );
    expect(event).toEqual({
      type: "agent.output_declared",
      path: "/workspace/output/report.pdf",
      description: "Weekly metrics digest",
      media_type: "application/pdf",
      size_bytes: 12,
      sha256: "ab",
      tool_use_id: "toolu_1",
      parent_event_id: "toolu_1",
      data: "aGVsbG8=",
    });
  });

  it("does not emit when execute returned an error string", () => {
    expect(
      parseOutputFileDeclaration("toolu_1", "Error: disk full", { path: "/x" }),
    ).toBeNull();
  });

  it("falls back to input.path when the result is a confirmation string", () => {
    const event = parseOutputFileDeclaration(
      "toolu_2",
      "declared",
      { path: "/workspace/summary.md", description: "Notes" },
    );
    expect(event?.path).toBe("/workspace/summary.md");
    expect(event?.description).toBe("Notes");
    expect(event?.data).toBeUndefined();
  });

  it("maps legacy filename to /mnt/session/outputs/", () => {
    const event = parseOutputFileDeclaration(
      "toolu_3",
      "Wrote session output report.md",
      { filename: "report.md" },
    );
    expect(event?.path).toBe("/mnt/session/outputs/report.md");
  });

  it("maybeBroadcastOutputDeclared emits after a successful result", () => {
    const events: unknown[] = [];
    maybeBroadcastOutputDeclared(
      (e) => { events.push(e); },
      "output_file",
      "toolu_1",
      JSON.stringify({ ok: true, path: "/workspace/a.pdf" }),
      { path: "/workspace/a.pdf", data: "aGVsbG8=" },
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "agent.output_declared",
      path: "/workspace/a.pdf",
      data: "aGVsbG8=",
    });
  });

  it("maybeBroadcastOutputDeclared ignores other tools", () => {
    const events: unknown[] = [];
    maybeBroadcastOutputDeclared(
      (e) => { events.push(e); },
      "write",
      "toolu_1",
      "ok",
      { file_path: "/workspace/a.txt" },
    );
    expect(events).toEqual([]);
  });
});

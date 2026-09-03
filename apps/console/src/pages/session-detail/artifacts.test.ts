import { describe, expect, it } from "vitest";

import type { Event } from "../../lib/events";
import {
  computeSessionArtifacts,
  filterArtifacts,
  formatBytes,
  kindOf,
  sortArtifacts,
  type SandboxOutputFile,
} from "./artifacts";

function ev(partial: Record<string, unknown> & { type: string }): Event {
  return partial as unknown as Event;
}

describe("kindOf / formatBytes", () => {
  it("classifies by extension and media type", () => {
    expect(kindOf("chart.png")).toBe("image");
    expect(kindOf("report.pdf")).toBe("pdf");
    expect(kindOf("notes.md")).toBe("text");
    expect(kindOf("app.ts")).toBe("code");
    expect(kindOf("data.csv")).toBe("data");
    expect(kindOf("blob.bin")).toBe("other");
    expect(kindOf("x", "image/webp")).toBe("image");
  });

  it("formats byte sizes", () => {
    expect(formatBytes(200)).toBe("200 B");
    expect(formatBytes(1420)).toBe("1.4 KB");
    expect(formatBytes(undefined)).toBe("—");
  });
});

describe("computeSessionArtifacts", () => {
  it("surfaces write/edit/output_file paths from tool_use, including errors", () => {
    const artifacts = computeSessionArtifacts([
      ev({
        type: "agent.tool_use",
        name: "write",
        tool_use_id: "w1",
        ts: "2026-01-01T00:00:01.000Z",
        input: { file_path: "/workspace/report.md", content: "# Hello\n" },
      }),
      ev({
        type: "agent.tool_result",
        tool_use_id: "w1",
        ts: "2026-01-01T00:00:02.000Z",
      }),
      ev({
        type: "agent.tool_use",
        name: "edit",
        tool_use_id: "e1",
        ts: "2026-01-01T00:00:03.000Z",
        input: { file_path: "/workspace/report.md", old_string: "Hello", new_string: "Hi" },
      }),
      ev({
        type: "agent.tool_result",
        tool_use_id: "e1",
        ts: "2026-01-01T00:00:04.000Z",
        is_error: true,
      }),
      ev({
        type: "agent.tool_use",
        name: "output_file",
        tool_use_id: "o1",
        ts: "2026-01-01T00:00:05.000Z",
        input: { filename: "summary.json", content: "{\"ok\":true}" },
      }),
    ]);

    const report = artifacts.find((a) => a.path === "/workspace/report.md");
    expect(report).toMatchObject({
      name: "report.md",
      source: "tool_output",
      kind: "text",
      toolName: "edit",
      isError: true,
      text: "# Hello\n",
    });
    expect(report?.preview.kind).toBe("text");

    const summary = artifacts.find((a) => a.name === "summary.json");
    expect(summary).toMatchObject({
      path: "/mnt/session/outputs/summary.json",
      source: "tool_output",
      kind: "data",
    });
  });

  it("parses image/document blocks on tool_result and user.message", () => {
    const artifacts = computeSessionArtifacts([
      ev({
        type: "user.message",
        seq: 1,
        ts: "2026-01-01T00:00:00.000Z",
        content: [
          { type: "text", text: "look at this" },
          {
            type: "image",
            source: { type: "file", file_id: "file_abc", media_type: "image/png" },
          },
        ],
      }),
      ev({
        type: "agent.tool_use",
        name: "read",
        tool_use_id: "r1",
        ts: "2026-01-01T00:00:01.000Z",
        input: { file_path: "/workspace/chart.png" },
      }),
      ev({
        type: "agent.tool_result",
        tool_use_id: "r1",
        seq: 3,
        ts: "2026-01-01T00:00:02.000Z",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
          },
        ],
      }),
      ev({
        type: "agent.tool_result",
        tool_use_id: "orphan",
        seq: 4,
        is_error: true,
        content: [
          {
            type: "document",
            source: { media_type: "application/pdf", data: "JVBERg==" },
          },
        ],
      }),
    ]);

    const upload = artifacts.find((a) => a.source === "user_upload");
    expect(upload?.kind).toBe("image");
    expect(upload?.downloadHref).toBe("/v1/files/file_abc/content");
    expect(upload?.preview).toEqual({
      kind: "image",
      src: "/v1/files/file_abc/content",
    });

    const chart = artifacts.find((a) => a.name === "chart.png");
    expect(chart?.source).toBe("tool_output");
    expect(chart?.toolName).toBe("read");
    expect(chart?.preview.kind).toBe("image");
    expect(chart?.sizeBytes).toBe(4);

    const failed = artifacts.find((a) => a.isError && a.kind === "pdf");
    expect(failed).toBeDefined();
    expect(failed?.preview.kind).toBe("pdf");
  });

  it("merges session outputs into sandbox artifacts and drops tiny non-previewable listings", () => {
    const listing: SandboxOutputFile[] = [
      {
        filename: "summary.json",
        size_bytes: 12,
        uploaded_at: "2026-01-01T00:00:06.000Z",
        media_type: "application/json",
      },
      {
        filename: "bundle.js",
        size_bytes: 24_000,
        uploaded_at: "2026-01-01T00:00:07.000Z",
        media_type: "application/javascript",
      },
      {
        filename: "noise.bin",
        size_bytes: 80,
        uploaded_at: "2026-01-01T00:00:08.000Z",
        media_type: "application/octet-stream",
      },
    ];
    const artifacts = computeSessionArtifacts(
      [
        ev({
          type: "agent.tool_use",
          name: "output_file",
          tool_use_id: "o1",
          ts: "2026-01-01T00:00:05.000Z",
          input: { filename: "summary.json", content: "{\"ok\":true}" },
        }),
      ],
      listing,
      "sess_1",
    );

    expect(artifacts.find((a) => a.name === "noise.bin")).toBeUndefined();

    const summary = artifacts.find((a) => a.name === "summary.json");
    expect(summary?.source).toBe("sandbox");
    expect(summary?.downloadHref).toBe("/v1/sessions/sess_1/outputs/summary.json");
    expect(summary?.text).toBe("{\"ok\":true}");

    const bundle = artifacts.find((a) => a.name === "bundle.js");
    expect(bundle).toMatchObject({
      source: "sandbox",
      kind: "code",
      sizeBytes: 24_000,
    });
  });

  it("recomputes as the event log grows (streaming)", () => {
    const first = computeSessionArtifacts([
      ev({
        type: "agent.tool_use",
        name: "write",
        tool_use_id: "w1",
        ts: "2026-01-01T00:00:01.000Z",
        input: { file_path: "/workspace/a.md", content: "one" },
      }),
    ]);
    expect(first).toHaveLength(1);
    const next = computeSessionArtifacts([
      ev({
        type: "agent.tool_use",
        name: "write",
        tool_use_id: "w1",
        ts: "2026-01-01T00:00:01.000Z",
        input: { file_path: "/workspace/a.md", content: "one" },
      }),
      ev({
        type: "agent.tool_use",
        name: "write",
        tool_use_id: "w2",
        ts: "2026-01-01T00:00:02.000Z",
        input: { file_path: "/workspace/b.csv", content: "x,y\n1,2\n" },
      }),
    ]);
    expect(next.map((a) => a.name).sort()).toEqual(["a.md", "b.csv"]);
  });
});

describe("filterArtifacts / sortArtifacts", () => {
  const artifacts = computeSessionArtifacts([
    ev({
      type: "agent.tool_use",
      name: "write",
      ts: "2026-01-01T00:00:01.000Z",
      input: { file_path: "/workspace/a.md", content: "a" },
    }),
    ev({
      type: "user.message",
      seq: 2,
      ts: "2026-01-01T00:00:02.000Z",
      content: [
        { type: "image", source: { type: "url", url: "https://x/y.png", media_type: "image/png" } },
      ],
    }),
  ]);

  it("filters by source and extension", () => {
    const uploads = filterArtifacts(artifacts, { sources: ["user_upload"], extensions: [] });
    expect(uploads.every((a) => a.source === "user_upload")).toBe(true);
    const md = filterArtifacts(artifacts, { sources: [], extensions: ["md"] });
    expect(md.map((a) => a.name)).toEqual(["a.md"]);
  });

  it("sorts by name and size", () => {
    const byName = sortArtifacts(artifacts, "name", "asc");
    expect(byName[0].name <= byName[byName.length - 1].name).toBe(true);
    const bySize = sortArtifacts(artifacts, "size", "desc");
    expect((bySize[0].sizeBytes ?? -1) >= (bySize[bySize.length - 1].sizeBytes ?? -1)).toBe(true);
  });
});

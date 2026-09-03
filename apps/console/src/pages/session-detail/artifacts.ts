import { useMemo } from "react";

import type { Event } from "../../lib/events";

/**
 * Session artifacts derived from the event log + session-outputs listing.
 *
 * No new storage layer: the same stream SessionDetail already holds, plus
 * the GET /v1/sessions/:id/outputs listing the Files tab already fetches.
 * Recompute on every events-array identity change so SSE appends show up
 * without polling.
 */

export type ArtifactSource = "tool_output" | "sandbox" | "user_upload";
export type ArtifactKind = "image" | "pdf" | "text" | "code" | "data" | "other";
export type ArtifactSortKey = "name" | "size" | "source" | "ts";

export interface SandboxOutputFile {
  filename: string;
  size_bytes: number;
  uploaded_at: string;
  media_type: string;
}

export type ArtifactPreview =
  | { kind: "image"; src: string }
  | { kind: "pdf"; src: string }
  | { kind: "text"; text: string; language: string }
  | { kind: "href"; href: string }
  | { kind: "none" };

export interface SessionArtifact {
  id: string;
  name: string;
  path?: string;
  source: ArtifactSource;
  kind: ArtifactKind;
  mediaType?: string;
  extension: string;
  sizeBytes?: number;
  ts?: number;
  toolName?: string;
  isError?: boolean;
  preview: ArtifactPreview;
  downloadHref?: string;
  text?: string;
}

export interface ArtifactFilter {
  sources: ArtifactSource[];
  extensions: string[];
}

const FILE_TOOLS = new Set(["write", "edit", "output_file"]);
const MIN_SANDBOX_LISTING_BYTES = 1024;

const LANG_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  rb: "ruby",
  go: "go",
  rs: "rust",
  java: "java",
  kt: "kotlin",
  swift: "swift",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  html: "html",
  css: "css",
  scss: "scss",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  xml: "xml",
  sql: "sql",
  md: "markdown",
  mdx: "markdown",
  txt: "markdown",
  csv: "csv",
};

const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico"]);
const DATA_EXT = new Set(["csv", "tsv", "json", "jsonl", "ndjson"]);
const TEXT_EXT = new Set(["md", "mdx", "txt", "rst", "log"]);
const CODE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rb", "go", "rs", "java",
  "kt", "swift", "sh", "bash", "html", "css", "scss", "yaml", "yml", "toml",
  "xml", "sql", "c", "h", "cpp", "hpp",
]);

interface PendingUse {
  name: string;
  input: Record<string, unknown> | undefined;
  ts?: number;
}

interface LooseSource {
  type?: string;
  data?: string;
  url?: string;
  media_type?: string;
  file_id?: string;
}

interface LooseBlock {
  type: string;
  text?: string;
  source?: LooseSource;
}

export function extensionOf(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return "";
  return base.slice(dot + 1).toLowerCase();
}

export function formatBytes(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function languageFor(name: string): string {
  return LANG_BY_EXT[extensionOf(name)] ?? "markdown";
}

export function kindOf(name: string, mediaType?: string): ArtifactKind {
  if (mediaType?.startsWith("image/") || IMAGE_EXT.has(extensionOf(name))) return "image";
  if (mediaType === "application/pdf" || extensionOf(name) === "pdf") return "pdf";
  const ext = extensionOf(name);
  if (DATA_EXT.has(ext) || mediaType === "application/json" || mediaType === "text/csv") {
    return "data";
  }
  if (TEXT_EXT.has(ext) || mediaType?.startsWith("text/")) return "text";
  if (CODE_EXT.has(ext) || mediaType === "application/javascript") return "code";
  return "other";
}

export function isPreviewableMedia(name: string, mediaType?: string): boolean {
  const kind = kindOf(name, mediaType);
  return kind !== "other";
}

function basename(path: string): string {
  const parts = path.split("/").filter(Boolean);
  return parts[parts.length - 1] || path;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  return undefined;
}

function eventTs(e: Event): number | undefined {
  if (typeof e.ts === "string") {
    const n = Date.parse(e.ts);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

function isBlockArray(value: unknown): value is LooseBlock[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (b) => b !== null && typeof b === "object" && typeof (b as { type?: unknown }).type === "string",
    )
  );
}

function blocksOf(value: unknown): LooseBlock[] {
  if (isBlockArray(value)) return value;
  return [];
}

function srcFromBlock(block: LooseBlock): {
  src?: string;
  sizeBytes?: number;
  mediaType?: string;
  fileId?: string;
} {
  const source = block.source;
  if (!source) return {};
  const mediaType = source.media_type;
  if (source.file_id) {
    return {
      src: `/v1/files/${source.file_id}/content`,
      fileId: source.file_id,
      mediaType,
    };
  }
  if (source.data) {
    const media = mediaType || "application/octet-stream";
    return {
      src: `data:${media};base64,${source.data}`,
      sizeBytes: base64Bytes(source.data),
      mediaType: media,
    };
  }
  if (source.url) return { src: source.url, mediaType };
  return { mediaType };
}

function previewFor(opts: {
  name: string;
  mediaType?: string;
  src?: string;
  text?: string;
  href?: string;
}): ArtifactPreview {
  const kind = kindOf(opts.name, opts.mediaType);
  if (kind === "image" && opts.src) return { kind: "image", src: opts.src };
  if (kind === "pdf" && opts.src) return { kind: "pdf", src: opts.src };
  if (opts.text !== undefined && (kind === "text" || kind === "code" || kind === "data")) {
    return { kind: "text", text: opts.text, language: languageFor(opts.name) };
  }
  if (opts.href) return { kind: "href", href: opts.href };
  if (opts.src) return { kind: "href", href: opts.src };
  return { kind: "none" };
}

function toolUseId(e: Event): string | undefined {
  return (
    asString(e.tool_use_id) ??
    asString(e.mcp_tool_use_id) ??
    asString(e.id)
  );
}

function filePathFromInput(input: Record<string, unknown> | undefined, toolName: string): string | undefined {
  if (!input) return undefined;
  if (toolName === "output_file") {
    const filename = asString(input.filename);
    return filename ? `/mnt/session/outputs/${filename}` : undefined;
  }
  return asString(input.file_path) ?? asString(input.path);
}

function upsert(
  byId: Map<string, SessionArtifact>,
  artifact: SessionArtifact,
): void {
  byId.set(artifact.id, artifact);
}

function upsertWrite(opts: {
  byId: Map<string, SessionArtifact>;
  path: string;
  toolName: string;
  content?: string;
  ts?: number;
  isError?: boolean;
}): void {
  const name = basename(opts.path);
  const text = opts.content;
  const artifact: SessionArtifact = {
    id: `path:${opts.path}`,
    name,
    path: opts.path,
    source: "tool_output",
    kind: kindOf(name),
    extension: extensionOf(name),
    sizeBytes: text !== undefined ? utf8Bytes(text) : undefined,
    ts: opts.ts,
    toolName: opts.toolName,
    isError: opts.isError,
    text,
    preview: previewFor({ name, text }),
  };
  const prev = opts.byId.get(artifact.id);
  if (prev && text === undefined) {
    upsert(opts.byId, {
      ...prev,
      ts: opts.ts ?? prev.ts,
      toolName: opts.toolName,
      isError: opts.isError ?? prev.isError,
    });
    return;
  }
  if (prev && text !== undefined) {
    upsert(opts.byId, {
      ...artifact,
      isError: opts.isError ?? prev.isError,
    });
    return;
  }
  upsert(opts.byId, artifact);
}

function addMediaBlock(opts: {
  byId: Map<string, SessionArtifact>;
  id: string;
  name: string;
  source: ArtifactSource;
  block: LooseBlock;
  ts?: number;
  toolName?: string;
  isError?: boolean;
}): void {
  const extracted = srcFromBlock(opts.block);
  const mediaType = extracted.mediaType;
  const name = opts.name || suggestedName(opts.block.type, mediaType, opts.toolName);
  const href = extracted.fileId
    ? `/v1/files/${extracted.fileId}/content`
    : extracted.src?.startsWith("data:")
      ? undefined
      : extracted.src;
  upsert(opts.byId, {
    id: opts.id,
    name,
    source: opts.source,
    kind: kindOf(name, mediaType),
    mediaType,
    extension: extensionOf(name),
    sizeBytes: extracted.sizeBytes,
    ts: opts.ts,
    toolName: opts.toolName,
    isError: opts.isError,
    preview: previewFor({ name, mediaType, src: extracted.src, href }),
    downloadHref: href,
  });
}

function suggestedName(blockType: string, mediaType: string | undefined, toolName?: string): string {
  const extFromMedia = mediaType?.split("/")[1]?.split("+")[0];
  const ext = extFromMedia && extFromMedia !== "octet-stream" ? extFromMedia : blockType === "image" ? "png" : "bin";
  const stem = toolName ? `${toolName}` : blockType;
  return `${stem}.${ext}`;
}

function isFileTool(name: string): boolean {
  return FILE_TOOLS.has(name);
}

export function computeSessionArtifacts(
  events: Event[],
  sandboxFiles?: SandboxOutputFile[],
  sessionId?: string,
): SessionArtifact[] {
  const byId = new Map<string, SessionArtifact>();
  const pending = new Map<string, PendingUse>();

  for (let i = 0; i < events.length; i++) {
    const e = events[i];
    const ts = eventTs(e);

    switch (e.type) {
      case "user.message": {
        const blocks = blocksOf(e.content);
        for (let b = 0; b < blocks.length; b++) {
          const block = blocks[b];
          if (block.type !== "image" && block.type !== "document") continue;
          addMediaBlock({
            byId,
            id: `upload:${e.seq ?? i}:${b}`,
            name: suggestedName(block.type, block.source?.media_type),
            source: "user_upload",
            block,
            ts,
          });
        }
        break;
      }
      case "agent.tool_use":
      case "agent.custom_tool_use":
      case "agent.mcp_tool_use": {
        const name = asString(e.name) ?? "unknown";
        const input = asRecord(e.input);
        const id = toolUseId(e);
        if (id) pending.set(id, { name, input, ts });
        if (isFileTool(name)) {
          const path = filePathFromInput(input, name);
          if (path) {
            upsertWrite({
              byId,
              path,
              toolName: name,
              content: asString(input?.content),
              ts,
            });
          }
        }
        break;
      }
      case "agent.tool_result":
      case "agent.mcp_tool_result": {
        const id =
          asString(e.tool_use_id) ?? asString(e.mcp_tool_use_id);
        const use = id ? pending.get(id) : undefined;
        if (id) pending.delete(id);
        const errored =
          Boolean((e as { is_error?: boolean }).is_error) ||
          typeof (e as { error?: string }).error === "string";
        if (use && isFileTool(use.name)) {
          const path = filePathFromInput(use.input, use.name);
          if (path) {
            upsertWrite({
              byId,
              path,
              toolName: use.name,
              content: asString(use.input?.content),
              ts: ts ?? use.ts,
              isError: errored,
            });
          }
        }
        const blocks = blocksOf(e.content);
        for (let b = 0; b < blocks.length; b++) {
          const block = blocks[b];
          if (block.type !== "image" && block.type !== "document") continue;
          const toolName = use?.name;
          const fromRead = filePathFromInput(use?.input, toolName ?? "");
          const name = fromRead ? basename(fromRead) : suggestedName(block.type, block.source?.media_type, toolName);
          addMediaBlock({
            byId,
            id: `result:${e.seq ?? i}:${b}`,
            name,
            source: "tool_output",
            block,
            ts,
            toolName,
            isError: errored,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  if (sandboxFiles) {
    for (const file of sandboxFiles) {
      const path = `/mnt/session/outputs/${file.filename}`;
      const existing = byId.get(`path:${path}`);
      const sandboxHref = sessionId
        ? outputDownloadHref(sessionId, file.filename)
        : undefined;
      if (existing) {
        upsert(byId, {
          ...existing,
          source: "sandbox",
          sizeBytes: file.size_bytes,
          mediaType: file.media_type,
          kind: kindOf(file.filename, file.media_type),
          downloadHref: existing.downloadHref ?? sandboxHref,
          preview:
            existing.preview.kind === "none" || existing.preview.kind === "href"
              ? previewFor({
                  name: file.filename,
                  mediaType: file.media_type,
                  src: sandboxHref,
                  text: existing.text,
                  href: sandboxHref,
                })
              : existing.preview,
        });
        continue;
      }
      const include =
        file.size_bytes >= MIN_SANDBOX_LISTING_BYTES &&
        isPreviewableMedia(file.filename, file.media_type);
      if (!include) continue;
      const name = file.filename;
      upsert(byId, {
        id: `sandbox:${name}`,
        name,
        path,
        source: "sandbox",
        kind: kindOf(name, file.media_type),
        mediaType: file.media_type,
        extension: extensionOf(name),
        sizeBytes: file.size_bytes,
        ts: Date.parse(file.uploaded_at) || undefined,
        preview: previewFor({
          name,
          mediaType: file.media_type,
          src: sandboxHref,
          href: sandboxHref,
        }),
        downloadHref: sandboxHref,
      });
    }
  }

  return Array.from(byId.values()).sort((a, b) => (b.ts ?? 0) - (a.ts ?? 0) || a.name.localeCompare(b.name));
}

export function outputDownloadHref(sessionId: string, filename: string): string {
  return `/v1/sessions/${sessionId}/outputs/${encodeURIComponent(filename)}`;
}

export function filterArtifacts(
  artifacts: SessionArtifact[],
  filter: ArtifactFilter,
): SessionArtifact[] {
  return artifacts.filter((a) => {
    if (filter.sources.length > 0 && !filter.sources.includes(a.source)) return false;
    if (filter.extensions.length > 0 && !filter.extensions.includes(a.extension || "(none)")) {
      return false;
    }
    return true;
  });
}

export function sortArtifacts(
  artifacts: SessionArtifact[],
  key: ArtifactSortKey,
  dir: "asc" | "desc",
): SessionArtifact[] {
  const sign = dir === "asc" ? 1 : -1;
  return [...artifacts].sort((a, b) => {
    let cmp = 0;
    switch (key) {
      case "name":
        cmp = a.name.localeCompare(b.name);
        break;
      case "size":
        cmp = (a.sizeBytes ?? -1) - (b.sizeBytes ?? -1);
        break;
      case "source":
        cmp = a.source.localeCompare(b.source);
        break;
      case "ts":
        cmp = (a.ts ?? 0) - (b.ts ?? 0);
        break;
      default: {
        const _never: never = key;
        void _never;
        cmp = 0;
      }
    }
    if (cmp === 0) cmp = a.name.localeCompare(b.name);
    return cmp * sign;
  });
}

export function useSessionArtifacts(
  events: Event[],
  sandboxFiles?: SandboxOutputFile[],
  sessionId?: string,
): SessionArtifact[] {
  return useMemo(
    () => computeSessionArtifacts(events, sandboxFiles, sessionId),
    [events, sandboxFiles, sessionId],
  );
}

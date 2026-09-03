"use client";

import type { ReactNode } from "react";
import type { BundledLanguage } from "shiki";
import {
  FileIcon,
  FilePenIcon,
  FilePlusIcon,
  FolderSearchIcon,
  GlobeIcon,
  SearchIcon,
  TerminalIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { CodeBlock } from "./code-block";
import { ToolInput, ToolOutput, type ToolPart } from "./tool";
import { Attachment, isContentBlockArray, type ContentBlockLike } from "./attachment";

/**
 * Rich per-tool renderers for the built-in `agent_toolset_20260401` suite
 * (bash/read/write/edit/glob/grep/web_fetch/web_search plus opt-in
 * output_file) plus a
 * media-aware fallback for MCP and custom tools. Lives alongside
 * `tool.tsx` (the generic ToolInput/ToolOutput this extends) rather than
 * inside SessionDetail.tsx so the ~10 per-tool layouts don't bloat the
 * page file, and so they're independently testable/reusable (e.g. a
 * future Timeline view could import the same renderers).
 *
 * `renderToolCall` returns the BODY only — callers keep wrapping it in
 * the existing <Tool><ToolHeader/><ToolContent>{...}</ToolContent></Tool>
 * shell so state pills, collapse/expand, and paired-result logic stay
 * centralized in SessionDetail.tsx. `getToolTitle` computes the matching
 * header title (ToolHeader.title only accepts a plain string).
 */

export interface RenderToolCallProps {
  name: string;
  input: Record<string, unknown> | undefined;
  /** Raw wire tool_result.content — string | ContentBlock[] | undefined.
   *  Left un-stringified (unlike the pre-3a3e7ec generic path) so image/
   *  document blocks can be detected and rendered as attachments instead
   *  of dumped as base64 JSON. */
  output: unknown;
  errorText: string | undefined;
  state: ToolPart["state"];
  mcpServerName: string | undefined;
  /** Optional ISO timestamp from the matching tool_use event. */
  timestamp?: string;
}

// ---------------------------------------------------------------------
// Title
// ---------------------------------------------------------------------

function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function getToolTitle(
  name: string,
  input: Record<string, unknown> | undefined,
  mcpServerName: string | undefined,
): string {
  if (mcpServerName) return `${name} · mcp:${mcpServerName}`;
  const filePath = asString(input?.file_path);
  switch (name) {
    case "bash":
      return "Terminal";
    case "read": {
      const p = filePath ?? asString(input?.path);
      return p ? basename(p) : "Read";
    }
    case "write":
      return filePath ? `Write ${basename(filePath)}` : "Write";
    case "edit":
      return filePath ? `Edit ${basename(filePath)}` : "Edit";
    case "glob":
      return "Glob";
    case "grep":
      return "Grep";
    case "web_fetch":
      return "Fetch";
    case "web_search":
      return "Search";
    case "output_file": {
      const p = asString(input?.path) ?? asString(input?.filename);
      return p ? basename(p) : "Declared output";
    }
    default:
      return name;
  }
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Extension → shiki bundled-language id. Every value here was verified
 *  against shiki@4's `bundledLanguages` key set — passing an id shiki
 *  doesn't know rejects the whole highlighter promise (silently, but
 *  the block never highlights), so this stays a conservative allowlist
 *  rather than a guess; unmapped extensions fall back to a plain mono
 *  block instead of risking an invalid CodeBlock language. */
const EXT_LANGUAGE: Record<string, BundledLanguage> = {
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "tsx",
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx",
  json: "json", jsonc: "jsonc",
  md: "markdown", mdx: "mdx",
  py: "python", rb: "ruby", go: "go", rs: "rust",
  sh: "bash", bash: "bash", zsh: "zsh",
  sql: "sql", toml: "toml", yaml: "yaml", yml: "yaml",
  css: "css", scss: "scss", less: "less",
  html: "html", xml: "xml", vue: "vue", svelte: "svelte",
  php: "php", java: "java", kt: "kotlin", cs: "csharp", swift: "swift",
  c: "c", cpp: "cpp", graphql: "graphql", gql: "graphql",
  dockerfile: "dockerfile", ini: "ini", diff: "diff", log: "log",
};

function inferLanguage(path: string | undefined): BundledLanguage | null {
  if (!path) return null;
  const ext = path.split(".").pop()?.toLowerCase();
  if (!ext) return null;
  return EXT_LANGUAGE[ext] ?? null;
}

/** The `read` tool prefixes each line with `N\t` only when offset/limit
 *  narrowed the read (see apps/agent/src/harness/tools.ts read.execute);
 *  a full-file read returns raw content. Strip that bookkeeping before
 *  handing text to CodeBlock's own `showLineNumbers` gutter so lines
 *  don't double up. Heuristic (matches a leading "<digits>\t" per line)
 *  — safe because it only ever removes a prefix CodeBlock would
 *  otherwise render as literal text no agent output relies on. */
function stripReadLineNumbers(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/^\d+\t/, ""))
    .join("\n");
}

/** bash's execute() prefixes results with `exit=<code>\n` for internal
 *  poll bookkeeping (see pollWithStrategies / tools.ts) — not meant for
 *  display. */
function stripExitPrefix(text: string): string {
  return text.replace(/^exit=-?\d+\n/, "");
}

function MonoBlock({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-md bg-muted/40 px-3 py-2 text-[12.5px] font-mono text-fg whitespace-pre-wrap break-words max-h-64 overflow-y-auto",
        className,
      )}
    >
      {children}
    </div>
  );
}

function OutputError({ errorText }: { errorText: string }) {
  return (
    <div className="rounded-md bg-danger-subtle px-3 py-2 text-[12.5px] font-mono text-danger whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
      {errorText}
    </div>
  );
}

function MetaRow({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-1.5 text-[12px] text-fg-subtle font-mono truncate">
      {icon}
      <span className="truncate">{children}</span>
    </div>
  );
}

function MediaBlocks({ media }: { media: ContentBlockLike[] }) {
  if (media.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {media.map((block, i) => (
        <Attachment key={i} block={block} />
      ))}
    </div>
  );
}

/** Compact result list — first line rendered as a subtle summary header
 *  (glob/grep's "Found N files" / "Found N total occurrences…" preamble)
 *  when recognizable, the rest as a scrollable mono path/line list. */
function ResultList({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const looksLikeSummary = /^(Found \d+|No (files|matches)|\(matches found)/.test(lines[0]);
  const summary = looksLikeSummary ? lines[0] : null;
  const rest = looksLikeSummary ? lines.slice(1) : lines;
  return (
    <div className="rounded-md bg-muted/40 overflow-hidden">
      {summary && (
        <div className="px-3 py-1.5 text-[11px] text-fg-subtle border-b border-border/50">{summary}</div>
      )}
      {rest.length > 0 && (
        <div className="max-h-64 overflow-y-auto px-3 py-1.5 font-mono text-[12.5px] text-fg space-y-0.5">
          {rest.map((line, i) => (
            <div key={i} className="truncate">{line}</div>
          ))}
        </div>
      )}
    </div>
  );
}

function ExpandableText({ text }: { text: string }) {
  const PREVIEW_CHARS = 600;
  if (text.length <= PREVIEW_CHARS) {
    return <MonoBlock>{text}</MonoBlock>;
  }
  return (
    <details className="group rounded-md bg-muted/40">
      <summary className="cursor-pointer select-none list-none px-3 py-2 text-[12px] text-fg-subtle hover:text-fg">
        <span className="group-open:hidden">Show full content ({text.length.toLocaleString()} chars)</span>
        <span className="hidden group-open:inline">Hide</span>
      </summary>
      <div className="px-3 pb-2 text-[12.5px] font-mono text-fg whitespace-pre-wrap break-words max-h-96 overflow-y-auto">
        {text}
      </div>
    </details>
  );
}

/** Splits a raw tool_result.content payload into displayable text and
 *  non-text media blocks (image/document). Anything that isn't a string
 *  or a recognizable ContentBlock[] falls back to a pretty-printed JSON
 *  string so the fallback path never throws on shapes it doesn't know. */
function extractOutput(output: unknown): { text: string | null; media: ContentBlockLike[] } {
  if (output === undefined || output === null) return { text: null, media: [] };
  if (typeof output === "string") return { text: output || null, media: [] };
  if (isContentBlockArray(output)) {
    const texts: string[] = [];
    const media: ContentBlockLike[] = [];
    for (const block of output) {
      if (block.type === "text") {
        if (block.text) texts.push(block.text);
      } else {
        media.push(block);
      }
    }
    return { text: texts.length > 0 ? texts.join("\n") : null, media };
  }
  try {
    return { text: JSON.stringify(output, null, 2), media: [] };
  } catch {
    return { text: String(output), media: [] };
  }
}

// ---------------------------------------------------------------------
// Per-tool bodies
// ---------------------------------------------------------------------

function renderBash(
  input: Record<string, unknown>,
  outputText: string | null,
  media: ContentBlockLike[],
  errorText: string | undefined,
  hasOutput: boolean,
): ReactNode {
  const command = asString(input.command) ?? "";
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-1.5 font-mono text-[12.5px] text-fg">
        <TerminalIcon className="size-3.5 shrink-0 mt-0.5 text-fg-subtle" />
        <span>
          <span className="text-fg-subtle select-none">{"$ "}</span>
          <span className="whitespace-pre-wrap break-words">{command}</span>
        </span>
      </div>
      <MediaBlocks media={media} />
      {errorText ? (
        <OutputError errorText={errorText} />
      ) : (
        hasOutput && outputText && <MonoBlock>{stripExitPrefix(outputText)}</MonoBlock>
      )}
    </div>
  );
}

function renderRead(
  input: Record<string, unknown>,
  outputText: string | null,
  media: ContentBlockLike[],
  errorText: string | undefined,
  hasOutput: boolean,
): ReactNode {
  const path = asString(input.file_path) ?? asString(input.path);
  const lang = inferLanguage(path);
  return (
    <div className="space-y-2">
      {path && <MetaRow icon={<FileIcon className="size-3.5 shrink-0" />}>{path}</MetaRow>}
      <MediaBlocks media={media} />
      {errorText ? (
        <OutputError errorText={errorText} />
      ) : (
        hasOutput && outputText && (
          lang ? (
            <div className="overflow-hidden rounded-md">
              <CodeBlock code={stripReadLineNumbers(outputText)} language={lang} showLineNumbers />
            </div>
          ) : (
            <MonoBlock>{outputText}</MonoBlock>
          )
        )
      )}
    </div>
  );
}

function renderWrite(
  input: Record<string, unknown>,
  outputText: string | null,
  errorText: string | undefined,
  hasOutput: boolean,
): ReactNode {
  const path = asString(input.file_path);
  const content = asString(input.content) ?? "";
  const lang = inferLanguage(path);
  return (
    <div className="space-y-2">
      {path && <MetaRow icon={<FilePlusIcon className="size-3.5 shrink-0" />}>{path}</MetaRow>}
      {content && (
        lang ? (
          <div className="overflow-hidden rounded-md">
            <CodeBlock code={content} language={lang} showLineNumbers />
          </div>
        ) : (
          <MonoBlock>{content}</MonoBlock>
        )
      )}
      {errorText && <OutputError errorText={errorText} />}
      {!errorText && hasOutput && outputText && (
        <div className="text-[12px] text-fg-subtle">{outputText}</div>
      )}
    </div>
  );
}

function renderEdit(
  input: Record<string, unknown>,
  outputText: string | null,
  errorText: string | undefined,
  hasOutput: boolean,
): ReactNode {
  const path = asString(input.file_path);
  const oldStr = asString(input.old_string) ?? asString(input.old_str);
  const newStr = asString(input.new_string) ?? asString(input.new_str);
  const replaceAll = input.replace_all === true;
  return (
    <div className="space-y-2">
      {path && (
        <MetaRow icon={<FilePenIcon className="size-3.5 shrink-0" />}>
          {path}{replaceAll ? " · replace all" : ""}
        </MetaRow>
      )}
      {(oldStr !== undefined || newStr !== undefined) && (
        <div className="overflow-hidden rounded-md font-mono text-[12.5px]">
          {oldStr && oldStr.split("\n").map((line, i) => (
            <div key={`del-${i}`} className="bg-danger-subtle text-danger px-3 py-0.5 whitespace-pre-wrap break-words">
              <span className="select-none opacity-60">{"- "}</span>{line}
            </div>
          ))}
          {newStr && newStr.split("\n").map((line, i) => (
            <div key={`add-${i}`} className="bg-success-subtle text-success px-3 py-0.5 whitespace-pre-wrap break-words">
              <span className="select-none opacity-60">{"+ "}</span>{line}
            </div>
          ))}
        </div>
      )}
      {errorText && <OutputError errorText={errorText} />}
      {!errorText && hasOutput && outputText && (
        <div className="text-[12px] text-fg-subtle">{outputText}</div>
      )}
    </div>
  );
}

function renderGlob(
  input: Record<string, unknown>,
  outputText: string | null,
  errorText: string | undefined,
  hasOutput: boolean,
): ReactNode {
  const pattern = asString(input.pattern) ?? "";
  const dir = asString(input.path);
  return (
    <div className="space-y-2">
      <MetaRow icon={<FolderSearchIcon className="size-3.5 shrink-0" />}>
        {pattern}{dir ? ` in ${dir}` : ""}
      </MetaRow>
      {errorText ? (
        <OutputError errorText={errorText} />
      ) : (
        hasOutput && outputText && <ResultList text={outputText} />
      )}
    </div>
  );
}

function renderGrep(
  input: Record<string, unknown>,
  outputText: string | null,
  errorText: string | undefined,
  hasOutput: boolean,
): ReactNode {
  const pattern = asString(input.pattern) ?? "";
  const dir = asString(input.path);
  const mode = asString(input.output_mode);
  return (
    <div className="space-y-2">
      <MetaRow icon={<SearchIcon className="size-3.5 shrink-0" />}>
        {pattern}{dir ? ` in ${dir}` : ""}{mode ? ` (${mode})` : ""}
      </MetaRow>
      {errorText ? (
        <OutputError errorText={errorText} />
      ) : (
        hasOutput && outputText && (
          outputText === "No matches found"
            ? <div className="text-[12px] text-fg-subtle">{outputText}</div>
            : <ResultList text={outputText} />
        )
      )}
    </div>
  );
}

function renderWebFetch(
  input: Record<string, unknown>,
  outputText: string | null,
  media: ContentBlockLike[],
  errorText: string | undefined,
  hasOutput: boolean,
): ReactNode {
  const url = asString(input.url);
  return (
    <div className="space-y-2">
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1.5 text-[12.5px] text-info hover:underline truncate"
        >
          <GlobeIcon className="size-3.5 shrink-0" />
          <span className="truncate">{url}</span>
        </a>
      )}
      <MediaBlocks media={media} />
      {errorText ? (
        <OutputError errorText={errorText} />
      ) : (
        hasOutput && outputText && <ExpandableText text={outputText} />
      )}
    </div>
  );
}

interface SearchResultLike {
  title?: string;
  url?: string;
  description?: string;
  snippet?: string;
}

function parseSearchResults(text: string): SearchResultLike[] | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed) && parsed.every((r) => isRecord(r))) {
      return parsed as SearchResultLike[];
    }
  } catch {
    // Not JSON (e.g. "DuckDuckGo rate limited…") — fall through to raw text.
  }
  return null;
}

function renderWebSearch(
  input: Record<string, unknown>,
  outputText: string | null,
  errorText: string | undefined,
  hasOutput: boolean,
): ReactNode {
  const query = asString(input.query) ?? "";
  const results = outputText ? parseSearchResults(outputText) : null;
  return (
    <div className="space-y-2">
      <MetaRow icon={<SearchIcon className="size-3.5 shrink-0" />}>{query}</MetaRow>
      {errorText ? (
        <OutputError errorText={errorText} />
      ) : hasOutput && outputText ? (
        results ? (
          results.length === 0 ? (
            <div className="text-[12px] text-fg-subtle">No results</div>
          ) : (
            <div className="space-y-2">
              {results.map((r, i) => (
                <div key={i} className="rounded-md bg-muted/40 px-3 py-2 space-y-0.5">
                  {r.url ? (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      className="block truncate text-[13px] font-medium text-info hover:underline"
                    >
                      {r.title || r.url}
                    </a>
                  ) : (
                    <div className="truncate text-[13px] font-medium text-fg">{r.title || "Untitled"}</div>
                  )}
                  {r.url && <div className="truncate text-[11px] text-fg-subtle">{r.url}</div>}
                  {(r.description || r.snippet) && (
                    <div className="line-clamp-2 text-[12px] text-fg-subtle">{r.description || r.snippet}</div>
                  )}
                </div>
              ))}
            </div>
          )
        ) : (
          <MonoBlock>{outputText}</MonoBlock>
        )
      ) : null}
    </div>
  );
}

function formatOutputBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function formatUtcClock(iso?: string): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return undefined;
  return `${d.toISOString().slice(11, 16)} UTC`;
}

function parseOutputFileResult(outputText: string | null): Record<string, unknown> | null {
  if (!outputText) return null;
  const trimmed = outputText.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function renderOutputFile(
  input: Record<string, unknown>,
  outputText: string | null,
  errorText: string | undefined,
  hasOutput: boolean,
  timestamp?: string,
): ReactNode {
  const result = parseOutputFileResult(outputText);
  const path = asString(result?.path) ?? asString(input.path) ?? asString(input.filename) ?? "deliverable";
  const description = asString(result?.description) ?? asString(input.description);
  const mediaType = asString(result?.media_type) ?? asString(input.media_type);
  const size = typeof result?.size_bytes === "number" ? result.size_bytes : undefined;
  const clock = formatUtcClock(timestamp);

  const meta: string[] = [];
  if (typeof size === "number") meta.push(formatOutputBytes(size));
  else if (mediaType) meta.push(mediaType);
  meta.push("declared output");
  if (clock) meta.push(clock);

  return (
    <div
      className="rounded-md border border-border bg-bg-surface/60 px-3 py-2.5 space-y-1"
      data-testid="output-file-card"
    >
      <div className="flex items-start gap-2">
        <FileIcon className="size-3.5 shrink-0 mt-0.5 text-fg-subtle" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-medium text-fg font-mono" title={path}>
            {basename(path)}
          </div>
          {description && (
            <div className="text-[12px] text-fg-muted mt-0.5 line-clamp-2">{description}</div>
          )}
        </div>
        <span className="shrink-0 text-[10px] font-medium text-fg-subtle whitespace-nowrap">
          ★ Declared output
        </span>
      </div>
      <div className="text-[11px] text-fg-subtle">{meta.join(" · ")}</div>
      {errorText && <OutputError errorText={errorText} />}
      {hasOutput && outputText && !result && !errorText && (
        <div className="text-[12px] text-fg-subtle">{outputText}</div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------

/**
 * Body renderer for an `agent.tool_use` / `agent.custom_tool_use` /
 * `agent.mcp_tool_use` card, dispatched by built-in tool name. Returns
 * only the ToolContent body — the caller supplies the surrounding
 * <Tool><ToolHeader/><ToolContent> shell (see EventRender in
 * SessionDetail.tsx) so collapse state, the status pill, and the
 * paired-result lookup stay in one place.
 */
export function renderToolCall({ name, input, output, errorText, state, mcpServerName, timestamp }: RenderToolCallProps): ReactNode {
  const safeInput = isRecord(input) ? input : {};
  const { text: outputText, media } = extractOutput(output);
  const hasOutput = state === "output-available" || state === "output-error" || state === "output-denied";

  // MCP tools carry a server name and arbitrary, non-catalog input/output
  // shapes — keep the generic JSON view but still surface any image/
  // document blocks the server returned instead of dumping their base64
  // into the JSON blob.
  if (mcpServerName) {
    return (
      <>
        <MediaBlocks media={media} />
        <ToolInput input={safeInput} />
        {hasOutput && <ToolOutput output={output as ToolPart["output"]} errorText={errorText} />}
      </>
    );
  }

  switch (name) {
    case "bash":
      return renderBash(safeInput, outputText, media, errorText, hasOutput);
    case "read":
      return renderRead(safeInput, outputText, media, errorText, hasOutput);
    case "write":
      return renderWrite(safeInput, outputText, errorText, hasOutput);
    case "edit":
      return renderEdit(safeInput, outputText, errorText, hasOutput);
    case "glob":
      return renderGlob(safeInput, outputText, errorText, hasOutput);
    case "grep":
      return renderGrep(safeInput, outputText, errorText, hasOutput);
    case "web_fetch":
      return renderWebFetch(safeInput, outputText, media, errorText, hasOutput);
    case "web_search":
      return renderWebSearch(safeInput, outputText, errorText, hasOutput);
    case "output_file":
      return renderOutputFile(safeInput, outputText, errorText, hasOutput, timestamp);
    default:
      // Unknown/custom tool — generic JSON, but media blocks (e.g. a
      // computer-use screenshot returned by a custom tool) still render
      // as attachments instead of a base64 JSON dump.
      return (
        <>
          <MediaBlocks media={media} />
          <ToolInput input={safeInput} />
          {hasOutput && <ToolOutput output={output as ToolPart["output"]} errorText={errorText} />}
        </>
      );
  }
}

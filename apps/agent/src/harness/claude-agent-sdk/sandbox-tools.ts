/**
 * Sandbox bridge for the Claude Agent SDK harness.
 *
 * Exposes OMA's `SandboxExecutor` as an in-process MCP server (bash / read /
 * write / edit / glob / grep) so the Claude Agent SDK's model acts on the
 * SAME sandbox every other OMA harness uses, instead of the Claude Code
 * CLI's own built-in filesystem/bash tools — which run against the *host*
 * process's cwd and have no notion of OMA's sandbox at all (see the
 * `tools: []` + `mcpServers` wiring in `../claude-agent-sdk-loop.ts` for why
 * the built-ins are disabled entirely rather than run alongside these).
 *
 * Adapts SandboxExecutor to an external framework's own tool-call contract —
 * here the Claude Agent SDK's in-process MCP tool contract (`createSdkMcpServer`
 * + `tool(...)`). Shares the pure exec-string helpers in `../exec-result.ts`.
 *
 * Scope: bash / read (text) / write / edit / glob / grep — the sandbox-
 * facing subset every harness needs. `web_fetch` / `web_search` / schedule
 * tools are a separate, non-sandbox concern (see `../tools.ts`) and are
 * intentionally not bridged here.
 */

import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { SandboxExecutor } from "@getoma/sandbox-sdk";
import { shellQuote, parseExecResult } from "../exec-result";

const MAX_RESULT_CHARS = 50_000;
const DEFAULT_BASH_TIMEOUT_MS = 120_000; // 2 minutes
const MAX_BASH_TIMEOUT_MS = 600_000; // 10 minutes

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text;
  return `${text.slice(0, MAX_RESULT_CHARS)}\n...(truncated, ${text.length} total chars)`;
}

/**
 * Wrap a tool handler so a thrown error becomes an `isError` CallToolResult
 * (surfaced to the model as a normal tool failure it can react to) instead
 * of an unhandled rejection that would kill the whole MCP transport.
 */
function safe<Args>(
  fn: (args: Args) => Promise<CallToolResult>,
): (args: Args) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return await fn(args);
    } catch (err) {
      return textResult(`Error: ${err instanceof Error ? err.message : String(err)}`, true);
    }
  };
}

/**
 * Build the `oma-sandbox` MCP server instance. Pass the result on
 * `query({ options: { mcpServers: { oma: buildOmaSandboxMcpServer(...) } } })`.
 */
export function buildOmaSandboxMcpServer(sandbox: SandboxExecutor): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "oma-sandbox",
    version: "1.0.0",
    tools: [
      tool(
        "bash",
        "Execute a bash command in the sandbox. Returns exit code + stdout/stderr. " +
          "Bounded by `timeout` (default 120s, max 600s) — on timeout the process is " +
          "terminated and any partial output is returned.",
        {
          command: z.string().describe("The bash command to execute"),
          timeout: z
            .number()
            .optional()
            .describe("Timeout in milliseconds (default 120000, max 600000)"),
        },
        safe(async ({ command, timeout }: { command: string; timeout?: number }) => {
          const timeoutMs = Math.min(timeout || DEFAULT_BASH_TIMEOUT_MS, MAX_BASH_TIMEOUT_MS);
          const raw = await sandbox.exec(command, timeoutMs);
          return textResult(truncate(raw));
        }),
      ),
      tool(
        "read",
        "Read a text file from the sandbox filesystem. Supports offset/limit for " +
          "chunked reads of large files. By default reads the entire file.",
        {
          file_path: z.string().describe("Absolute file path to read, e.g. /workspace/index.html"),
          offset: z.number().optional().describe("1-based line number to start reading from"),
          limit: z.number().optional().describe("Number of lines to read"),
        },
        safe(async ({ file_path, offset, limit }: { file_path: string; offset?: number; limit?: number }) => {
          const content = await sandbox.readFile(file_path);
          if (offset === undefined && limit === undefined) return textResult(truncate(content));
          const lines = content.split("\n");
          const start = Math.max(0, (offset ?? 1) - 1);
          const end = limit !== undefined ? start + limit : lines.length;
          const slice = lines.slice(start, end);
          return textResult(
            truncate(
              slice.map((l, i) => `${start + i + 1}\t${l}`).join("\n") +
                (end < lines.length ? `\n...(file has ${lines.length} total lines)` : ""),
            ),
          );
        }),
      ),
      tool(
        "write",
        "Write content to a file in the sandbox. Creates parent directories " +
          "automatically. Overwrites the file if it already exists.",
        {
          file_path: z.string().describe("Absolute file path to write to, e.g. /workspace/index.html"),
          content: z.string().describe("The complete file content to write"),
        },
        safe(async ({ file_path, content }: { file_path: string; content: string }) => {
          await sandbox.writeFile(file_path, content);
          return textResult(`Wrote ${content.length} bytes to ${file_path}`);
        }),
      ),
      tool(
        "edit",
        "Performs exact string replacement in a file. old_string must be unique in " +
          "the file unless replace_all is true.",
        {
          file_path: z.string().describe("Absolute file path to edit"),
          old_string: z.string().describe("Exact string to find and replace"),
          new_string: z.string().describe("Replacement string"),
          replace_all: z.boolean().optional().describe("Replace all occurrences (default false)"),
        },
        safe(
          async ({
            file_path,
            old_string,
            new_string,
            replace_all,
          }: {
            file_path: string;
            old_string: string;
            new_string: string;
            replace_all?: boolean;
          }) => {
            const content = await sandbox.readFile(file_path);
            if (!content.includes(old_string)) {
              return textResult("Error: old_string not found in file", true);
            }
            if (!replace_all) {
              const occurrences = content.split(old_string).length - 1;
              if (occurrences > 1) {
                return textResult(
                  `Error: old_string appears ${occurrences} times in file. ` +
                    "Provide more surrounding context to make it unique, or pass replace_all=true.",
                  true,
                );
              }
            }
            const updated = replace_all
              ? content.split(old_string).join(new_string)
              : content.replace(old_string, new_string);
            await sandbox.writeFile(file_path, updated);
            return textResult(`Edited ${file_path}`);
          },
        ),
      ),
      tool(
        "glob",
        'Fast file pattern matching. Supports glob patterns like "**/*.ts". Returns ' +
          "matching file paths sorted by modification time (most recent first).",
        {
          pattern: z.string().describe('Glob pattern (e.g. "**/*.ts", "src/**/*.js")'),
          path: z.string().optional().describe("Directory to search in (defaults to /workspace)"),
        },
        safe(async ({ pattern, path }: { pattern: string; path?: string }) => {
          const dir = path || "/workspace";
          const cmd =
            `cd ${shellQuote(dir)} 2>/dev/null && ` +
            `bash -O globstar -O nullglob -c ${shellQuote(
              `for f in ${pattern}; do printf '%s\\t%s\\n' "$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0)" "$f"; done | sort -rn | head -n 250 | cut -f2-`,
            )}`;
          const { stdout, exitCode } = parseExecResult(await sandbox.exec(cmd));
          const out = stdout.trimEnd();
          if (exitCode !== 0) {
            return textResult(truncate(`Error: glob exited with code ${exitCode}\n${out}`), true);
          }
          if (!out) return textResult("No files matched the pattern");
          const files = out.split("\n").filter(Boolean);
          return textResult(
            truncate(`Found ${files.length} file${files.length === 1 ? "" : "s"}\n${files.join("\n")}`),
          );
        }),
      ),
      tool(
        "grep",
        "Search file contents using grep. output_mode: files_with_matches (default) | " +
          "content | count.",
        {
          pattern: z.string().describe("The regular expression pattern to search for in file contents"),
          path: z.string().optional().describe("File or directory to search (defaults to /workspace)"),
          output_mode: z
            .enum(["content", "files_with_matches", "count"])
            .optional()
            .describe('Output mode (default: "files_with_matches")'),
          case_insensitive: z.boolean().optional().describe("Case-insensitive search"),
          glob: z.string().optional().describe('Filter files by glob, e.g. "*.ts"'),
        },
        safe(
          async ({
            pattern,
            path,
            output_mode,
            case_insensitive,
            glob,
          }: {
            pattern: string;
            path?: string;
            output_mode?: "content" | "files_with_matches" | "count";
            case_insensitive?: boolean;
            glob?: string;
          }) => {
            const dir = path || "/workspace";
            const mode = output_mode || "files_with_matches";
            const flags = [
              "-r",
              "-E",
              case_insensitive ? "-i" : "",
              mode === "files_with_matches" ? "-l" : "",
              mode === "count" ? "-c" : "",
              mode === "content" ? "-n" : "",
            ]
              .filter(Boolean)
              .join(" ");
            const includeFlag = glob ? `--include=${shellQuote(glob)}` : "";
            const cmd = `grep ${flags} ${includeFlag} ${shellQuote(pattern)} ${shellQuote(dir)} 2>&1 | head -n 250`;
            const { stdout } = parseExecResult(await sandbox.exec(cmd));
            const out = stdout.trimEnd();
            return textResult(truncate(out || "No matches found"));
          },
        ),
      ),
    ],
  });
}

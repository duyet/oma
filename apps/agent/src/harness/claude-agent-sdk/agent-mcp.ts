/**
 * Bridge platform-built agent MCP tools into Claude Agent SDK `mcpServers`.
 *
 * The Standard harness exposes remote MCP tools as AI-SDK tools on
 * `ctx.tools` under `mcp__<server>__<tool>` (see `../tools.ts`). The Claude
 * Agent SDK harness does not pass `ctx.tools` into `query()` — it only
 * speaks MCP servers — so without this bridge, `agent.mcp_servers` are
 * silently ignored.
 *
 * We re-export those already-discovered, already-proxied tools as
 * in-process SDK MCP servers (`createSdkMcpServer`). Credentials never
 * enter the CLI subprocess: the platform tool's `execute` still routes
 * through `env.mcpBinding` / the Node MCP proxy.
 */

import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  OMA_SANDBOX_MCP_NAME,
  groupPlatformMcpTools,
  type PlatformToolLike,
} from "./agent-mcp-group";

export { OMA_SANDBOX_MCP_NAME, groupPlatformMcpTools, type PlatformToolLike };

/**
 * Open object shape for ZodRawShape (createSdkMcpServer's tool() rejects
 * z.record). Platform tools already validate; we re-pass the full args
 * object through the catchall.
 */
const LOOSE_INPUT = {
  // Catch-all key so arbitrary MCP tool args are accepted by the schema.
  _args: z.record(z.string(), z.unknown()).optional(),
};

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], isError };
}

function formatToolResult(value: unknown): CallToolResult {
  if (value == null) return textResult("");
  if (typeof value === "string") return textResult(value);
  if (typeof value === "object" && value !== null && "content" in value) {
    const content = (value as { content: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .map((c) => {
          if (c && typeof c === "object" && "text" in c) return String((c as { text: unknown }).text);
          return typeof c === "string" ? c : JSON.stringify(c);
        })
        .join("\n");
      const isError = Boolean((value as { isError?: boolean }).isError);
      return textResult(text, isError);
    }
  }
  try {
    return textResult(JSON.stringify(value, null, 2));
  } catch {
    return textResult(String(value));
  }
}

/**
 * Build additional `mcpServers` entries from platform tools already on
 * `ctx.tools`. Only servers that have at least one discovered tool are
 * included (fail-open for servers that failed discovery in buildTools).
 *
 * When `allowedServerNames` is provided, only those names are included
 * (intersection with discovered tools). When omitted, every discovered
 * `mcp__*` server is bridged.
 */
export function buildAgentMcpServersFromPlatformTools(
  tools: Record<string, PlatformToolLike>,
  allowedServerNames?: string[] | null,
): Record<string, McpSdkServerConfigWithInstance> {
  const allowed =
    allowedServerNames && allowedServerNames.length > 0
      ? new Set(allowedServerNames.filter((n) => n && n !== OMA_SANDBOX_MCP_NAME))
      : null;

  const grouped = groupPlatformMcpTools(tools);
  const out: Record<string, McpSdkServerConfigWithInstance> = {};

  for (const [serverName, entries] of grouped) {
    if (allowed && !allowed.has(serverName)) continue;
    if (entries.length === 0) continue;

    const sdkTools = entries.map(({ toolName, platformKey, tool: platformTool }) => {
      const description =
        (typeof platformTool.description === "string" && platformTool.description) ||
        `MCP tool ${toolName} from server ${serverName}`;
      // Empty shape + cast: remote MCP tool JSON Schemas vary; the platform
      // tool's execute already validates. Spreading args as any keeps the
      // bridge from inventing a wrong Zod object per tool.
      return tool(
        toolName,
        description,
        LOOSE_INPUT,
        async (args) => {
          if (typeof platformTool.execute !== "function") {
            return textResult(
              `Error: platform tool ${platformKey} has no execute() — MCP binding missing?`,
              true,
            );
          }
          try {
            // Prefer full raw args; strip our optional catchall wrapper if present.
            const raw = (args ?? {}) as Record<string, unknown>;
            const payload =
              raw._args && typeof raw._args === "object" && !Array.isArray(raw._args)
                ? (raw._args as Record<string, unknown>)
                : raw;
            const result = await platformTool.execute(payload, {
              toolCallId: `cas-mcp-${serverName}-${toolName}`,
              messages: [],
            });
            return formatToolResult(result);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return textResult(`Error: ${msg}`, true);
          }
        },
      );
    });

    out[serverName] = createSdkMcpServer({
      name: serverName,
      version: "1.0.0",
      tools: sdkTools,
    });
  }

  return out;
}

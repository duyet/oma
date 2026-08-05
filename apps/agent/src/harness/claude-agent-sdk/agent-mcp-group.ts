/**
 * Pure grouping of platform `mcp__*` tools for the Claude Agent SDK bridge.
 * Kept free of `@anthropic-ai/claude-agent-sdk` so unit tests run under the
 * workers pool without loading the CLI binary.
 */

/** Sandbox bridge name reserved by ClaudeAgentSdkHarness — never reuse. */
export const OMA_SANDBOX_MCP_NAME = "oma";

const MCP_TOOL_PREFIX = "mcp__";

export interface PlatformToolLike {
  description?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  execute?: (args: any, options?: any) => Promise<unknown> | unknown;
}

/**
 * Parse `mcp__<server>__<tool>` keys into server → tool map.
 * Malformed keys (missing parts, reserved `oma` server) are skipped.
 */
export function groupPlatformMcpTools(
  tools: Record<string, PlatformToolLike>,
): Map<string, Array<{ toolName: string; platformKey: string; tool: PlatformToolLike }>> {
  const byServer = new Map<
    string,
    Array<{ toolName: string; platformKey: string; tool: PlatformToolLike }>
  >();
  for (const [key, t] of Object.entries(tools)) {
    if (!key.startsWith(MCP_TOOL_PREFIX)) continue;
    const rest = key.slice(MCP_TOOL_PREFIX.length);
    const sep = rest.indexOf("__");
    if (sep <= 0 || sep === rest.length - 2) continue;
    const server = rest.slice(0, sep);
    const toolName = rest.slice(sep + 2);
    if (!server || !toolName) continue;
    if (server === OMA_SANDBOX_MCP_NAME) continue;
    const list = byServer.get(server) ?? [];
    list.push({ toolName, platformKey: key, tool: t });
    byServer.set(server, list);
  }
  return byServer;
}

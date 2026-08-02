// Zod schemas for `AgentHook` (issue #76 Part B). Colocated with the wire
// types in types.ts so the agent config `hooks` array is validated wherever
// agents are accepted (http-routes agents CRUD). Mirrors the notify-schema
// discipline: a webhook target's `secret_ref` is a vault credential id — the
// live HMAC secret is resolved at dispatch time, never inlined alongside the
// agent config.

import { z } from "zod";

const webhookHookTarget = z.object({
  type: z.literal("webhook"),
  url: z.string().url(),
  secret_ref: z.string().optional(),
});

const mcpToolHookTarget = z.object({
  type: z.literal("mcp_tool"),
  server: z.string(),
  tool: z.string(),
});

const hookTargetSchema = z.discriminatedUnion("type", [
  webhookHookTarget,
  mcpToolHookTarget,
]);

export const agentHookSchema = z.object({
  event: z.enum(["pre_tool", "post_tool", "session_start", "session_idle"]),
  matcher: z.string().optional(),
  target: hookTargetSchema,
  timeout_ms: z.number().int().positive().optional(),
  on_error: z.enum(["open", "closed"]).optional(),
});

export const agentHooksSchema = z.array(agentHookSchema);

export type AgentHookInput = z.infer<typeof agentHookSchema>;

/**
 * ClaudeAgentSdkHarness — a `HarnessInterface` implementation that runs a
 * turn through Anthropic's official `@anthropic-ai/claude-agent-sdk`
 * instead of OMA's own `generateText`/`streamText` loop. Like
 * `FlueHarness`, this is a META-harness: OMA hands the whole turn to an
 * external agent runtime, which owns its own model loop, context window,
 * and (for this SDK specifically) its own on-disk session/transcript
 * persistence — so the compaction / context ports below are deliberate
 * no-ops, mirroring `flue-loop.ts`.
 *
 * ── Why this only runs under the Node self-host (apps/main-node) ─────────
 * `@anthropic-ai/claude-agent-sdk`'s `query()` does not talk to the
 * Anthropic API directly. It spawns Claude Code's own CLI as a *native
 * subprocess* (bundled per-platform via `optionalDependencies`, run through
 * `bun`/`deno`/`node`) and speaks an internal JSON control protocol over its
 * stdio. That requires `child_process`-style process spawning and a real
 * filesystem to extract/locate the native binary — neither is available
 * inside a Cloudflare Workers isolate (apps/agent's CF runtime). This is a
 * hard constraint of the SDK's architecture, not a gap in this harness: it
 * is why this file is wired into `apps/main-node`'s `buildHarness` router
 * only (see apps/main-node/src/index.ts) and is NOT registered in
 * `apps/agent/src/index.ts`'s CF-worker harness registry. Under
 * apps/main-node (a real, long-running Node.js process) subprocess
 * spawning and a scratch directory are both available, so the SDK runs
 * exactly as documented there.
 *
 * ── Per-turn flow ──────────────────────────────────────────────────────
 *   1. Resolve the model id + Anthropic credentials — per-agent from
 *      `ctx.env.modelProvider` (a model card resolved by the self-host
 *      Node shell, issue #316) when present, else from the global
 *      `ctx.env` vars. See ./claude-agent-sdk/model.ts.
 *   2. Build an in-process MCP server that bridges `ctx.runtime.sandbox`
 *      into bash/read/write/edit/glob/grep tool calls the Claude Agent SDK
 *      can invoke (see `./claude-agent-sdk/sandbox-tools.ts` — mirrors
 *      `./flue/sandbox-bridge.ts`'s role for FlueHarness). The CLI's own
 *      built-in tools are disabled entirely (`tools: []`) so every
 *      model-facing tool call is OMA's sandbox, never the host filesystem.
 *   3. Derive a stable per-OMA-session CLI session id (the SDK requires a
 *      UUID; OMA session ids are `sess-<nanoid>` strings — see
 *      `deriveSessionUuid` below) so multi-turn conversations resume the
 *      same underlying CLI session instead of starting fresh each turn.
 *   4. Call `query({ prompt, options })` and stream the resulting
 *      `SDKMessage`s through `ClaudeAgentSdkEventTranslator`, which
 *      projects them onto OMA `SessionEvent`s (see
 *      `./claude-agent-sdk/translate.ts` — mirrors `./flue/translate.ts`).
 *   5. Report usage and surface any turn-level error as `session.error`.
 */

import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { HarnessInterface, HarnessContext, HarnessRuntime } from "./interface";
import type { SessionEvent, UserMessageEvent } from "@duyet/oma-shared";
import { generateEventId, log, logError } from "@duyet/oma-shared";
import { buildOmaSandboxMcpServer } from "./claude-agent-sdk/sandbox-tools";
import { ClaudeAgentSdkEventTranslator } from "./claude-agent-sdk/translate";
import { resolveClaudeSdkProvider } from "./claude-agent-sdk/model";

/** Base scratch directory the CLI subprocess is spawned from. Only its own
 *  process bookkeeping (and the disabled built-in tools, which never run —
 *  see the `tools: []` note in `run()`) touch this path; all agent-visible
 *  file/bash work happens in OMA's sandbox via the MCP bridge. */
const WORKSPACE_ROOT = join(tmpdir(), "oma-claude-agent-sdk");

export class ClaudeAgentSdkHarness implements HarnessInterface {
  // Meta-harness: the Claude Agent SDK (Claude Code CLI subprocess) owns its
  // own context window, compaction, and system-prompt/skill assembly for
  // the turns it drives — mirrors FlueHarness. OMA must not drive any of
  // these ports for a Claude Agent SDK turn; they are deliberate no-ops.
  async onSessionInit(): Promise<void> {
    /* no-op — see class jsdoc. */
  }

  shouldCompact(): boolean {
    return false; // The CLI manages its own context window/compaction.
  }

  async compact(): Promise<void> {
    /* no-op — the CLI compacts internally. */
  }

  deriveModelContext(): never[] {
    return []; // never called — OMA doesn't run generateText for this turn.
  }

  async run(ctx: HarnessContext): Promise<void> {
    const runtime = ctx.runtime;

    const userText = extractUserText(ctx.userMessage);
    if (!userText) {
      this.#emitError(runtime, "Could not extract text from user message — empty turn");
      return;
    }

    // Per-agent model + provider (issue #316). `ctx.env.modelProvider` is
    // populated by the self-host Node shell from the agent's model card;
    // when absent this collapses to the original global-env behavior.
    const provider = resolveClaudeSdkProvider({
      binding: ctx.env.modelProvider,
      env: ctx.env,
      agentModel: ctx.agent.model,
    });
    if (!provider.ok) {
      this.#emitError(runtime, provider.error);
      return;
    }
    const model = provider.model;
    const providerEnv = provider.env;

    const sessionSeed = ctx.session_id || ctx.userMessage.id || generateEventId();
    const sessionUuid = deriveSessionUuid(sessionSeed);
    const workspaceDir = join(WORKSPACE_ROOT, sessionUuid);

    // `agent.message` is the canonical per-turn output event every harness
    // writes to this session's history (see interface.ts's HarnessContext
    // jsdoc) — its presence is a reliable "has this OMA session produced at
    // least one assistant turn before" signal regardless of which harness
    // produced it. Use that to decide fresh session vs. resume: the SDK's
    // `sessionId` (mint fresh) and `resume` (continue) options are mutually
    // exclusive (see Options.sessionId jsdoc in the SDK's own types).
    const hasPriorTurn = runtime.history.getEvents().some((e) => e.type === "agent.message");

    const mcpServer = buildOmaSandboxMcpServer(runtime.sandbox);

    const abortController = new AbortController();
    const onAbort = () => abortController.abort();
    runtime.abortSignal?.addEventListener("abort", onAbort);

    const translator = new ClaudeAgentSdkEventTranslator(runtime);

    const runQuery = async () => {
      const q = query({
        prompt: userText,
        options: {
          model,
          // ctx.systemPrompt is OMA's fully-composed prompt (agent.system +
          // platform guidance) — pass it verbatim as a custom prompt rather
          // than the CLI's own `{type:'preset', preset:'claude_code'}`
          // default, matching how flue-loop.ts feeds it to Flue's
          // `instructions`.
          systemPrompt: ctx.systemPrompt,
          cwd: workspaceDir,
          // Disable the CLI's own built-in tools entirely — every
          // model-facing tool is OMA's sandbox-bridged MCP server (see
          // ./claude-agent-sdk/sandbox-tools.ts), so there is nothing left
          // for the CLI's own filesystem/bash tools to do, and nothing they
          // could touch the *host* process's disk for.
          tools: [],
          mcpServers: { oma: mcpServer },
          // Ignore project/user .mcp.json, plugins, and on-disk agent
          // frontmatter MCP config — this host may run turns for many
          // agents/tenants and must not leak an unrelated MCP config into
          // this one's context.
          strictMcpConfig: true,
          // OMA's sandbox is the actual security boundary here — identical
          // trust model to DefaultHarness, where every tool handed to the
          // model already has an `execute` and runs without an interactive
          // gate (see default-loop.ts's isBuiltinTool/evaluated_permission
          // handling). With the CLI's own tools fully disabled, there is
          // nothing left for its permission system to gate either.
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          abortController,
          persistSession: true,
          ...(hasPriorTurn ? { resume: sessionUuid } : { sessionId: sessionUuid }),
          env: {
            ...process.env,
            ...providerEnv,
            CLAUDE_AGENT_SDK_CLIENT_APP: "open-managed-agents/1.0",
          },
          stderr: (data: string) => {
            logError(
              { op: "claude_agent_sdk.stderr", session_id: ctx.session_id },
              data.trim(),
            );
          },
        },
      });

      for await (const message of q) {
        await translator.consume(message);
      }
    };

    try {
      await mkdir(workspaceDir, { recursive: true });
      if (runtime.keepAliveWhile) {
        await runtime.keepAliveWhile(runQuery);
      } else {
        await runQuery();
      }

      const result = translator.result;
      if (result?.usage && runtime.reportUsage) {
        const usage = result.usage as { input_tokens?: number; output_tokens?: number };
        await runtime.reportUsage(usage.input_tokens ?? 0, usage.output_tokens ?? 0);
      }
      if (result?.is_error) {
        const errors = (result as { errors?: string[] }).errors;
        const detail = errors?.length ? `: ${errors.join("; ")}` : "";
        this.#emitError(runtime, `Claude Agent SDK turn failed (${result.subtype})${detail}`);
      } else if (!result && !translator.sawAssistantOutput) {
        this.#emitError(runtime, "Claude Agent SDK turn produced no output and no result message");
      }
      log({ op: "claude_agent_sdk.turn_complete", session_id: ctx.session_id }, "turn complete");
    } catch (err) {
      logError(
        { op: "claude_agent_sdk.turn_failed", session_id: ctx.session_id, err: errMessage(err) },
        "turn failed",
      );
      this.#emitError(runtime, errMessage(err));
    } finally {
      runtime.abortSignal?.removeEventListener("abort", onAbort);
    }
  }

  #emitError(runtime: HarnessRuntime, message: string): void {
    runtime.broadcast({ type: "session.error", error: message } as SessionEvent);
  }
}

/** Extract plain text from an OMA user message's content blocks. */
function extractUserText(msg: UserMessageEvent): string {
  const content = msg.content;
  if (!Array.isArray(content)) return "";
  return (content as Array<{ type?: string; text?: string }>)
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("\n")
    .trim();
}

/**
 * Deterministic UUID (v5-style, RFC 4122 §4.3) derived from an arbitrary
 * seed string. The Claude Agent SDK's `sessionId` option requires "a valid
 * UUID"; OMA session ids are `sess-<nanoid>` strings, so they can't be
 * passed through directly. Hashing gives every OMA session a stable,
 * collision-resistant CLI session id with no persisted mapping table to
 * maintain — the same OMA session_id always derives the same CLI session
 * id, which is what makes `resume` (see `run()` above) continue the right
 * conversation turn over turn.
 */
function deriveSessionUuid(seed: string): string {
  const hash = createHash("sha1").update(`oma-claude-agent-sdk:${seed}`).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 4122
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

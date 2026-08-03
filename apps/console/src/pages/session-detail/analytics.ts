import { useMemo } from "react";

import type { Event } from "../../lib/events";

/**
 * Derived session telemetry for the right-rail Inspector.
 *
 * Everything here is computed from the event log the page already streams —
 * no extra API calls. The event log is a complete telemetry record:
 * `span.model_request_start` / `_end` pairs carry a per-provider-call token
 * breakdown, and the `agent.tool_use` / `agent.tool_result` pairs carry tool
 * latency + error state. Deriving client-side keeps the Inspector live during
 * streaming rather than stale until the next poll.
 */

/** Per-provider-call usage as emitted by default-loop.ts. All fields
 *  optional on the wire — older events predate the cache/reasoning split. */
interface ModelUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  reasoning_tokens?: number;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  reasoning: number;
}

export interface ModelCallSample {
  model?: string;
  durationMs?: number;
  usage: TokenTotals;
  isError: boolean;
  finishReason?: string;
  ts?: number;
}

export interface ToolStat {
  name: string;
  kind: "builtin" | "mcp" | "custom";
  calls: number;
  errors: number;
  /** Mean wall-clock from tool_use to its paired tool_result. Undefined
   *  when no call of this tool has completed with both timestamps. */
  avgMs?: number;
  totalMs?: number;
  lastTs?: number;
}

export interface SessionAnalytics {
  /** Model id last actually reported by the provider — authoritative over
   *  the agent snapshot's configured model, which can lag a model-card
   *  change mid-session. */
  latestModel?: string;
  /** Model the provider reported for the latest call when it differs from
   *  the handle we asked for — a gateway alias (`anyrouter/free`) resolves
   *  to a concrete `provider/model` only in the response. Undefined when the
   *  configured handle IS what ran. */
  latestResolvedModel?: string;
  /** Distinct model ids seen across the session, in first-seen order.
   *  More than one means an aux model or a mid-session switch was used. */
  modelsUsed: string[];
  totals: TokenTotals;
  /** Sum of every token kind — what the session actually cost in tokens. */
  totalTokens: number;
  /** cache_read / (cache_read + input + cache_creation). 0-1, undefined
   *  when no prompt tokens have been billed yet. */
  cacheHitRate?: number;
  modelCalls: number;
  erroredModelCalls: number;
  latest?: ModelCallSample;
  /** Mean / p95 provider latency across calls that reported both a start
   *  and an end timestamp. */
  avgLatencyMs?: number;
  p95LatencyMs?: number;
  /** Best-effort current context occupancy: the most recent call's full
   *  prompt (input + cache_read + cache_creation). This is what the model
   *  actually read, unlike `input_tokens` alone which excludes the cached
   *  prefix and understates occupancy by an order of magnitude. */
  contextTokens?: number;
  contextWindow?: number;
  tools: ToolStat[];
  toolCalls: number;
  toolErrors: number;
  /** Wall-clock across the whole event log. */
  wallClockMs?: number;
  /** Time since the newest event landed — a liveness signal for the
   *  connection panel. */
  lastEventTs?: number;
  eventCounts: Record<string, number>;
  /** Sub-agent threads spawned (session.thread_created count). */
  subAgentThreads: number;
  /** Skills injected into the system prompt, if the log reported them. */
  compactions: number;
}

/** Context-window sizes keyed by substring match against the lowercased
 *  model id. Unrecognized ids yield `undefined` so the Inspector hides the
 *  occupancy bar rather than drawing it against a guessed denominator. */
const CONTEXT_WINDOW_TOKENS: Array<{ match: RegExp; window: number }> = [
  { match: /claude.*(opus|sonnet|haiku)/, window: 200_000 },
  { match: /gpt-5|o[34]/, window: 400_000 },
  { match: /gpt-4\.1/, window: 1_000_000 },
  { match: /gpt-4o/, window: 128_000 },
  { match: /gemini/, window: 1_000_000 },
  { match: /llama|mistral|qwen/, window: 128_000 },
];

export function contextWindowFor(model: string | undefined): number | undefined {
  if (!model) return undefined;
  const id = model.toLowerCase();
  return CONTEXT_WINDOW_TOKENS.find((w) => w.match.test(id))?.window;
}

/** Rough USD-per-million-token pricing, keyed by substring match against
 *  the (lowercased) model id. Not exhaustive — an unrecognized model id
 *  (custom model card, future release) hides the cost figure rather than
 *  showing a wrong number. Cache reads are billed at 10% of input and
 *  cache writes at 125%, matching Anthropic's published multipliers. */
const MODEL_PRICING_USD_PER_MTOK: Array<{
  match: (modelId: string) => boolean;
  inputPerMtok: number;
  outputPerMtok: number;
}> = [
  { match: (id) => id.includes("opus"), inputPerMtok: 15, outputPerMtok: 75 },
  { match: (id) => id.includes("haiku"), inputPerMtok: 0.8, outputPerMtok: 4 },
  { match: (id) => id.includes("sonnet"), inputPerMtok: 3, outputPerMtok: 15 },
];

const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

/** Estimate USD cost for a token breakdown. Returns undefined when the
 *  model is unset or matches no known tier — callers must hide the cost
 *  entirely in that case rather than imply a number for a custom model. */
export function estimateCostUsd(
  model: string | undefined,
  totals: Pick<TokenTotals, "input" | "output"> & Partial<TokenTotals>,
): number | undefined {
  if (!model) return undefined;
  const pricing = MODEL_PRICING_USD_PER_MTOK.find((p) => p.match(model.toLowerCase()));
  if (!pricing) return undefined;
  const inRate = pricing.inputPerMtok / 1e6;
  return (
    totals.input * inRate +
    totals.output * (pricing.outputPerMtok / 1e6) +
    (totals.cacheRead ?? 0) * inRate * CACHE_READ_MULTIPLIER +
    (totals.cacheCreation ?? 0) * inRate * CACHE_WRITE_MULTIPLIER
  );
}

/** Cost display with a few significant figures for small per-session
 *  amounts — `formatUsd` in lib/format.ts rounds to 2 decimals, which
 *  shows "$0.00" for the common case of a cheap short session. */
export function formatEstCostUsd(n: number): string {
  if (n <= 0) return "$0.00";
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, reasoning: 0 };
}

function readUsage(u: ModelUsage | undefined): TokenTotals {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheCreation: u?.cache_creation_input_tokens ?? 0,
    reasoning: u?.reasoning_tokens ?? 0,
  };
}

function tsOf(e: Event): number | undefined {
  const raw =
    (e as { ts?: string }).ts ?? (e as { processed_at?: string }).processed_at;
  if (typeof raw !== "string") return undefined;
  const t = new Date(raw).getTime();
  return Number.isFinite(t) ? t : undefined;
}

/** Both wire shapes are in the wild: fields at the top level, or nested
 *  under `.data`. Mirrors the defensive access already used elsewhere in
 *  the session page. */
function span(e: Event): {
  model?: string;
  resolved_model?: string;
  model_usage?: ModelUsage;
  model_request_start_id?: string;
  is_error?: boolean;
  finish_reason?: string;
} {
  const raw = e as {
    data?: Record<string, unknown>;
  } & Record<string, unknown>;
  const d = (raw.data ?? {}) as Record<string, unknown>;
  return {
    model: (d.model ?? raw.model) as string | undefined,
    resolved_model: (d.resolved_model ?? raw.resolved_model) as string | undefined,
    model_usage: (d.model_usage ?? raw.model_usage) as ModelUsage | undefined,
    model_request_start_id: (d.model_request_start_id ??
      raw.model_request_start_id) as string | undefined,
    is_error: (d.is_error ?? raw.is_error) as boolean | undefined,
    finish_reason: (d.finish_reason ?? raw.finish_reason) as string | undefined,
  };
}

function percentile(sorted: number[], p: number): number | undefined {
  if (sorted.length === 0) return undefined;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function computeSessionAnalytics(events: Event[]): SessionAnalytics {
  const totals = emptyTotals();
  const startTsById = new Map<string, number>();
  const latencies: number[] = [];
  const modelsUsed: string[] = [];
  const eventCounts: Record<string, number> = {};

  let modelCalls = 0;
  let erroredModelCalls = 0;
  let latest: ModelCallSample | undefined;
  let latestModel: string | undefined;
  let latestResolvedModel: string | undefined;
  let firstTs = Infinity;
  let lastTs = -Infinity;
  let subAgentThreads = 0;
  let compactions = 0;

  // tool_use_id → pending call awaiting its result event.
  const pendingTools = new Map<
    string,
    { name: string; kind: ToolStat["kind"]; ts?: number }
  >();
  const toolStats = new Map<string, ToolStat>();

  const bumpTool = (
    name: string,
    kind: ToolStat["kind"],
  ): ToolStat => {
    const key = `${kind}:${name}`;
    let s = toolStats.get(key);
    if (!s) {
      s = { name, kind, calls: 0, errors: 0, totalMs: 0 };
      toolStats.set(key, s);
    }
    return s;
  };

  for (const e of events) {
    eventCounts[e.type] = (eventCounts[e.type] ?? 0) + 1;
    const t = tsOf(e);
    if (t !== undefined) {
      if (t < firstTs) firstTs = t;
      if (t > lastTs) lastTs = t;
    }

    switch (e.type) {
      case "session.thread_created":
        subAgentThreads += 1;
        continue;
      case "session.compacted":
      case "agent.compaction":
        compactions += 1;
        continue;
      case "span.model_request_start": {
        const id = (e as { id?: string }).id;
        if (id && t !== undefined) startTsById.set(id, t);
        continue;
      }
      case "span.model_request_end": {
        const s = span(e);
        const usage = readUsage(s.model_usage);
        totals.input += usage.input;
        totals.output += usage.output;
        totals.cacheRead += usage.cacheRead;
        totals.cacheCreation += usage.cacheCreation;
        totals.reasoning += usage.reasoning;
        modelCalls += 1;
        if (s.is_error) erroredModelCalls += 1;
        // Older events carry no resolved_model at all, so clear it per call
        // rather than letting one aliased call stick to every later one.
        latestResolvedModel = s.resolved_model;
        if (s.model) {
          latestModel = s.model;
          if (!modelsUsed.includes(s.model)) modelsUsed.push(s.model);
        }
        const startTs = s.model_request_start_id
          ? startTsById.get(s.model_request_start_id)
          : undefined;
        const durationMs =
          t !== undefined && startTs !== undefined && t >= startTs ? t - startTs : undefined;
        if (durationMs !== undefined) latencies.push(durationMs);
        // Events arrive in seq order, so the last one wins as "latest".
        latest = {
          model: s.model,
          durationMs,
          usage,
          isError: Boolean(s.is_error),
          finishReason: s.finish_reason,
          ts: t,
        };
        continue;
      }
      case "agent.tool_use":
      case "agent.custom_tool_use":
      case "agent.mcp_tool_use": {
        const kind: ToolStat["kind"] =
          e.type === "agent.mcp_tool_use"
            ? "mcp"
            : e.type === "agent.custom_tool_use"
              ? "custom"
              : "builtin";
        const name = (e.name as string | undefined) ?? "unknown";
        const stat = bumpTool(name, kind);
        stat.calls += 1;
        stat.lastTs = t ?? stat.lastTs;
        const id =
          (e.tool_use_id as string | undefined) ??
          (e.mcp_tool_use_id as string | undefined) ??
          (e.id as string | undefined);
        if (id) pendingTools.set(id, { name, kind, ts: t });
        continue;
      }
      case "agent.tool_result":
      case "agent.mcp_tool_result": {
        const id =
          (e.tool_use_id as string | undefined) ??
          (e.mcp_tool_use_id as string | undefined);
        const pending = id ? pendingTools.get(id) : undefined;
        if (!pending) continue;
        if (id) pendingTools.delete(id);
        const stat = bumpTool(pending.name, pending.kind);
        // `is_error` is the canonical flag; some tools only set `.error`.
        const errored =
          Boolean((e as { is_error?: boolean }).is_error) ||
          typeof (e as { error?: string }).error === "string";
        if (errored) stat.errors += 1;
        if (pending.ts !== undefined && t !== undefined && t >= pending.ts) {
          stat.totalMs = (stat.totalMs ?? 0) + (t - pending.ts);
        }
        continue;
      }
      default:
        continue;
    }
  }

  for (const stat of toolStats.values()) {
    if (stat.totalMs && stat.calls > 0) stat.avgMs = Math.round(stat.totalMs / stat.calls);
  }

  const promptTokens = totals.input + totals.cacheRead + totals.cacheCreation;
  const sortedLatencies = [...latencies].sort((a, b) => a - b);
  const contextTokens = latest
    ? latest.usage.input + latest.usage.cacheRead + latest.usage.cacheCreation
    : undefined;

  const tools = [...toolStats.values()].sort((a, b) => b.calls - a.calls);

  return {
    latestModel,
    latestResolvedModel,
    modelsUsed,
    totals,
    totalTokens:
      totals.input + totals.output + totals.cacheRead + totals.cacheCreation,
    cacheHitRate: promptTokens > 0 ? totals.cacheRead / promptTokens : undefined,
    modelCalls,
    erroredModelCalls,
    latest,
    avgLatencyMs:
      latencies.length > 0
        ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
        : undefined,
    p95LatencyMs: percentile(sortedLatencies, 95),
    contextTokens: contextTokens && contextTokens > 0 ? contextTokens : undefined,
    contextWindow: contextWindowFor(latestModel),
    tools,
    toolCalls: tools.reduce((a, t) => a + t.calls, 0),
    toolErrors: tools.reduce((a, t) => a + t.errors, 0),
    wallClockMs:
      Number.isFinite(firstTs) && lastTs > firstTs ? lastTs - firstTs : undefined,
    lastEventTs: Number.isFinite(lastTs) ? lastTs : undefined,
    eventCounts,
    subAgentThreads,
    compactions,
  };
}

export function useSessionAnalytics(events: Event[]): SessionAnalytics {
  return useMemo(() => computeSessionAnalytics(events), [events]);
}

/**
 * Per-sandbox-provider display metadata. The provider id comes from an
 * environment's `config.sandbox_provider` (or the legacy `config.type`), and
 * the set here mirrors `classifyCfSandboxProvider` in
 * `packages/sandbox-sdk/src/provider-config.ts` — including the CF-vs-Node
 * availability split, which is the single most common source of a confusing
 * `session.error` ("why did my k8s environment fail on Cloudflare?").
 */
export interface SandboxProviderInfo {
  id: string;
  label: string;
  /** Where the sandbox actually executes — what an operator wants to know
   *  before wondering why a file isn't on their laptop. */
  where: string;
  /** Filesystem root the agent's tools see. */
  workspace: string;
  blurb: string;
  /** Capability caveats worth surfacing next to the status dot. */
  caveats: string[];
}

const SANDBOX_PROVIDERS: Record<string, SandboxProviderInfo> = {
  cloud: {
    id: "cloud",
    label: "Cloudflare Container",
    where: "Cloudflare edge container",
    workspace: "/workspace",
    blurb: "The default managed sandbox — a Cloudflare Container with full shell, filesystem and package installs.",
    caveats: [],
  },
  boxrun: {
    id: "boxrun",
    label: "BoxRun",
    where: "Remote BoxRun control plane (BOXRUN_URL)",
    workspace: "/workspace",
    blurb: "Talks to a remote `boxlite serve` control plane over plain HTTP.",
    caveats: ["No memory-store or session-output bind mounts"],
  },
  "k8s-remote": {
    id: "k8s-remote",
    label: "Kubernetes (gateway)",
    where: "In-cluster k8s-sandbox-gateway",
    workspace: "/workspace",
    blurb: "Pods driven through the in-cluster sandbox gateway's HTTP API.",
    caveats: ["Files move as tar over HTTP", "No memory-store mounts"],
  },
  k8s: {
    id: "k8s",
    label: "Kubernetes (direct)",
    where: "Kubernetes cluster via local kubeconfig",
    workspace: "/workspace",
    blurb: "Direct in-cluster executor — self-host Node runtime only.",
    caveats: ["Node self-host only — unavailable on the Cloudflare deployment"],
  },
  openshell: {
    id: "openshell",
    label: "OpenShell",
    where: "OpenShell gateway (gRPC, via k8s-bridge on Cloudflare)",
    workspace: "/workspace",
    blurb: "gRPC-backed shell gateway; Cloudflare reaches it through a k8s-bridge in OpenShell mode.",
    caveats: ["No memory-store or session-output mounts"],
  },
  subprocess: {
    id: "subprocess",
    label: "Local machine (bridge)",
    where: "Your own machine, via `oma bridge daemon`",
    workspace: "the bridge daemon's working directory",
    blurb: "Every sandbox op is relayed over the RuntimeRoom WebSocket and executed as a real subprocess on the paired machine.",
    caveats: [
      "Outbound HTTP is NOT credential-injected — the vault proxy does not run on your machine",
      "No memory-store or session-output mounts",
      "Requires a bridge daemon to be online",
    ],
  },
  "browser-vm": {
    id: "browser-vm",
    label: "Browser VM",
    where: "A WASM VM inside a browser tab you opened",
    workspace: "/workspace (in-tab virtual disk)",
    blurb: "The tab twin of the bridge daemon — sandbox ops run against an in-tab engine (v86 by default).",
    caveats: [
      "No vault credential injection from the tab",
      "Networking is engine-proxied — no raw TCP",
      "Closing the tab takes the sandbox offline",
    ],
  },
  daytona: {
    id: "daytona",
    label: "Daytona",
    where: "Daytona-hosted workspace",
    workspace: "/workspace",
    blurb: "Managed dev-environment provider driven by its own SDK.",
    caveats: ["Node self-host only — the SDK is not bundled into the Worker"],
  },
  e2b: {
    id: "e2b",
    label: "E2B",
    where: "E2B-hosted sandbox",
    workspace: "/home/user",
    blurb: "E2B code-interpreter sandboxes driven by the `e2b` SDK.",
    caveats: ["Node self-host only — the SDK is not bundled into the Worker"],
  },
  litebox: {
    id: "litebox",
    label: "Litebox micro-VM",
    where: "Local micro-VM (native binding)",
    workspace: "/workspace",
    blurb: "Native micro-VM binding for fast local isolation.",
    caveats: ["Node self-host only — cannot run in a Worker"],
  },
  "docker-compose": {
    id: "docker-compose",
    label: "Docker Compose",
    where: "A container on the host Docker socket",
    workspace: "/workspace",
    blurb: "Runs the sandbox as a container against the host's Docker socket.",
    caveats: ["Node self-host only — needs a Docker socket"],
  },
};

export function sandboxProviderInfo(raw: string | undefined): SandboxProviderInfo {
  const id = (raw ?? "cloud").toLowerCase();
  // `local` is the documented alias for the bridge-relayed subprocess provider.
  const key = id === "local" ? "subprocess" : id;
  return (
    SANDBOX_PROVIDERS[key] ?? {
      id,
      label: id,
      where: "Unknown provider",
      workspace: "/workspace",
      blurb: "Unrecognized sandbox provider id — the platform falls back to the default cloud sandbox.",
      caveats: [],
    }
  );
}

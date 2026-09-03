// Session-scoped operator injections (issue #346). Stored on the session
// row at `metadata._oma_injections` — never on the agent record, never as
// plaintext tokens. The overlay is the source of truth; `session.config_updated`
// is an audit event the harness does not replay.

import { z } from "zod";
import type { AgentConfig, SessionConfigUpdatedEvent, ToolConfig, ToolsetConfig } from "./types";

export const METADATA_KEY = "_oma_injections";
export const INJECTIONS_METADATA_KEY = METADATA_KEY;

export const MAX_PROMPT_APPENDS = 20;
export const MAX_PROMPT_TEXT = 8000;

export interface PromptAppend {
  id: string;
  text: string;
  injected_at: string;
}

export interface SessionInjectionOverlay {
  prompt_appends: Array<{ id: string; text: string; injected_at: string }>;
  mcp_servers: Array<{
    name: string;
    url?: string;
    registry_id?: string;
    credential_id?: string;
  }>;
  tool_overrides: Record<string, boolean>;
  credentials: Array<{ host: string; credential_id: string }>;
}

export type InjectionCommand =
  | { type: "system_prompt_append"; text: string }
  | {
      type: "mcp_server_add";
      name: string;
      url?: string;
      registry_id?: string;
      credential_id?: string;
    }
  | { type: "tools_update"; enabled?: string[]; disabled?: string[] }
  | { type: "credential_inject"; host: string; credential_id: string };

const nonEmpty = z.string().trim().min(1);

const httpUrl = z
  .string()
  .trim()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), { message: "url must be http(s)" });

const injectionCommandUnion = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("system_prompt_append"),
    text: z.string().trim().min(1).max(MAX_PROMPT_TEXT),
  }),
  z.object({
    type: z.literal("mcp_server_add"),
    name: nonEmpty,
    url: httpUrl.optional(),
    registry_id: nonEmpty.optional(),
    credential_id: nonEmpty.optional(),
  }),
  z.object({
    type: z.literal("tools_update"),
    enabled: z.array(nonEmpty).optional(),
    disabled: z.array(nonEmpty).optional(),
  }),
  z.object({
    type: z.literal("credential_inject"),
    host: nonEmpty,
    credential_id: nonEmpty,
  }),
]);

export const injectionCommandSchema: z.ZodType<InjectionCommand> = injectionCommandUnion.superRefine((val, ctx) => {
  if (val.type === "mcp_server_add" && !val.url && !val.registry_id) {
    ctx.addIssue({ code: "custom", message: "url or registry_id is required" });
  }
  if (
    val.type === "tools_update" &&
    (val.enabled?.length ?? 0) + (val.disabled?.length ?? 0) === 0
  ) {
    ctx.addIssue({ code: "custom", message: "enabled or disabled must list at least one tool" });
  }
});

export function emptyInjectionOverlay(): SessionInjectionOverlay {
  return {
    prompt_appends: [],
    mcp_servers: [],
    tool_overrides: {},
    credentials: [],
  };
}

/** @deprecated Use emptyInjectionOverlay */
export const emptyOverlay = emptyInjectionOverlay;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parsePromptAppend(v: unknown): PromptAppend | null {
  if (!isRecord(v)) return null;
  if (typeof v.id !== "string" || typeof v.text !== "string" || typeof v.injected_at !== "string") {
    return null;
  }
  return { id: v.id, text: v.text, injected_at: v.injected_at };
}

function parseMcpServer(v: unknown): SessionInjectionOverlay["mcp_servers"][number] | null {
  if (!isRecord(v) || typeof v.name !== "string" || !v.name.trim()) return null;
  const out: SessionInjectionOverlay["mcp_servers"][number] = { name: v.name.trim() };
  if (typeof v.url === "string" && v.url.trim()) out.url = v.url.trim();
  if (typeof v.registry_id === "string" && v.registry_id.trim()) out.registry_id = v.registry_id.trim();
  if (typeof v.credential_id === "string" && v.credential_id.trim()) {
    out.credential_id = v.credential_id.trim();
  }
  if (!out.url && !out.registry_id) return null;
  return out;
}

function parseCredential(v: unknown): SessionInjectionOverlay["credentials"][number] | null {
  if (!isRecord(v)) return null;
  if (typeof v.host !== "string" || typeof v.credential_id !== "string") return null;
  const host = normalizeHost(v.host);
  if (!host || !v.credential_id.trim()) return null;
  return { host, credential_id: v.credential_id.trim() };
}

export function parseInjectionOverlay(raw: unknown): SessionInjectionOverlay {
  const empty = emptyInjectionOverlay();
  if (!isRecord(raw)) return empty;
  const prompt_appends = Array.isArray(raw.prompt_appends)
    ? raw.prompt_appends.map(parsePromptAppend).filter((x): x is PromptAppend => x !== null)
    : [];
  const mcp_servers = Array.isArray(raw.mcp_servers)
    ? raw.mcp_servers.map(parseMcpServer).filter((x): x is NonNullable<ReturnType<typeof parseMcpServer>> => x !== null)
    : [];
  const tool_overrides: Record<string, boolean> = {};
  if (isRecord(raw.tool_overrides)) {
    for (const [k, v] of Object.entries(raw.tool_overrides)) {
      if (typeof v === "boolean" && k.trim()) tool_overrides[k] = v;
    }
  }
  const credentials = Array.isArray(raw.credentials)
    ? raw.credentials.map(parseCredential).filter((x): x is NonNullable<ReturnType<typeof parseCredential>> => x !== null)
    : [];
  return { prompt_appends, mcp_servers, tool_overrides, credentials };
}

/** @deprecated Use parseInjectionOverlay */
export const parseSessionInjectionOverlay = parseInjectionOverlay;

export function overlayFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): SessionInjectionOverlay {
  return parseInjectionOverlay(metadata?.[METADATA_KEY]);
}

/** @deprecated Use overlayFromMetadata */
export const overlayFromSessionMetadata = overlayFromMetadata;

export function stripInjectionsFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!metadata) return {};
  const { [METADATA_KEY]: _hidden, ...rest } = metadata;
  return rest;
}

/** @deprecated Use stripInjectionsFromMetadata */
export const publicSessionMetadata = stripInjectionsFromMetadata;

/** Hostnames are stored lowercase. A caller may pass `api.example.com` or
 *  `https://api.example.com/path` — we keep the hostname only. */
export function normalizeHost(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  if (trimmed.includes("://")) {
    try {
      return new URL(trimmed).hostname || null;
    } catch {
      return null;
    }
  }
  const host = trimmed.split("/")[0]?.split(":")[0];
  if (!host || host.includes(" ")) return null;
  return host;
}

export function applyInjectionCommand(
  overlay: SessionInjectionOverlay,
  command: InjectionCommand,
  nowIso: string,
  id: string,
): SessionInjectionOverlay {
  switch (command.type) {
    case "system_prompt_append": {
      const next = [
        ...overlay.prompt_appends,
        { id, text: command.text, injected_at: nowIso },
      ];
      return {
        ...overlay,
        prompt_appends: next.length > MAX_PROMPT_APPENDS
          ? next.slice(next.length - MAX_PROMPT_APPENDS)
          : next,
      };
    }
    case "mcp_server_add": {
      const entry: SessionInjectionOverlay["mcp_servers"][number] = { name: command.name };
      if (command.url) entry.url = command.url;
      if (command.registry_id) entry.registry_id = command.registry_id;
      if (command.credential_id) entry.credential_id = command.credential_id;
      const mcp_servers = overlay.mcp_servers.filter((s) => s.name !== entry.name);
      mcp_servers.push(entry);
      return { ...overlay, mcp_servers };
    }
    case "tools_update": {
      const tool_overrides = { ...overlay.tool_overrides };
      for (const name of command.enabled ?? []) tool_overrides[name] = true;
      for (const name of command.disabled ?? []) tool_overrides[name] = false;
      return { ...overlay, tool_overrides };
    }
    case "credential_inject": {
      const host = normalizeHost(command.host);
      if (!host) return overlay;
      const credentials = overlay.credentials.filter((c) => c.host !== host);
      credentials.push({ host, credential_id: command.credential_id });
      return { ...overlay, credentials };
    }
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

export function injectionReminders(
  overlay: SessionInjectionOverlay,
): Array<{ source: string; text: string }> {
  return overlay.prompt_appends.map((p) => ({
    source: `operator-injection:${p.id}`,
    text: `[Operator injection at ${p.injected_at}]\n\n${p.text}`,
  }));
}

export function applyToolOverrides(
  enabled: Set<string>,
  overrides: Record<string, boolean> | undefined,
): Set<string> {
  if (!overrides || Object.keys(overrides).length === 0) return enabled;
  const next = new Set(enabled);
  for (const [name, on] of Object.entries(overrides)) {
    if (on) next.add(name);
    else next.delete(name);
  }
  return next;
}

export function mergeMcpServers<T extends { name: string }>(
  agentServers: T[] | undefined,
  overlayServers: SessionInjectionOverlay["mcp_servers"],
): T[] {
  const byName = new Map<string, T>();
  for (const s of agentServers ?? []) byName.set(s.name, s);
  for (const s of overlayServers) {
    const prev = byName.get(s.name);
    byName.set(s.name, {
      ...(prev as object),
      name: s.name,
      type: (prev as { type?: string } | undefined)?.type ?? "url",
      ...(s.url !== undefined ? { url: s.url } : {}),
      ...(s.registry_id !== undefined ? { registry_id: s.registry_id } : {}),
      ...(s.credential_id !== undefined ? { credential_id: s.credential_id } : {}),
    } as unknown as T);
  }
  return [...byName.values()];
}

export function credentialIdForHost(
  overlay: SessionInjectionOverlay,
  hostname: string,
): string | undefined {
  const host = hostname.trim().toLowerCase();
  return overlay.credentials.find((c) => c.host === host)?.credential_id;
}

/** @deprecated Use credentialIdForHost */
export const pickOverlayCredentialId = credentialIdForHost;

export interface ResolvedMcpServerRef {
  name: string;
  type?: string;
  url?: string;
  registry_id?: string;
  authorization_token?: string;
  credential_id?: string;
}

/** Overlay wins on name. Agent snapshot is otherwise unchanged. */
export function pickMcpServer(
  agentServers: ReadonlyArray<ResolvedMcpServerRef> | undefined,
  overlay: SessionInjectionOverlay,
  serverName: string,
): ResolvedMcpServerRef | undefined {
  const merged = mergeMcpServers(
    (agentServers ?? []) as ResolvedMcpServerRef[],
    overlay.mcp_servers,
  );
  return merged.find((s) => s.name === serverName);
}

function applyToolOverrideConfigs(
  tools: ToolConfig[] | undefined,
  overrides: Record<string, boolean>,
): ToolConfig[] {
  const keys = Object.keys(overrides);
  const list: ToolConfig[] = tools ? tools.map((t) => ({ ...t })) : [];
  if (keys.length === 0) return list;

  const hasToolset = list.some((t) => t.type !== "custom");
  if (!hasToolset) {
    list.push({ type: "agent_toolset_20260401" });
  }

  return list.map((t) => {
    if (t.type === "custom") return t;
    const ts = t as ToolsetConfig;
    const configs = [...(ts.configs ?? [])];
    for (const [name, enabled] of Object.entries(overrides)) {
      const i = configs.findIndex((c) => c.name === name);
      if (i >= 0) configs[i] = { ...configs[i], enabled };
      else configs.push({ name, enabled });
    }
    return { ...ts, configs };
  });
}

/**
 * Shallow copy of an agent snapshot with overlay MCP servers merged in
 * and toolset configs rewritten from `tool_overrides`. Does not mutate
 * the stored snapshot.
 */
export function applyOverlayToAgent(
  snapshot: AgentConfig,
  overlay: SessionInjectionOverlay,
): AgentConfig {
  const mcp_servers = mergeMcpServers(snapshot.mcp_servers, overlay.mcp_servers);
  const tools = applyToolOverrideConfigs(snapshot.tools, overlay.tool_overrides);
  if (
    mcp_servers === snapshot.mcp_servers &&
    tools === snapshot.tools
  ) {
    return snapshot;
  }
  const mcpChanged =
    mcp_servers.length !== (snapshot.mcp_servers?.length ?? 0) ||
    overlay.mcp_servers.length > 0;
  const toolsChanged = Object.keys(overlay.tool_overrides).length > 0;
  if (!mcpChanged && !toolsChanged) return snapshot;
  return {
    ...snapshot,
    mcp_servers,
    tools,
  };
}

export function configUpdatedEvent(
  command: InjectionCommand,
  id: string,
): SessionConfigUpdatedEvent {
  switch (command.type) {
    case "system_prompt_append":
      return {
        type: "session.config_updated",
        changes: ["system_prompt_append"],
        operator_injection: true,
        detail: { system_prompt_append: { id } },
      };
    case "mcp_server_add":
      return {
        type: "session.config_updated",
        changes: ["mcp_server_added"],
        operator_injection: true,
        detail: {
          mcp_server_added: {
            name: command.name,
            ...(command.url ? { url: command.url } : {}),
            ...(command.registry_id ? { registry_id: command.registry_id } : {}),
          },
        },
      };
    case "tools_update":
      return {
        type: "session.config_updated",
        changes: ["tools_updated"],
        operator_injection: true,
        detail: {
          tools_updated: {
            enabled: command.enabled ?? [],
            disabled: command.disabled ?? [],
          },
        },
      };
    case "credential_inject":
      return {
        type: "session.config_updated",
        changes: ["credential_injected"],
        operator_injection: true,
        detail: {
          credential_injected: {
            host: normalizeHost(command.host) ?? command.host,
            credential_id: command.credential_id,
          },
        },
      };
    default: {
      const _exhaustive: never = command;
      return _exhaustive;
    }
  }
}

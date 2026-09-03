import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { useApi, ApiError } from "../../lib/api";
import { Button } from "@/components/ui/button";
import type { SessionInjectionOverlay } from "@duyet/oma-api-types";
import { emptyInjectionOverlay } from "@duyet/oma-api-types";
import type { AgentRecord } from "./Inspector";

const TOGGLE_TOOLS = [
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
  "output_file",
  "browser",
  "run_dynamic_worker",
] as const;

const DEFAULT_ON = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "glob",
  "grep",
  "web_fetch",
  "web_search",
  "output_file",
]);

interface VaultCredential {
  id: string;
  display_name: string;
}

function agentEnabledSet(agent: AgentRecord | null): Set<string> {
  const tools = agent?.tools ?? [];
  const toolset = tools.find((t) => t.type !== "custom") as
    | {
        default_config?: { enabled?: boolean };
        configs?: Array<{ name?: string; enabled?: boolean }>;
      }
    | undefined;
  if (!toolset) return new Set(DEFAULT_ON);
  const defaultEnabled = toolset.default_config?.enabled ?? true;
  const enabled = new Set<string>();
  if (defaultEnabled) {
    for (const name of DEFAULT_ON) enabled.add(name);
  }
  for (const c of toolset.configs ?? []) {
    if (!c.name) continue;
    if (c.enabled) enabled.add(c.name);
    else enabled.delete(c.name);
  }
  return enabled;
}

function effectiveEnabled(
  agent: AgentRecord | null,
  overlay: SessionInjectionOverlay,
): Set<string> {
  const enabled = agentEnabledSet(agent);
  for (const [name, on] of Object.entries(overlay.tool_overrides)) {
    if (on) enabled.add(name);
    else enabled.delete(name);
  }
  return enabled;
}

const inputClass =
  "w-full border border-border rounded-md px-2 py-1.5 text-xs outline-none focus:border-brand bg-bg text-fg placeholder:text-fg-subtle";

export function InjectPanel({
  sessionId,
  agent,
  vaultIds,
}: {
  sessionId: string;
  agent: AgentRecord | null;
  vaultIds?: string[];
}) {
  const { api } = useApi();
  const [overlay, setOverlay] = useState<SessionInjectionOverlay | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [mcpName, setMcpName] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpCredId, setMcpCredId] = useState("");
  const [credHost, setCredHost] = useState("");
  const [credId, setCredId] = useState("");
  const [credentials, setCredentials] = useState<VaultCredential[]>([]);

  const refresh = useCallback(async () => {
    const next = await api<SessionInjectionOverlay>(`/v1/sessions/${sessionId}/injections`);
    setOverlay(next);
  }, [api, sessionId]);

  useEffect(() => {
    setOverlay(null);
    setLoadErr(null);
    refresh().catch((e) => setLoadErr(e instanceof Error ? e.message : String(e)));
  }, [refresh]);

  useEffect(() => {
    if (!vaultIds?.length) {
      setCredentials([]);
      return;
    }
    let cancelled = false;
    Promise.all(
      vaultIds.map((vid) =>
        api<{ data?: VaultCredential[] }>(`/v1/vaults/${vid}/credentials`).catch(() => ({ data: [] })),
      ),
    ).then((pages) => {
      if (cancelled) return;
      const rows: VaultCredential[] = [];
      for (const page of pages) {
        for (const c of page.data ?? []) {
          rows.push({ id: c.id, display_name: c.display_name });
        }
      }
      setCredentials(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [api, vaultIds]);

  const post = async (body: unknown): Promise<boolean> => {
    setSaving(true);
    try {
      await api(`/v1/sessions/${sessionId}/injections`, {
        method: "POST",
        body: JSON.stringify(body),
      });
      await refresh();
      return true;
    } catch (e) {
      if (!(e instanceof ApiError)) {
        toast.error(e instanceof Error ? e.message : "Injection failed");
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const postTools = async (body: { enabled?: string[]; disabled?: string[] }): Promise<boolean> => {
    setSaving(true);
    try {
      await api(`/v1/sessions/${sessionId}/tools`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      await refresh();
      return true;
    } catch (e) {
      if (!(e instanceof ApiError)) {
        toast.error(e instanceof Error ? e.message : "Tool update failed");
      }
      return false;
    } finally {
      setSaving(false);
    }
  };

  const enabled = useMemo(
    () => effectiveEnabled(agent, overlay ?? emptyInjectionOverlay()),
    [agent, overlay],
  );

  if (loadErr) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-fg">Inject</h3>
        <div className="text-xs text-danger">Failed to load: {loadErr}</div>
      </div>
    );
  }

  if (!overlay) {
    return (
      <div className="space-y-2">
        <h3 className="text-sm font-semibold text-fg">Inject</h3>
        <div className="text-xs text-fg-subtle">Loading…</div>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-sm font-semibold text-fg">Inject</h3>
        <p className="text-xs text-fg-subtle mt-1">
          Session-scoped. Prompt and tools apply on the next turn. MCP and credentials apply immediately.
          Tokens never enter the sandbox.
        </p>
      </div>

      <section className="space-y-2">
        <h4 className="text-[10px] uppercase tracking-wide text-fg-subtle font-mono">System prompt</h4>
        <textarea
          className={`${inputClass} min-h-20 resize-y`}
          placeholder="Append a correction the agent will see on the next turn"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          disabled={saving}
        />
        <Button
          size="sm"
          disabled={saving || !prompt.trim()}
          onClick={async () => {
            const text = prompt.trim();
            if (await post({ type: "system_prompt_append", text })) setPrompt("");
          }}
        >
          Append to system prompt
        </Button>
        {overlay.prompt_appends.length === 0 ? (
          <div className="text-xs text-fg-subtle">No prompt appends yet.</div>
        ) : (
          <ul className="space-y-1.5">
            {overlay.prompt_appends.map((p) => (
              <li key={p.id} className="text-xs text-fg-muted border border-border rounded-md px-2 py-1.5">
                <div className="text-[10px] font-mono text-fg-subtle">{p.injected_at}</div>
                <div className="mt-0.5 line-clamp-3 whitespace-pre-wrap">{p.text}</div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-[10px] uppercase tracking-wide text-fg-subtle font-mono">MCP servers</h4>
        <input
          className={inputClass}
          placeholder="name"
          value={mcpName}
          onChange={(e) => setMcpName(e.target.value)}
          disabled={saving}
        />
        <input
          className={inputClass}
          placeholder="https://…"
          value={mcpUrl}
          onChange={(e) => setMcpUrl(e.target.value)}
          disabled={saving}
        />
        {credentials.length > 0 && (
          <select
            className={inputClass}
            value={mcpCredId}
            onChange={(e) => setMcpCredId(e.target.value)}
            disabled={saving}
          >
            <option value="">No credential pin</option>
            {credentials.map((c) => (
              <option key={c.id} value={c.id}>
                {c.display_name} ({c.id})
              </option>
            ))}
          </select>
        )}
        <Button
          size="sm"
          disabled={saving || !mcpName.trim() || !mcpUrl.trim()}
          onClick={async () => {
            if (await post({
              type: "mcp_server_add",
              name: mcpName.trim(),
              url: mcpUrl.trim(),
              ...(mcpCredId ? { credential_id: mcpCredId } : {}),
            })) {
              setMcpName("");
              setMcpUrl("");
              setMcpCredId("");
            }
          }}
        >
          Mount
        </Button>
        {overlay.mcp_servers.length === 0 ? (
          <div className="text-xs text-fg-subtle">No injected MCP servers.</div>
        ) : (
          <ul className="space-y-1">
            {overlay.mcp_servers.map((s) => (
              <li key={s.name} className="text-xs font-mono text-fg-muted">
                {s.name}
                {s.url ? ` · ${s.url}` : ""}
                {s.registry_id ? ` · ${s.registry_id}` : ""}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h4 className="text-[10px] uppercase tracking-wide text-fg-subtle font-mono">Tools</h4>
        <div className="grid grid-cols-2 gap-1">
          {TOGGLE_TOOLS.map((name) => {
            const on = enabled.has(name);
            return (
              <button
                key={name}
                type="button"
                disabled={saving}
                onClick={() =>
                  postTools(on ? { disabled: [name] } : { enabled: [name] })
                }
                className={`text-left text-[11px] font-mono rounded-md px-2 py-1 border transition-colors ${
                  on
                    ? "border-border bg-bg-surface text-fg"
                    : "border-transparent text-fg-subtle hover:bg-bg-surface/60"
                }`}
              >
                {on ? "on" : "off"} · {name}
              </button>
            );
          })}
        </div>
      </section>

      <section className="space-y-2">
        <h4 className="text-[10px] uppercase tracking-wide text-fg-subtle font-mono">Credentials</h4>
        <input
          className={inputClass}
          placeholder="host (api.example.com)"
          value={credHost}
          onChange={(e) => setCredHost(e.target.value)}
          disabled={saving}
        />
        <select
          className={inputClass}
          value={credId}
          onChange={(e) => setCredId(e.target.value)}
          disabled={saving || credentials.length === 0}
        >
          <option value="">
            {credentials.length === 0 ? "No session vault credentials" : "Select credential"}
          </option>
          {credentials.map((c) => (
            <option key={c.id} value={c.id}>
              {c.display_name} ({c.id})
            </option>
          ))}
        </select>
        <Button
          size="sm"
          disabled={saving || !credHost.trim() || !credId}
          onClick={async () => {
            if (await post({
              type: "credential_inject",
              host: credHost.trim(),
              credential_id: credId,
            })) {
              setCredHost("");
              setCredId("");
            }
          }}
        >
          Bind host
        </Button>
        {overlay.credentials.length === 0 ? (
          <div className="text-xs text-fg-subtle">No host bindings.</div>
        ) : (
          <ul className="space-y-1">
            {overlay.credentials.map((c) => (
              <li key={c.host} className="text-xs font-mono text-fg-muted">
                {c.host} → {c.credential_id}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

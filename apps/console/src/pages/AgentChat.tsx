import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { readApiError, useApi } from "../lib/api";
import { useApiQuery } from "../lib/useApiQuery";
import {
  ensureSandboxTabForEnvironment,
  isNoSandboxTabError,
  openSandboxTab,
} from "../lib/sandboxTab";
import { useDefaultEnvironment } from "../lib/useDefaultEnvironment";
import { Select, SelectOption } from "../components/Select";

interface ChatMessage {
  role: "user" | "agent";
  text: string;
}

interface AgentLite {
  id: string;
  runtime_binding?: { runtime_id: string; acp_agent_id: string };
}

export function AgentChat() {
  const { agent_id } = useParams<{ agent_id: string }>();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [streamingText, setStreamingText] = useState("");
  const [pickedEnvId, setPickedEnvId] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  // Set when a turn failed because no browser-vm sandbox tab was paired —
  // renders the inline "open the sandbox tab" prompt below.
  const [needsSandboxTab, setNeedsSandboxTab] = useState(false);
  const lastTextRef = useRef("");
  const api = useApi().api;

  const { data: agent } = useApiQuery<AgentLite>(agent_id ? `/v1/agents/${agent_id}` : null);
  const isLocalRuntime = !!agent?.runtime_binding;
  const {
    environments,
    isLoading: envsLoading,
    singleEnvironmentId,
    hasNoEnvironments,
    needsPicker,
  } = useDefaultEnvironment();

  // The environment to send on session-create, once resolved. Cloud agents
  // with several environments require the user to pick one first (below);
  // a single environment is used silently, matching the backend's
  // `environment_id is required for cloud agents` contract
  // (packages/http-routes/src/sessions/index.ts).
  const resolvedEnvId = isLocalRuntime ? undefined : (singleEnvironmentId ?? (pickedEnvId || undefined));
  const envBlocked = !isLocalRuntime && !resolvedEnvId;

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingText]);

  const sendMessage = async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || !agent_id || loading || envBlocked) return;
    if (!overrideText) {
      setInput("");
      setMessages((prev) => [...prev, { role: "user", text }]);
    }
    lastTextRef.current = text;
    setNeedsSandboxTab(false);
    setLoading(true);
    setStreamingText("");

    // A browser-vm environment executes in a paired browser tab. Open it
    // here, inside the click handler, so the popup blocker allows it — the
    // backend waits ~45s for the tab to come online before failing.
    await ensureSandboxTabForEnvironment(api, resolvedEnvId);

    try {
      let sid = sessionId;
      if (!sid) {
        const body: Record<string, unknown> = { agent: agent_id };
        if (resolvedEnvId) body.environment_id = resolvedEnvId;
        const res = await fetch("/v1/sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const errBody = await res.json().catch(() => ({}));
          throw new Error(readApiError(errBody, res.status).message);
        }
        const session = await res.json();
        sid = session.id;
        setSessionId(sid);
      }

      const controller = new AbortController();
      abortRef.current = controller;

      const res = await fetch(`/v1/sessions/${sid}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: text }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error((err as { error?: string }).error || "Request failed");
      }

      if (res.body) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              const data = line.slice(6).trim();
              if (data === "[DONE]") continue;
              try {
                const parsed = JSON.parse(data) as { type?: string; delta?: string; content?: Array<{ text?: string }> };
                if (parsed.type === "agent.message_chunk" && parsed.delta) {
                  setStreamingText((prev) => prev + parsed.delta);
                } else if (parsed.type === "agent.message" && parsed.content) {
                  const fullText = parsed.content.map((c) => c.text || "").join("");
                  if (isNoSandboxTabError(fullText)) setNeedsSandboxTab(true);
                  setMessages((prev) => [...prev, { role: "agent", text: fullText }]);
                  setStreamingText("");
                }
              } catch {
                // skip unparseable lines
              }
            }
          }
        }
      }

      setStreamingText("");
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        if (isNoSandboxTabError((err as Error).message)) setNeedsSandboxTab(true);
        setMessages((prev) => [...prev, { role: "agent", text: `Error: ${(err as Error).message}` }]);
      }
    }
    setLoading(false);
    abortRef.current = null;
  };

  return (
    <div className="flex flex-col h-screen bg-bg">
      <header className="border-b border-border px-4 py-3">
        <h1 className="font-display text-lg font-semibold text-fg">Chat</h1>
      </header>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {hasNoEnvironments && !isLocalRuntime && (
          <div className="max-w-2xl mx-auto rounded-lg border border-border bg-bg-surface px-4 py-3 text-sm text-fg-muted">
            This agent needs an environment to run sessions, and your tenant has none yet.{" "}
            <a href="/environments" className="text-brand hover:underline">
              Create an environment
            </a>{" "}
            to start chatting.
          </div>
        )}
        {needsPicker && !sessionId && (
          <div className="max-w-2xl mx-auto flex items-center gap-2">
            <span className="text-sm text-fg-muted shrink-0">Environment</span>
            <Select value={pickedEnvId} onValueChange={setPickedEnvId} placeholder="Select environment...">
              {environments.map((e) => (
                <SelectOption key={e.id} value={e.id}>
                  {e.name}
                </SelectOption>
              ))}
            </Select>
          </div>
        )}
        {messages.length === 0 && !loading && (
          <p className="text-sm text-fg-muted text-center mt-8">
            Send a message to start chatting with this agent.
          </p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}>
            <div
              className={`max-w-[80%] rounded-lg px-4 py-2 text-sm ${
                msg.role === "user"
                  ? "bg-brand text-brand-fg"
                  : "bg-bg-surface text-fg border border-border"
              }`}
            >
              {msg.text}
            </div>
          </div>
        ))}
        {needsSandboxTab && (
          <div className="max-w-2xl mx-auto rounded-lg border border-border bg-bg-surface px-4 py-3 text-sm text-fg-muted flex items-center gap-3">
            <span className="flex-1">
              This environment runs its sandbox in a browser tab, and none is connected yet.
            </span>
            <button
              onClick={async () => {
                const opened = await openSandboxTab(api);
                if (!opened) return;
                setNeedsSandboxTab(false);
                // Give the tab a moment to pair + boot its VM; the backend
                // waits for the runtime to come online from there.
                setTimeout(() => { void sendMessage(lastTextRef.current); }, 2000);
              }}
              className="px-3 py-1.5 bg-brand text-brand-fg text-sm font-medium rounded-md hover:bg-brand-hover transition-colors shrink-0"
            >
              Open sandbox tab & retry
            </button>
          </div>
        )}
        {streamingText && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg px-4 py-2 text-sm bg-bg-surface text-fg border border-border">
              {streamingText}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      <div className="border-t border-border px-4 py-3">
        <div className="flex gap-2 max-w-2xl mx-auto">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
            placeholder="Type a message…"
            disabled={loading || envsLoading || envBlocked}
            className="flex-1 border border-border rounded-md px-3 py-2 text-sm bg-bg text-fg outline-none focus:border-brand disabled:opacity-50"
          />
          <button
            onClick={() => sendMessage()}
            disabled={loading || envsLoading || envBlocked || !input.trim()}
            className="px-4 py-2 bg-brand text-brand-fg text-sm font-medium rounded-md hover:bg-brand-hover disabled:opacity-50 transition-colors"
          >
            {loading ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}

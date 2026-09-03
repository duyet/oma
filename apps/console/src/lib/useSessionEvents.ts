import { useEffect, useRef, useState } from "react";

import { useApi } from "./api";
import type { Event } from "./events";

function unwrapEvent(raw: unknown): Event | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const inner =
    rec.data && typeof rec.data === "object"
      ? (rec.data as Event)
      : typeof rec.type === "string"
        ? (rec as Event)
        : null;
  if (!inner) return null;
  return {
    ...inner,
    ts: inner.ts ?? (typeof rec.ts === "string" ? rec.ts : undefined),
    seq: inner.seq ?? (typeof rec.seq === "number" ? rec.seq : undefined),
  };
}

function eventKey(e: Event): string {
  if (typeof e.seq === "number") return `seq:${e.seq}`;
  return `${e.type}:${e.ts ?? ""}:${e.id ?? ""}:${e.tool_use_id ?? ""}`;
}

/**
 * Session event log for Console surfaces that are not SessionDetail.
 * Always hydrates from GET `/events`, then opens SSE when `live` so a
 * quiet stream does not leave the caller stuck on loading. Dedupes by
 * seq so replay overlap does not double-render.
 */
export function useSessionEvents(sessionId: string | null, live: boolean) {
  const { api, streamEvents } = useApi();
  const [events, setEvents] = useState<Event[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const keys = useRef(new Set<string>());

  useEffect(() => {
    keys.current = new Set();
    setEvents([]);
    if (!sessionId) {
      setIsLoading(false);
      return;
    }

    const abort = new AbortController();
    setIsLoading(true);

    const add = (raw: unknown) => {
      const ev = unwrapEvent(raw);
      if (!ev) return;
      const key = eventKey(ev);
      if (keys.current.has(key)) return;
      keys.current.add(key);
      setEvents((prev) => [...prev, ev]);
      setIsLoading(false);
    };

    void (async () => {
      try {
        const res = await api<{
          data: Array<{ seq?: number; type: string; ts?: string; data?: Event }>;
        }>(`/v1/sessions/${sessionId}/events?limit=200&order=asc`, { signal: abort.signal });
        for (const row of res.data ?? []) add(row);
      } catch {
        // api() toasts; leave the empty log.
      } finally {
        if (!abort.signal.aborted) setIsLoading(false);
      }
    })();

    if (live) streamEvents(sessionId, add, abort.signal);

    return () => abort.abort();
  }, [api, live, sessionId, streamEvents]);

  return { events, isLoading };
}

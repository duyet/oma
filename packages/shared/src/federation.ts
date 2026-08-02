// Cross-instance federation (issue #132).
//
// Lets one OMA instance delegate a task to an agent running on ANOTHER OMA
// instance. The building blocks:
//
//   1. A tenant-level registry of remote instances (`fed_*`), stored in KV
//      exactly like the MCP server registry (packages/http-routes/
//      src/mcp-servers.ts). Each row records the remote base URL + an
//      encrypted API key (AES-256-GCM under FEDERATION_CRYPTO_LABEL).
//   2. `resolveFederationInstance` — reads a row, decrypts the key. Used by
//      the delegation executor (Node: directly; CF: via the
//      `env.MAIN_MCP.resolveFederationTarget` RPC, since the agent DO has no
//      KV/secret access).
//   3. A thin HTTP client that drives the remote instance's public REST API:
//      create a session, post a user.message, poll the event log until the
//      remote reaches idle, and return the remote agent's text response.
//
// The client is deliberately transport-simple (create → post → poll) so it is
// trivially unit-testable with a faked `fetch`, and works identically on
// Workers and Node. The remote instance is just another OMA speaking the same
// REST surface — federation is instance-to-instance, authenticated with a
// tenant API key stored on the calling side.

import type { CredentialBlobCrypto } from "./credential-crypto";

/** KV storage row for a registered remote OMA instance. The plaintext
 *  `api_key` never lives here — `api_key_enc` is the AES-GCM ciphertext. */
export interface FederationInstanceRow {
  id: string;
  tenant_id: string;
  name: string;
  base_url: string;
  /** AES-256-GCM ciphertext of the remote API key (base64url iv||ct). */
  api_key_enc?: string;
  description?: string;
  created_at: number;
  updated_at?: number;
}

/** KV key convention — mirrors `mcp_registry:<tenant>:<id>`. */
export const federationKvKey = (tenantId: string, id: string) =>
  `federation:${tenantId}:${id}`;

export const federationKvPrefix = (tenantId: string) => `federation:${tenantId}:`;

/** Minimal KV surface both runtimes' KvStore satisfies. */
export interface FederationKvLike {
  get(key: string): Promise<string | null>;
}

/**
 * Resolve a registered remote instance for a tenant: base URL + decrypted API
 * key. Returns null on miss / malformed row. Never throws on a bad ciphertext
 * — the caller treats a null as "not federated / not resolvable".
 */
export async function resolveFederationInstance(
  kv: FederationKvLike,
  crypto: CredentialBlobCrypto,
  tenantId: string,
  instanceId: string,
): Promise<{ base_url: string; api_key?: string } | null> {
  const raw = await kv.get(federationKvKey(tenantId, instanceId)).catch(() => null);
  if (!raw) return null;
  let row: FederationInstanceRow;
  try {
    row = JSON.parse(raw) as FederationInstanceRow;
  } catch {
    return null;
  }
  if (!row.base_url) return null;
  let api_key: string | undefined;
  if (row.api_key_enc) {
    try {
      api_key = await crypto.decrypt(row.api_key_enc);
    } catch {
      // A key that can't be decrypted (e.g. rotated PLATFORM_ROOT_SECRET) is
      // surfaced as "no key" — the delegation then fails loud at the remote
      // with a 401 rather than silently using stale bytes.
      api_key = undefined;
    }
  }
  return { base_url: row.base_url, api_key };
}

// ── Remote HTTP client ────────────────────────────────────────────────────

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export interface RemoteInstanceTarget {
  base_url: string;
  api_key?: string;
}

// ── SSE transport (M2) ────────────────────────────────────────────────────
//
// The polling transport (M1) only surfaces the remote's events once a poll
// interval elapses, so an origin console animates in 1.5s steps and only
// really "moves" after the turn is done. M2 consumes the remote's
// `/v1/sessions/:id/events/stream` SSE endpoint instead, so each remote event
// reaches the origin's log the moment the remote emits it.
//
// The mirrored event shape is unchanged — both transports feed the same
// `onRemoteEvent(RemoteMirroredEvent)` callback, so the harness's tagging
// (`metadata.remote_instance_id` / `remote_seq`) and the origin's
// read-through-copy durability model are identical either way.

/** A streaming HTTP response, reduced to what the SSE reader needs. */
export interface SseResponseLike {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  /** Body chunks, decoded to strings, in arrival order. */
  chunks(): AsyncIterable<string>;
}

export type SseFetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<SseResponseLike>;

/** Adapt a WHATWG `Response` to `SseResponseLike`. Used by the default
 *  transport; tests inject a fake instead. */
export function sseResponseFrom(res: Response): SseResponseLike {
  return {
    ok: res.ok,
    status: res.status,
    text: () => res.text(),
    chunks: () => readBodyChunks(res.body),
  };
}

async function* readBodyChunks(body: ReadableStream<Uint8Array> | null): AsyncIterable<string> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield decoder.decode(value, { stream: true });
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

const defaultSseFetch: SseFetchLike = async (input, init) =>
  sseResponseFrom(await fetch(input, init as RequestInit));

/**
 * Parse a stream of raw SSE body chunks into JSON-decoded event payloads.
 * Deliberately minimal: we only care about `data:` lines (the origin ignores
 * the `event:`/`id:` lines because the payload itself carries `type` + `seq`),
 * and non-JSON frames (comments, `retry:` preamble) are skipped.
 */
export async function* parseSseEvents(
  chunks: AsyncIterable<string>,
): AsyncIterable<RemoteMirroredEvent> {
  let buffer = "";
  for await (const chunk of chunks) {
    buffer += chunk;
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const data = frame
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        yield JSON.parse(data) as RemoteMirroredEvent;
      } catch {
        /* not a JSON frame — ignore */
      }
    }
  }
}

export interface RemoteDelegateOptions {
  remoteAgentId: string;
  message: string;
  remoteEnvironmentId?: string;
  /** Overall wall-clock budget for the remote turn (create + poll). */
  timeoutMs?: number;
  /** Poll interval while waiting for the remote to reach idle. */
  pollIntervalMs?: number;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: FetchLike;
  /** Injected for tests; defaults to a real setTimeout sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_500;
const DEFAULT_MAX_STREAM_RECONNECTS = 5;

function apiBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function authHeaders(apiKey?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (apiKey) h["x-api-key"] = apiKey;
  return h;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** List the agents available on a remote instance — used by the registry's
 *  connectivity-probe route so an operator can pick a `remote_agent_id`. */
export async function listRemoteAgents(
  target: RemoteInstanceTarget,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
): Promise<Array<{ id: string; name?: string }>> {
  const res = await fetchImpl(`${apiBase(target.base_url)}/agents`, {
    method: "GET",
    headers: authHeaders(target.api_key),
  });
  if (!res.ok) {
    throw new Error(`remote /agents returned ${res.status}`);
  }
  const body = (await res.json()) as { data?: Array<{ id: string; name?: string }> } | unknown;
  const data = (body as { data?: Array<{ id: string; name?: string }> })?.data;
  return Array.isArray(data) ? data : [];
}

/** Extract concatenated text from a remote `agent.message` event's content. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        const block = b as { type?: string; text?: string };
        return block?.type === "text" && typeof block.text === "string" ? block.text : "";
      })
      .filter(Boolean)
      .join("");
  }
  return "";
}

// ── Loop prevention (issue #132 open question) ────────────────────────────
//
// Position taken for v1: **a federated session may not itself be an origin.**
// A → B is allowed; A → B → C is refused at B. Rationale: a hop-count budget
// only bounds cycle *length*, it doesn't stop a cycle from burning a full
// budget of real sandboxes and model tokens on every instance in the ring,
// and there is no shared identity across instances to detect "I've already
// seen this task". Depth 1 is the only bound that is enforceable with purely
// local information, which is all a federated instance has.
//
// Enforcement is origin-side and defence-in-depth:
//   1. The origin refuses to open a *further* remote hop when the session it
//      is running was itself created by federation (its metadata carries
//      `federation.depth >= 1`). See `assertFederationDepthAllowed`.
//   2. Every outbound federated create carries the depth both in the session
//      metadata (`metadata.federation.depth`) and in an
//      `x-oma-federation-depth` request header, so a remote that later grows
//      its own inbound guard can reject the hop without trusting the body.
export const FEDERATION_DEPTH_HEADER = "x-oma-federation-depth";
export const MAX_FEDERATION_DEPTH = 1;

/** Read the federation depth off a session's metadata (0 when absent). */
export function federationDepthOf(metadata: unknown): number {
  const fed = (metadata as { federation?: { depth?: unknown } } | null | undefined)?.federation;
  const depth = fed?.depth;
  return typeof depth === "number" && Number.isFinite(depth) && depth > 0 ? depth : 0;
}

/**
 * Throw when the session described by `metadata` is already a federated
 * session and therefore may not open another hop. Callers surface the throw
 * as a loud session/tool error — never a silent local fallback.
 */
export function assertFederationDepthAllowed(metadata: unknown): void {
  const depth = federationDepthOf(metadata);
  if (depth >= MAX_FEDERATION_DEPTH) {
    throw new Error(
      `federation loop refused: this session is already a federated session (depth ${depth}); ` +
        `an OMA instance may not be both a federation target and a federation origin (max depth ${MAX_FEDERATION_DEPTH})`,
    );
  }
}

/** One event mirrored back from a remote session's event log. */
export interface RemoteMirroredEvent {
  seq?: number;
  type?: string;
  content?: unknown;
  [k: string]: unknown;
}

export interface RemoteTurnOptions extends RemoteDelegateOptions {
  /**
   * Reuse an existing remote session instead of creating a new one — this is
   * what makes a *proxied session* (M1) more than a one-shot delegate: the
   * origin's session id maps 1:1 onto one long-lived remote session, so turn
   * N+1 sees turn N's conversation and `/workspace`.
   */
  remoteSessionId?: string;
  /**
   * Highest remote `seq` this origin session has already mirrored. Only
   * meaningful together with `remoteSessionId`; prevents replaying earlier
   * turns of a reused remote session into the origin log.
   */
  afterSeq?: number;
  /** Depth to stamp on the outbound create (see the loop-prevention note). */
  depth?: number;
  /**
   * Called once per remote event observed while polling, in log order. The
   * proxy harness uses this to mirror the remote's `agent.*` events into the
   * origin's own event log so the origin console renders the turn.
   */
  onRemoteEvent?: (event: RemoteMirroredEvent) => void;
  /**
   * Transport for observing the remote turn (M2).
   *   `"stream"` (default) — consume the remote's SSE `/events/stream`, so
   *      the origin's log lands each remote event as it happens.
   *   `"poll"` — the M1 `GET /events?after_seq=` loop. Kept as the automatic
   *      fallback when a remote doesn't serve SSE, and selectable explicitly.
   */
  transport?: "stream" | "poll";
  /** Injected for tests; defaults to a streaming global-fetch wrapper. */
  streamFetchImpl?: SseFetchLike;
  /** Reconnect budget for a mid-turn stream drop. Each reconnect resumes
   *  from the last seq the origin actually saw. */
  maxStreamReconnects?: number;
  /**
   * Called as soon as the remote session exists (created or reused), before
   * any event is observed. The proxy path persists the binding here so an
   * origin crash mid-turn doesn't orphan the remote session.
   */
  onRemoteSessionBound?: (remoteSessionId: string) => void;
}

/**
 * Create a remote session. Split out of `delegateToRemoteAgent` so the
 * proxy-session path (M1) can create once and reuse across turns.
 */
async function createRemoteSession(
  base: string,
  headers: Record<string, string>,
  fetchImpl: FetchLike,
  opts: RemoteTurnOptions,
  origin: string,
): Promise<string> {
  const depth = (opts.depth ?? 0) + 1;
  const createRes = await fetchImpl(`${base}/sessions`, {
    method: "POST",
    headers: { ...headers, [FEDERATION_DEPTH_HEADER]: String(depth) },
    body: JSON.stringify({
      agent: opts.remoteAgentId,
      ...(opts.remoteEnvironmentId ? { environment_id: opts.remoteEnvironmentId } : {}),
      metadata: { federation: { origin, depth } },
    }),
  });
  if (!createRes.ok) {
    throw new Error(
      `remote session create failed (${createRes.status}): ${(await createRes.text()).slice(0, 300)}`,
    );
  }
  const created = (await createRes.json()) as { id?: string };
  if (!created?.id) {
    throw new Error("remote session create returned no id");
  }
  return created.id;
}

/**
 * Run one turn against a remote OMA session: (optionally create the session),
 * post the user message, and poll the remote event log to idle, mirroring
 * every observed event through `onRemoteEvent`.
 *
 * Shared by the one-shot `call_remote_agent_*` delegate (M4) and the
 * `oma-remote` proxied-session harness (M1) so there is exactly one
 * implementation of the create → post → poll protocol.
 */
export async function runRemoteTurn(
  target: RemoteInstanceTarget,
  opts: RemoteTurnOptions,
  origin: string,
): Promise<{ text: string; remote_session_id: string; last_seq: number }> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const sleep = opts.sleep ?? defaultSleep;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const base = apiBase(target.base_url);
  const headers = authHeaders(target.api_key);
  const deadline = Date.now() + timeoutMs;

  // 1. Create the remote session (or reuse the one this origin session is
  //    already bound to).
  const remoteSessionId =
    opts.remoteSessionId ?? (await createRemoteSession(base, headers, fetchImpl, opts, origin));
  opts.onRemoteSessionBound?.(remoteSessionId);

  // 2. Post the user message.
  const postRes = await fetchImpl(`${base}/sessions/${remoteSessionId}/events`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      events: [{ type: "user.message", content: [{ type: "text", text: opts.message }] }],
    }),
  });
  if (!postRes.ok) {
    throw new Error(
      `remote message post failed (${postRes.status}): ${(await postRes.text()).slice(0, 300)}`,
    );
  }

  // 3. Observe the remote turn to idle. Both transports share one consumer
  //    (`consume`) so mirroring, text collection, seq tracking, and the
  //    fail-loud rules can't drift apart between them.
  //
  //    Seq tracking is what makes a mid-turn stream drop safe: every event we
  //    hand to `onRemoteEvent` advances `afterSeq` first, so a reconnect asks
  //    the remote to resume strictly *after* the last event the origin
  //    actually mirrored — no gap, no duplicate. On a reused session we start
  //    from the seq the caller last saw so earlier turns aren't replayed.
  let afterSeq = opts.remoteSessionId ? (opts.afterSeq ?? 0) : 0;
  const texts: string[] = [];

  /** Feed one remote event through the mirror. Returns true at idle. */
  const consume = (ev: RemoteMirroredEvent): boolean => {
    if (typeof ev.seq === "number") {
      if (ev.seq <= afterSeq) return false; // already mirrored (replay/resume overlap)
      afterSeq = ev.seq;
    }
    opts.onRemoteEvent?.(ev);
    if (ev.type === "agent.message") {
      const t = extractText(ev.content);
      if (t) texts.push(t);
    } else if (ev.type === "session.error") {
      const msg = extractText(ev.content) || "remote session.error";
      throw new Error(`remote agent error: ${msg.slice(0, 300)}`);
    } else if (ev.type === "session.status_idle") {
      return true;
    }
    return false;
  };

  const expired = () => Date.now() > deadline;
  const timedOut = () =>
    new Error(`remote agent timed out after ${timeoutMs}ms (session ${remoteSessionId})`);

  const poll = async (): Promise<void> => {
    for (;;) {
      if (expired()) throw timedOut();
      await sleep(pollIntervalMs);
      const evRes = await fetchImpl(
        `${base}/sessions/${remoteSessionId}/events?after_seq=${afterSeq}&order=asc`,
        { method: "GET", headers },
      );
      if (!evRes.ok) {
        throw new Error(`remote events poll failed (${evRes.status})`);
      }
      const page = (await evRes.json()) as { data?: RemoteMirroredEvent[] };
      const events = Array.isArray(page.data) ? page.data : [];
      for (const ev of events) {
        if (consume(ev)) return;
      }
    }
  };

  if ((opts.transport ?? "stream") === "poll") {
    await poll();
  } else {
    const sseFetch = opts.streamFetchImpl ?? defaultSseFetch;
    const maxReconnects = opts.maxStreamReconnects ?? DEFAULT_MAX_STREAM_RECONNECTS;
    let reconnects = 0;
    for (;;) {
      if (expired()) throw timedOut();
      // `replay=1` + Last-Event-ID makes the remote resume from our last seen
      // seq; `include=chunks` admits OMA extension events (agent.status) so
      // the streamed mirror covers the same set the poll transport did.
      const res = await sseFetch(
        `${base}/sessions/${remoteSessionId}/events/stream?include=chunks&replay=1`,
        { method: "GET", headers: { ...headers, "Last-Event-ID": String(afterSeq) } },
      );
      if (!res.ok) {
        // A remote without the SSE surface (or blocking it) is not a reason to
        // fail the turn — fall back to the M1 poll transport on the SAME
        // remote. This is never a fall back to a *local* run.
        if (reconnects === 0) {
          await poll();
          break;
        }
        throw new Error(`remote events stream failed (${res.status})`);
      }
      let reachedIdle = false;
      for await (const ev of parseSseEvents(res.chunks())) {
        if (consume(ev)) {
          reachedIdle = true;
          break;
        }
      }
      if (reachedIdle) break;
      // Stream ended before idle: the remote closed, a proxy timed out, or the
      // connection dropped. Reconnect from `afterSeq` within the budget.
      if (++reconnects > maxReconnects) {
        throw new Error(
          `remote events stream dropped ${reconnects - 1} times before idle (session ${remoteSessionId})`,
        );
      }
      await sleep(pollIntervalMs);
    }
  }

  return { text: texts.join("\n\n"), remote_session_id: remoteSessionId, last_seq: afterSeq };
}

/**
 * Delegate a single task to an agent on a remote OMA instance and return its
 * text response. Creates a fresh remote session, posts the message, and polls
 * the remote event log until it reaches `session.status_idle` (or the timeout
 * elapses). Throws on any transport / remote error so the caller can surface
 * it as a tool error / `success: false`.
 */
export async function delegateToRemoteAgent(
  target: RemoteInstanceTarget,
  opts: RemoteDelegateOptions,
): Promise<{ text: string; remote_session_id: string }> {
  // Poll transport on purpose: a one-shot delegate mirrors nothing into the
  // caller's event log (only the final text is returned to the tool), so a
  // live SSE connection would buy no interactivity and only add a long-lived
  // socket per in-flight sub-agent call. The proxied-session path (M2) is the
  // one that streams.
  return runRemoteTurn(target, { transport: "poll", ...opts }, "callable_agent");
}

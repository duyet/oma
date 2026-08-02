/**
 * Unified listing across federated instances (issue #132 M3).
 *
 * `GET /v1/sessions` and `GET /v1/agents` can optionally fan out to every
 * remote instance registered for the tenant and merge the results into one
 * page, each remote row badged with `remote_instance_id`.
 *
 * Three rules shape the design:
 *
 *  1. **Opt-in, never the default.** Fan-out is requested with
 *     `?include_remotes=1` (optionally narrowed by
 *     `?remote_instance_ids=fed_a,fed_b`). Making every list call hit every
 *     remote would turn a local D1 read into an N-way network fan-out — a
 *     latency regression and a failure surface on the most-hit route there is.
 *
 *  2. **Degrade, never fail.** A slow or dead remote must not 500 the
 *     listing. Each remote gets its own timeout; failures come back as
 *     `remote_errors[]` markers alongside whatever partial data did arrive.
 *
 *  3. **One ordering contract.** Every source lists `(created_at, id) DESC`
 *     and speaks the same opaque cursor codec (packages/shared/src/
 *     pagination.ts), so the same cursor can be handed to every source and
 *     the merged page is a plain k-way merge of already-sorted streams. The
 *     next cursor is the last merged row's `(created_at, id)` — which every
 *     source will honour on the following call.
 *
 * Credential boundary: the remote API key is decrypted here, used as an
 * outbound `x-api-key` header, and never written to the response, an error
 * marker, or a log line. Errors are stringified from the transport message
 * only — never from the request headers.
 */

import {
  encodeCursor,
  federationKvPrefix,
  resolveFederationInstance,
  type CredentialBlobCrypto,
  type FederationInstanceRow,
} from "@duyet/oma-shared";

/** Per-remote failure marker returned alongside partial results. */
export interface RemoteListError {
  instance_id: string;
  name?: string;
  error: string;
}

/** A listed row, badged with its source when it came from a remote. */
export type FederatedRow = Record<string, unknown> & {
  id?: string;
  created_at?: string;
  remote_instance_id?: string;
};

export interface FanOutKvLike {
  get(key: string): Promise<string | null>;
  list(opts: { prefix: string; cursor?: string }): Promise<{
    keys: Array<{ name: string }>;
    list_complete: boolean;
    cursor?: string;
  }>;
}

export type FanOutFetch = (
  input: string,
  init?: { method?: string; headers?: Record<string, string> },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface FanOutOptions {
  kv: FanOutKvLike;
  crypto?: CredentialBlobCrypto;
  tenantId: string;
  /** `"sessions"` | `"agents"` — the remote path segment under /v1. */
  resource: string;
  /** Query string forwarded verbatim to each remote (filters + cursor +
   *  limit), minus the fan-out control params. */
  search: URLSearchParams;
  /** Restrict the fan-out to these instance ids. Empty/absent = all. */
  instanceIds?: string[];
  /** Per-remote wall-clock budget. A remote past it is an error marker. */
  timeoutMs?: number;
  fetchImpl?: FanOutFetch;
}

const DEFAULT_REMOTE_TIMEOUT_MS = 5_000;

/** Crypto dep as the list routes accept it — a value or a per-request
 *  resolver, matching the federation registry routes' `crypto` dep. */
export type FederationCryptoDep =
  | CredentialBlobCrypto
  | ((c: import("hono").Context) => CredentialBlobCrypto | undefined);

export function resolveFederationCrypto(
  dep: FederationCryptoDep | undefined,
  c: import("hono").Context,
): CredentialBlobCrypto | undefined {
  return typeof dep === "function" ? dep(c) : dep;
}

/** Control params consumed here, never forwarded to the remote (forwarding
 *  `include_remotes` would ask the remote to fan out in turn — a multi-hop
 *  path the depth-1 federation model deliberately forbids). */
const CONTROL_PARAMS = ["include_remotes", "remote_instance_ids"];

/** True when the caller opted into fan-out. Absent/`0`/`false` ⇒ off. */
export function wantsRemoteFanOut(raw: string | undefined): boolean {
  return raw === "1" || raw === "true";
}

export function parseInstanceIds(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const ids = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return ids.length ? ids : undefined;
}

/** Strip the fan-out control params from a request's query. */
export function forwardableSearch(url: string): URLSearchParams {
  const search = new URLSearchParams(new URL(url).search);
  for (const p of CONTROL_PARAMS) search.delete(p);
  return search;
}

/**
 * Route-level entry point: given the local page a list route just built,
 * decide whether fan-out was requested and, if so, merge the remotes in.
 * Returns the response body fields the route should spread.
 *
 * Off by default — with no `?include_remotes=1` this is a pure passthrough
 * of the local page and performs no network I/O at all.
 */
export async function federatedListBody(
  c: import("hono").Context,
  opts: {
    kv: FanOutKvLike;
    crypto?: FederationCryptoDep;
    tenantId: string;
    resource: string;
    limit: number;
    localItems: FederatedRow[];
    localNextCursor?: string;
    fetchImpl?: FanOutFetch;
    timeoutMs?: number;
  },
): Promise<{
  data: FederatedRow[];
  next_cursor?: string;
  remote_errors?: RemoteListError[];
}> {
  if (!wantsRemoteFanOut(c.req.query("include_remotes"))) {
    return {
      data: opts.localItems,
      ...(opts.localNextCursor ? { next_cursor: opts.localNextCursor } : {}),
    };
  }
  const { pages, errors } = await fanOutRemoteList({
    kv: opts.kv,
    crypto: resolveFederationCrypto(opts.crypto, c),
    tenantId: opts.tenantId,
    resource: opts.resource,
    search: forwardableSearch(c.req.url),
    instanceIds: parseInstanceIds(c.req.query("remote_instance_ids")),
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  });
  const merged = mergeFederatedPages(
    [opts.localItems, ...pages],
    opts.limit,
    Boolean(opts.localNextCursor),
  );
  return {
    data: merged.items,
    ...(merged.nextCursor ? { next_cursor: merged.nextCursor } : {}),
    ...(errors.length ? { remote_errors: errors } : {}),
  };
}

async function listInstanceRows(
  kv: FanOutKvLike,
  tenantId: string,
): Promise<FederationInstanceRow[]> {
  const prefix = federationKvPrefix(tenantId);
  const rows: FederationInstanceRow[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const k of page.keys) {
      const raw = await kv.get(k.name);
      if (!raw) continue;
      try {
        rows.push(JSON.parse(raw) as FederationInstanceRow);
      } catch {
        // Skip malformed rows rather than failing the whole listing.
      }
    }
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return rows;
}

function apiBase(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? trimmed : `${trimmed}/v1`;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** Sort key for the `(created_at, id) DESC` contract. Non-parseable
 *  timestamps fall back to string compare so a row is never dropped. */
function compareDesc(a: FederatedRow, b: FederatedRow): number {
  const at = Date.parse(String(a.created_at ?? ""));
  const bt = Date.parse(String(b.created_at ?? ""));
  if (Number.isFinite(at) && Number.isFinite(bt) && at !== bt) return bt - at;
  if (!Number.isFinite(at) || !Number.isFinite(bt)) {
    const s = String(b.created_at ?? "").localeCompare(String(a.created_at ?? ""));
    if (s !== 0) return s;
  }
  return String(b.id ?? "").localeCompare(String(a.id ?? ""));
}

/**
 * Merge already-`(created_at, id) DESC`-sorted sources into one page of
 * `limit` rows, and derive the next cursor from the last row kept (only when
 * something was actually left over — an exhausted merge has no next page).
 */
export function mergeFederatedPages(
  sources: FederatedRow[][],
  limit: number,
  /** True when a source reported more rows past the page it returned, even
   *  if the merge itself wasn't truncated. */
  hasMoreHint = false,
): { items: FederatedRow[]; nextCursor?: string } {
  const all = sources.flat().sort(compareDesc);
  const items = all.slice(0, limit);
  if ((all.length <= limit && !hasMoreHint) || items.length === 0) return { items };
  const last = items[items.length - 1];
  const createdAt = Date.parse(String(last.created_at ?? ""));
  if (!Number.isFinite(createdAt) || typeof last.id !== "string") return { items };
  return { items, nextCursor: encodeCursor({ createdAt, id: last.id }) };
}

/**
 * Fetch one page of `resource` from every selected remote instance, in
 * parallel, badging each row with its source. Never throws: a remote that
 * fails (unresolvable, unreachable, non-2xx, slow) becomes an entry in
 * `errors` and contributes no rows.
 */
export async function fanOutRemoteList(
  opts: FanOutOptions,
): Promise<{ pages: FederatedRow[][]; errors: RemoteListError[] }> {
  const fetchImpl = opts.fetchImpl ?? (fetch as unknown as FanOutFetch);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REMOTE_TIMEOUT_MS;
  const wanted = opts.instanceIds && new Set(opts.instanceIds);
  const rows = (await listInstanceRows(opts.kv, opts.tenantId)).filter(
    (r) => !wanted || wanted.has(r.id),
  );
  if (!rows.length) return { pages: [], errors: [] };
  if (!opts.crypto) {
    return {
      pages: [],
      errors: rows.map((r) => ({
        instance_id: r.id,
        name: r.name,
        error: "federation crypto unavailable on this deployment",
      })),
    };
  }
  const crypto = opts.crypto;
  const qs = opts.search.toString();

  const pages: FederatedRow[][] = [];
  const errors: RemoteListError[] = [];
  await Promise.all(
    rows.map(async (row) => {
      try {
        const target = await resolveFederationInstance(opts.kv, crypto, opts.tenantId, row.id);
        if (!target) throw new Error("instance could not be resolved");
        const url = `${apiBase(target.base_url)}/${opts.resource}${qs ? `?${qs}` : ""}`;
        const res = await withTimeout(
          fetchImpl(url, {
            method: "GET",
            headers: {
              "content-type": "application/json",
              ...(target.api_key ? { "x-api-key": target.api_key } : {}),
            },
          }),
          timeoutMs,
          `remote ${opts.resource} listing`,
        );
        if (!res.ok) throw new Error(`remote returned ${res.status}`);
        const body = (await res.json()) as { data?: FederatedRow[] };
        const data = Array.isArray(body?.data) ? body.data : [];
        pages.push(
          data.map((item) => ({
            ...item,
            remote_instance_id: row.id,
            remote_instance_name: row.name,
          })),
        );
      } catch (e) {
        // Degrade, never fail the listing. The message is the transport's
        // own — it never carries the api key, which only ever lived in the
        // request headers above.
        errors.push({
          instance_id: row.id,
          name: row.name,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }),
  );
  return { pages, errors };
}

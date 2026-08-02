// @ts-nocheck
//
// Wire-compatibility test for the AMA Files API surface: does
// `client.beta.files.*` from the real `@anthropic-ai/sdk` (v0.95.1, the
// version pinned in this repo) work against OMA's `/v1/files` mount on the
// main worker?
//
// Why this exists: AMA SDK `client.beta.files.upload()` posts a multipart
// upload to POST /v1/files?beta=true with header `anthropic-beta:
// files-api-2025-04-14` and expects an Anthropic `FileMetadata` response
// shape — `{ id, created_at, filename, mime_type, size_bytes, type:'file',
// downloadable?, scope?: {id, type:'session'} }`. OMA previously returned the
// OMA-native shape (`media_type`, `scope_id`), so SDK callers got
// `mime_type === undefined` and a non-downloadable file. This test pins the
// wire contract end-to-end with the real SDK parser (same strategy as
// ama-sdk-threads.test.ts, but aimed at the main worker's `/v1/files` mount
// rather than SESSION_DO).
//
// How: the SDK's custom `fetch` forwards every request to the worker export
// (`exports.default.fetch`), adding nothing but the `x-api-key: test-key` the
// SDK derives from its `apiKey` option. The SDK builds `/v1/files?...?beta=...`
// paths + `anthropic-beta` headers verbatim — that's the shape under test.

import { env, exports } from "cloudflare:workers";
import { describe, it, expect, beforeAll } from "vitest";
import Anthropic, { NotFoundError } from "@anthropic-ai/sdk";

// Magic test key the CF worker fixture trusts (see vitest.config.ts API_KEY).
const TEST_KEY = "test-key";

/**
 * An Anthropic client whose `fetch` is a straight pipe to the main worker
 * export. The SDK attaches `x-api-key` from `apiKey`, so auth flows through
 * authMiddleware exactly as a real caller.
 */
function buildSdk(): Anthropic {
  const customFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const req = new Request(input, init);
    // The SDK already set `x-api-key: TEST_KEY`; just forward to the worker.
    return exports.default.fetch(req);
  };
  return new Anthropic({
    apiKey: TEST_KEY,
    baseURL: "http://localhost",
    fetch: customFetch as unknown as typeof fetch,
    maxRetries: 0,
  });
}

describe("AMA SDK ↔ /v1/files wire compatibility", () => {
  const client = buildSdk();

  it("upload returns an Anthropic FileMetadata (mime_type + scope + downloadable)", async () => {
    const file = new File(["hello artifacts"], "report.md", {
      type: "text/markdown",
    });
    const meta = await client.beta.files.upload({ file });

    // Anthropic FileMetadata contract.
    expect(meta.id).toMatch(/^file-/);
    expect(meta.type).toBe("file");
    expect(meta.filename).toBe("report.md");
    expect(meta.mime_type).toBe("text/markdown"); // the field OMA used to miss
    expect(meta.size_bytes).toBe(Buffer.byteLength("hello artifacts"));
    expect(meta.created_at).toBeTruthy();
    // AMA uploads are artifacts → downloadable so the SDK can round-trip them.
    expect(meta.downloadable).toBe(true);
    // Tenant-scoped upload (SDK sends no scope) → scope is null per AMA spec.
    expect(meta.scope).toBeNull();
    // OMA-native aliases still ride along for legacy clients.
    expect(meta.media_type).toBe("text/markdown");
    expect(meta.scope_id).toBeUndefined();
  });

  it("retrieveMetadata returns the same FileMetadata shape", async () => {
    const uploaded = await client.beta.files.upload({
      file: new File(["x"], "blob.bin", { type: "application/octet-stream" }),
    });
    const meta = await client.beta.files.retrieveMetadata(uploaded.id);
    expect(meta.id).toBe(uploaded.id);
    expect(meta.mime_type).toBe("application/octet-stream");
    expect(meta.scope).toBeNull();
    expect(meta.downloadable).toBe(true);
  });

  it("retrieveMetadata('unknown') throws NotFoundError", async () => {
    await expect(client.beta.files.retrieveMetadata("file_does_not_exist")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("list returns a page whose items carry the FileMetadata shape", async () => {
    // Seed a couple of AMA uploads.
    await client.beta.files.upload({ file: new File(["a"], "a.txt") });
    await client.beta.files.upload({ file: new File(["b"], "b.json", { type: "application/json" }) });

    const page = await client.beta.files.list();
    expect(Array.isArray(page.data)).toBe(true);
    expect(page.data.length).toBeGreaterThanOrEqual(1);
    const json = page.data[0] as any;
    expect(json.type).toBe("file");
    expect(json.mime_type).toBeTruthy(); // alias present on every listed item
    expect(json.scope).not.toBeUndefined(); // object form, not missing
  });

  it("next_page is a real continuation token that walks every page and ends", async () => {
    // Fixture: enough files that limit=2 forces >1 page.
    const seeded: string[] = [];
    for (let i = 0; i < 5; i++) {
      const up = await client.beta.files.upload({
        file: new File([`p${i}`], `page-${i}.txt`, { type: "text/plain" }),
      });
      seeded.push(up.id);
    }

    // Walk purely by `next_page` — the token the SDK's TokenPage/PageCursor
    // families replay. A hardcoded `next_page: null` stops this loop after
    // page 1, so `pages` would be 1 and the seeded ids would not all appear.
    const seen: string[] = [];
    let token: string | null = null;
    let pages = 0;
    do {
      const qs = new URLSearchParams({ beta: "true", limit: "2" });
      if (token) qs.set("page_token", token);
      const res = await exports.default.fetch(
        new Request(`http://localhost/v1/files?${qs}`, {
          headers: { "x-api-key": TEST_KEY },
        }),
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        data: Array<{ id: string }>;
        has_more: boolean;
        next_page: string | null;
      };
      pages++;
      expect(body.data.length).toBeLessThanOrEqual(2);
      seen.push(...body.data.map((f) => f.id));
      // `next_page` and `has_more` must agree — both derive from the same
      // over-fetch, and the SDK gates on `has_more` before reading the token.
      expect(body.has_more).toBe(body.next_page !== null);
      token = body.next_page;
      expect(pages).toBeLessThan(50); // termination guard
    } while (token);

    expect(pages).toBeGreaterThan(1); // fails if next_page is hardcoded null
    expect(new Set(seen).size).toBe(seen.length); // no row served twice
    for (const id of seeded) expect(seen).toContain(id);
  });

  it("SDK auto-pagination traverses more than one page and terminates", async () => {
    for (let i = 0; i < 4; i++) {
      await client.beta.files.upload({
        file: new File([`s${i}`], `sdk-${i}.txt`, { type: "text/plain" }),
      });
    }
    // The beta files pager is id-based (`last_id` → `after_id`); this pins
    // that the route honors that walk too, over the same seek position the
    // `next_page` token encodes.
    const ids: string[] = [];
    for await (const meta of client.beta.files.list({ limit: 2 })) {
      ids.push(meta.id);
      if (ids.length > 200) break; // guard against a non-terminating pager
    }
    expect(ids.length).toBeGreaterThan(2);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("download returns the original bytes of an uploaded artifact", async () => {
    const uploaded = await client.beta.files.upload({
      file: new File(["artifact-bytes"], "a.bin", { type: "application/octet-stream" }),
    });
    const response = await client.beta.files.download(uploaded.id);
    expect(response.status).toBe(200);
    const blob = await response.blob();
    expect(blob.size).toBe("artifact-bytes".length);
    expect(await blob.text()).toBe("artifact-bytes");
  });

  it("delete returns the file_deleted envelope", async () => {
    const uploaded = await client.beta.files.upload({
      file: new File(["temp"], "temp.txt"),
    });
    const deleted = await client.beta.files.delete(uploaded.id);
    expect(deleted.id).toBe(uploaded.id);
    expect(deleted.type).toBe("file_deleted");

    // Subsequent retrieve is 404 → NotFoundError.
    await expect(client.beta.files.retrieveMetadata(uploaded.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("delete('unknown') throws NotFoundError", async () => {
    await expect(client.beta.files.delete("file_does_not_exist")).rejects.toBeInstanceOf(NotFoundError);
  });
});

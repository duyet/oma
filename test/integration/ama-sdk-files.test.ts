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

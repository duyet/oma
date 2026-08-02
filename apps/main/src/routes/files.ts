import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "@duyet/oma-shared";
import { generateFileId, fileR2Key, sessionOutputsPrefix } from "@duyet/oma-shared";
import { toFileRecord, FileNotFoundError } from "@duyet/oma-files-store";
import type { Services } from "@duyet/oma-services";
import { checkUploadFreq, checkUploadSize } from "../quotas";
import { parseBetaHeader } from "../lib/beta-header";

interface FilesHonoEnv {
  Bindings: Env;
  Variables: { tenant_id: string; services: Services };
}

const app = new Hono<FilesHonoEnv>();

/**
 * AMA Files API beta flag. `client.beta.files.upload()` from
 * `@anthropic-ai/sdk` sends `anthropic-beta: files-api-2025-04-14` (plus the
 * `?beta=true` query). When present (or `?beta=true`), OMA treats the upload
 * as an artifact-producing call: the file is stored `downloadable: true` so
 * the same AMA caller can round-trip it via `client.beta.files.download()`,
 * and the response is shaped as Anthropic's `FileMetadata` (`mime_type` /
 * `scope` object) alongside the OMA-native `media_type` / `scope_id`.
 */
export const FILES_API_BETA = "files-api-2025-04-14";

function isAmaFilesRequest(c: Context<FilesHonoEnv>): boolean {
  return parseBetaHeader(c).has(FILES_API_BETA) || c.req.query("beta") === "true";
}


// ─── Session-outputs synthesis ──────────────────────────────────────
//
// Files the agent writes to /mnt/session/outputs/ inside the sandbox land
// in R2 under `t/<tenant>/session-outputs/<session>/<filename>` with no
// D1 row (the mount is bytes-only — listing scans the R2 prefix directly).
// To make these reachable through the standard AMA Files API, we synthesize
// file rows on the fly:
//
//   - LIST /v1/files?scope_id=<sessionId> includes both real D1-backed
//     files AND R2 objects under the session-outputs prefix.
//   - GET /v1/files/:id and /content recognize ids matching `out:<sessionId>:
//     <base64url(filename)>` and read R2 directly with no D1 round-trip.
//
// Wire id format is opaque to the SDK; format is stable and self-describing
// so we never need a backing index. base64url encoding so filenames with
// special chars (spaces, slashes — though slashes shouldn't reach here)
// don't break URL routing.

function encodeOutputId(sessionId: string, filename: string): string {
  // base64url; strip padding so the id stays URL-friendly
  const b64 = btoa(filename).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `out:${sessionId}:${b64}`;
}

function decodeOutputId(
  id: string,
): { sessionId: string; filename: string } | null {
  if (!id.startsWith("out:")) return null;
  const rest = id.slice(4);
  const sep = rest.indexOf(":");
  if (sep < 0) return null;
  const sessionId = rest.slice(0, sep);
  const b64 = rest.slice(sep + 1);
  try {
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/")
      + "===".slice((b64.length + 3) % 4);
    return { sessionId, filename: atob(padded) };
  } catch {
    return null;
  }
}

const OUTPUT_MIME_GUESS: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
  gif: "image/gif", webp: "image/webp", txt: "text/plain", md: "text/markdown",
  csv: "text/csv", json: "application/json", html: "text/html", htm: "text/html",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  zip: "application/zip", tar: "application/x-tar", gz: "application/gzip",
};

function guessOutputMime(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() || "";
  return OUTPUT_MIME_GUESS[ext] || "application/octet-stream";
}

interface ApiFileRecord {
  id: string;
  type: "file";
  filename: string;
  media_type: string;
  /** Anthropic SDK alias of `media_type` (`FileMetadata.mime_type`). */
  mime_type?: string;
  size_bytes: number;
  created_at: string;
  /** OMA-native scoping session id (when the file is session-scoped). */
  scope_id?: string;
  /** Anthropic SDK alias of `scope_id` (object form). */
  scope?: { type: "session"; id: string } | null;
  downloadable?: boolean;
}

async function listSessionOutputAsFiles(
  bucket: R2Bucket,
  tenantId: string,
  sessionId: string,
): Promise<ApiFileRecord[]> {
  const prefix = sessionOutputsPrefix(tenantId, sessionId);
  const list = await bucket.list({ prefix, limit: 1000 });
  return list.objects.map((o: R2Object) => {
    const filename = o.key.slice(prefix.length);
    const mediaType = o.httpMetadata?.contentType || guessOutputMime(filename);
    return {
      id: encodeOutputId(sessionId, filename),
      type: "file" as const,
      filename,
      media_type: mediaType,
      mime_type: mediaType,
      size_bytes: o.size,
      created_at: o.uploaded.toISOString(),
      scope_id: sessionId,
      scope: { type: "session" as const, id: sessionId },
      downloadable: true,
    };
  });
}

// POST /v1/files — upload file (multipart form or JSON body)
app.post("/", async (c) => {
  const t = c.get("tenant_id");
  // Cheap upfront rejects so a flood of oversized / over-frequent uploads
  // doesn't even read the body. Both gates soft-pass when unconfigured.
  const sizeCheck = checkUploadSize(c.env, c.req.raw);
  if (sizeCheck) return sizeCheck;
  const freqCheck = await checkUploadFreq(c.env, t);
  if (freqCheck) return freqCheck;

  const bucket = c.var.services.filesBlob;
  if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  let filename: string;
  let mediaType: string;
  let body: ArrayBuffer;
  let scopeId: string | undefined;
  // AMA files are uploaded via `client.beta.files.upload()` (or
  // `?beta=true`) and are meant to be retrieved again as artifacts, so mark
  // them downloadable. Non-AMA (e.g. Console) uploads keep OMA's default of
  // opaque, non-downloadable input files unless the caller opts in.
  let downloadable = isAmaFilesRequest(c);

  const contentType = c.req.header("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file") as File | null;
    if (!file) {
      return c.json({ error: "file field is required in multipart upload" }, 400);
    }
    filename = file.name;
    mediaType = file.type || "application/octet-stream";
    body = await file.arrayBuffer();
    const sc = formData.get("scope_id");
    if (typeof sc === "string") scopeId = sc;
    const d = formData.get("downloadable");
    if (typeof d === "string") downloadable = d === "true" || d === "1";
  } else {
    // JSON body upload — content is base64-encoded for binary, raw text for text/*
    const json = await c.req.json<{
      filename: string;
      content: string;
      media_type?: string;
      scope_id?: string;
      encoding?: "base64" | "utf8";
      downloadable?: boolean;
    }>();

    if (!json.filename || json.content === undefined || json.content === null) {
      return c.json({ error: "filename and content are required" }, 400);
    }
    filename = json.filename;
    mediaType = json.media_type || "application/octet-stream";
    scopeId = json.scope_id;
    downloadable = json.downloadable === true;

    const encoding = json.encoding || (mediaType.startsWith("text/") ? "utf8" : "base64");
    if (encoding === "base64") {
      const bin = atob(json.content);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      body = bytes.buffer;
    } else {
      body = new TextEncoder().encode(json.content).buffer as ArrayBuffer;
    }
  }

  const id = generateFileId();
  const r2Key = fileR2Key(t, id);
  // R2 PUT first, then metadata insert — same failure semantics as the KV era
  // (orphan R2 object on metadata failure, never the reverse).
  await bucket.put(r2Key, body, { httpMetadata: { contentType: mediaType } });

  const row = await c.var.services.files.create({
    id,
    tenantId: t,
    sessionId: scopeId,
    filename,
    mediaType,
    sizeBytes: body.byteLength,
    r2Key,
    downloadable,
  });

  return c.json(toFileRecord(row), 201);
});

// GET /v1/files — list files (cursor-paginated, optional scope_id filter)
app.get("/", async (c) => {
  const t = c.get("tenant_id");
  const scopeId = c.req.query("scope_id");
  const limitParam = c.req.query("limit");
  const beforeId = c.req.query("before_id"); // returns files with id < before_id
  const afterId = c.req.query("after_id");   // returns files with id > after_id
  const order = c.req.query("order") === "asc" ? "asc" : "desc";
  // Continuation token echoed back from a previous response's `next_page`.
  // Anthropic's SDK spells the param `page_token` on its token pager and
  // `page` on its cursor pager; the beta files pager is id-based and sends
  // neither, so we accept both spellings rather than guess one.
  const pageToken = c.req.query("page_token") ?? c.req.query("page") ?? undefined;

  let requested = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(requested) || requested < 1) requested = 100;
  if (requested > 1000) requested = 1000;

  const page = await c.var.services.files.listPage({
    tenantId: t,
    sessionId: scopeId,
    cursor: pageToken,
    beforeId,
    afterId,
    order,
    limit: requested,
  });

  const data: ApiFileRecord[] = page.items.map(toFileRecord) as ApiFileRecord[];
  let hasMore = page.nextCursor !== undefined;
  let nextPage: string | null = page.nextCursor ?? null;

  // When the caller scopes to a session, also list the R2 session-outputs
  // prefix and fold those in as synthesized rows. They live outside the D1
  // cursor (unifying the two would need a cursor spanning D1 + R2), so they
  // ride along on the FIRST page only — otherwise every subsequent page would
  // repeat them. For typical usage — list session artifacts after the agent
  // finishes — that is still everything in one page.
  const firstPage = !pageToken && !afterId && !beforeId;
  if (scopeId && firstPage && c.env.FILES_BUCKET) {
    const synthesized = await listSessionOutputAsFiles(
      c.env.FILES_BUCKET,
      t,
      scopeId,
    );
    data.push(...synthesized);
    if (synthesized.length >= 1000) hasMore = true;
  }

  // first_id/last_id drive the AMA SDK's id pager (`Page` in
  // core/pagination.js walks `last_id` → `after_id`), so they must name D1
  // rows — a synthesized `out:` id is not a valid anchor.
  const anchors = page.items.length > 0 ? page.items : [];
  return c.json({
    data,
    has_more: hasMore,
    first_id: anchors[0]?.id ?? data[0]?.id,
    last_id: anchors[anchors.length - 1]?.id ?? data[data.length - 1]?.id,
    // Anthropic SDK Family B list schema: `next_page` is `string | null` — an
    // opaque continuation token. Ours is the shared (created_at, id) cursor;
    // pass it back as `?page_token=` (or `?page=`) for the next page. Null on
    // the last page. The beta files pager itself walks `after_id`, which this
    // route honors too — both cursors resolve to the same seek position.
    next_page: nextPage,
  });
});

// GET /v1/files/:id — get file metadata
app.get("/:id", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");

  // Synthesized session-output id: derive metadata from R2 directly,
  // no D1 round-trip needed.
  const decoded = decodeOutputId(id);
  if (decoded) {
    const bucket = c.env.FILES_BUCKET;
    if (!bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);
    const r2Key = `${sessionOutputsPrefix(t, decoded.sessionId)}${decoded.filename}`;
    const head = await bucket.head(r2Key);
    if (!head) return c.json({ error: "File not found" }, 404);
    const mediaType = head.httpMetadata?.contentType || guessOutputMime(decoded.filename);
    const record: ApiFileRecord = {
      id,
      type: "file",
      filename: decoded.filename,
      media_type: mediaType,
      mime_type: mediaType,
      size_bytes: head.size,
      created_at: head.uploaded.toISOString(),
      scope_id: decoded.sessionId,
      scope: { type: "session", id: decoded.sessionId },
      downloadable: true,
    };
    return c.json(record);
  }

  const row = await c.var.services.files.get({
    tenantId: t,
    fileId: id,
  });
  if (!row) return c.json({ error: "File not found" }, 404);
  return c.json(toFileRecord(row));
});

// GET /v1/files/:id/content — download file content (streamed from R2).
// Gated by `downloadable` flag, mirroring Anthropic's split: user-uploaded
// files are opaque, model/sandbox-emitted artefacts are downloadable.
app.get("/:id/content", async (c) => {
  const id = c.req.param("id");
  const t = c.get("tenant_id");
  const r2 = c.env.FILES_BUCKET;
  const bucket = c.var.services.filesBlob;
  if (!r2 || !bucket) return c.json({ error: "FILES_BUCKET binding not configured" }, 500);

  // Synthesized session-output id: stream R2 directly.
  const decoded = decodeOutputId(id);
  if (decoded) {
    const r2Key = `${sessionOutputsPrefix(t, decoded.sessionId)}${decoded.filename}`;
    const obj = await r2.get(r2Key);
    if (!obj) return c.json({ error: "File content not found" }, 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": obj.httpMetadata?.contentType || guessOutputMime(decoded.filename),
      },
    });
  }

  const row = await c.var.services.files.get({
    tenantId: t,
    fileId: id,
  });
  if (!row) return c.json({ error: "File not found" }, 404);
  if (!row.downloadable) {
    return c.json({ error: "This file is not downloadable" }, 403);
  }

  const obj = await bucket.get(row.r2_key);
  if (!obj) return c.json({ error: "File content not found" }, 404);

  return new Response(obj.body, {
    headers: { "Content-Type": row.media_type },
  });
});

// DELETE /v1/files/:id — delete metadata + R2 object
app.delete("/:id", async (c) => {
  const bucket = c.var.services.filesBlob;
  try {
    const deleted = await c.var.services.files.delete({
      tenantId: c.get("tenant_id"),
      fileId: c.req.param("id"),
    });
    if (bucket) await bucket.delete(deleted.r2_key);
    return c.json({ type: "file_deleted", id: deleted.id });
  } catch (err) {
    if (err instanceof FileNotFoundError) {
      return c.json({ error: "File not found" }, 404);
    }
    throw err;
  }
});

export default app;

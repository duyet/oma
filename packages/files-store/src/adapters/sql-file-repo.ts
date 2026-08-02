import { and, asc, desc, eq, gt, lt, or, type SQL } from "drizzle-orm";
import {
  asBuilder,
  getAll,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@duyet/oma-db-schema";
import { files } from "@duyet/oma-db-schema/cf-auth";
import type {
  FileListOptions,
  FileRepo,
  NewFileInput,
} from "../ports";
import type { PageCursor } from "@duyet/oma-shared";
import type { FileRow, FileScope } from "../types";


/**
 * Drizzle implementation of {@link FileRepo}. Owns the queries against the
 * `files` table defined in apps/main/migrations/0011_files_table.sql.
 *
 * The schema has no FK by project convention — cascade-by-session lives in
 * the `deleteBySession` method below as a single indexed DELETE. Atomicity
 * is per-statement: there's no multi-row batch like the sessions adapter
 * because file inserts are always single-row.
 *
 * Booleans (`downloadable`) are stored as INTEGER 0/1 — SQLite has no native
 * BOOL. The toRow helper does the 0/1 ↔ false/true conversion.
 */
export class SqlFileRepo implements FileRepo {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async insert(input: NewFileInput): Promise<FileRow> {
    await runOnce(
      this.db.insert(files).values({
        id: input.id,
        tenant_id: input.tenantId,
        session_id: input.sessionId,
        scope: input.scope,
        filename: input.filename,
        media_type: input.mediaType,
        size_bytes: input.sizeBytes,
        downloadable: input.downloadable ? 1 : 0,
        r2_key: input.r2Key,
        created_at: input.createdAt,
      }),
    );
    const row = await this.get(input.tenantId, input.id);
    if (!row) throw new Error("file vanished after insert");
    return row;
  }

  async get(tenantId: string, fileId: string): Promise<FileRow | null> {
    const row = await getOne<typeof files.$inferSelect>(
      this.db
        .select()
        .from(files)
        .where(and(eq(files.id, fileId), eq(files.tenant_id, tenantId))),
    );
    return row ? toRow(row) : null;
  }

  async list(tenantId: string, opts: FileListOptions): Promise<FileRow[]> {
    const conds = [eq(files.tenant_id, tenantId)];
    if (opts.sessionId !== undefined) {
      conds.push(eq(files.session_id, opts.sessionId));
    }
    const ascending = opts.order === "asc";
    // A seek cursor walks forward in the requested order, so "after" means
    // greater-than when ascending and less-than when descending; "before" is
    // its mirror. `id` is the tie-break within one created_at millisecond.
    if (opts.after) conds.push(seek(opts.after, ascending));
    if (opts.before) conds.push(seek(opts.before, !ascending));
    const dir = ascending ? asc : desc;
    const rows = await getAll<typeof files.$inferSelect>(
      this.db
        .select()
        .from(files)
        .where(and(...conds))
        .orderBy(dir(files.created_at), dir(files.id))
        .limit(opts.limit),
    );
    return rows.map(toRow);
  }

  async delete(tenantId: string, fileId: string): Promise<FileRow | null> {
    // Read first so we can return the row (caller needs r2_key for R2 delete).
    // Using a separate SELECT + DELETE is fine — files-store has no contention
    // semantics that would make a RETURNING-style atomicity matter here.
    const existing = await this.get(tenantId, fileId);
    if (!existing) return null;
    await runOnce(
      this.db.delete(files).where(and(eq(files.id, fileId), eq(files.tenant_id, tenantId))),
    );
    return existing;
  }

  async deleteBySession(sessionId: string): Promise<FileRow[]> {
    // Two-step: SELECT then DELETE so we can return the deleted rows for R2
    // cleanup. A single transaction would be ideal but D1.batch can't mix
    // SELECT into a write batch — and per-row delete would amplify roundtrips.
    const rows = await getAll<typeof files.$inferSelect>(
      this.db.select().from(files).where(eq(files.session_id, sessionId)),
    );
    if (!rows.length) return [];
    await runOnce(this.db.delete(files).where(eq(files.session_id, sessionId)));
    return rows.map(toRow);
  }
}

/**
 * `(created_at, id)` seek predicate. `forward === true` yields the rows
 * strictly greater than the cursor, `false` the rows strictly less.
 */
function seek(cursor: PageCursor, forward: boolean): SQL {
  const cmp = forward ? gt : lt;
  return or(
    cmp(files.created_at, cursor.createdAt),
    and(eq(files.created_at, cursor.createdAt), cmp(files.id, cursor.id)),
  )!;
}

function toRow(r: typeof files.$inferSelect): FileRow {
  return {
    id: r.id,
    tenant_id: r.tenant_id,
    session_id: r.session_id,
    scope: r.scope as FileScope,
    filename: r.filename,
    media_type: r.media_type,
    size_bytes: r.size_bytes,
    downloadable: r.downloadable === 1,
    r2_key: r.r2_key,
    created_at: msToIso(r.created_at),
  };
}

function msToIso(ms: number): string {
  return new Date(ms).toISOString();
}

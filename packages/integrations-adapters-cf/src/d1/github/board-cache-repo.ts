import { and, eq } from "drizzle-orm";
import {
  asBuilder,
  getOne,
  type OmaDb,
  type OmaDbBuilder,
  runOnce,
} from "@duyet/oma-db-schema";
import { github_board_cache } from "@duyet/oma-db-schema/cf-integrations";
import type { GitHubBoardCacheRepo } from "@duyet/oma-integrations-core";

/**
 * Read-through cache rows for the Console's GitHub Kanban board lookups
 * (repo picker, assignee combobox). Backed by `github_board_cache`, keyed by
 * (installation_id, cache_key) — `"repos"` or `"assignees:<owner>/<repo>"`.
 *
 * Drizzle-only and dialect-blind, so the same class serves the CF D1
 * INTEGRATIONS_DB and the self-host Node SqlClient DB (node-container wires
 * it exactly like the other `Sql*` GitHub repos).
 *
 * The payload is stored verbatim as the JSON the public route serves; the
 * repo never inspects it and never stores a token.
 */
export class SqlGitHubBoardCacheRepo implements GitHubBoardCacheRepo {
  private readonly db: OmaDbBuilder;
  constructor(db: OmaDb) {
    this.db = asBuilder(db);
  }

  async get(
    installationId: string,
    cacheKey: string,
  ): Promise<{ payloadJson: string; fetchedAt: number } | null> {
    const row = await getOne<typeof github_board_cache.$inferSelect>(
      this.db
        .select()
        .from(github_board_cache)
        .where(
          and(
            eq(github_board_cache.installation_id, installationId),
            eq(github_board_cache.cache_key, cacheKey),
          ),
        ),
    );
    return row ? { payloadJson: row.payload_json, fetchedAt: row.fetched_at } : null;
  }

  async put(
    installationId: string,
    cacheKey: string,
    payloadJson: string,
    fetchedAt: number,
  ): Promise<void> {
    await runOnce(
      this.db
        .insert(github_board_cache)
        .values({
          installation_id: installationId,
          cache_key: cacheKey,
          payload_json: payloadJson,
          fetched_at: fetchedAt,
        })
        .onConflictDoUpdate({
          target: [github_board_cache.installation_id, github_board_cache.cache_key],
          set: { payload_json: payloadJson, fetched_at: fetchedAt },
        }),
    );
  }
}

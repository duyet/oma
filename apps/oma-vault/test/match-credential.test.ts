import { describe, it, expect, beforeEach } from "vitest";
import { createBetterSqlite3SqlClient, type SqlClient } from "@duyet/oma-sql-client";
import { findCredentialForUrl, listActiveCredentialTenantIds } from "../src/match-credential";
import { parseTenantScope } from "../src/tenant-scope";

const HOST = "https://api.github.com/user";

async function seedSql(): Promise<SqlClient> {
  const sql = await createBetterSqlite3SqlClient(":memory:");
  await sql.exec(`
    CREATE TABLE credentials (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      vault_id TEXT NOT NULL,
      auth TEXT NOT NULL,
      mcp_server_url TEXT,
      archived_at TEXT
    );
  `);
  return sql;
}

async function insertCred(
  sql: SqlClient,
  row: {
    id: string;
    tenantId: string;
    vaultId: string;
    token: string;
    host?: string;
    archived?: boolean;
  },
): Promise<void> {
  const mcp = row.host ?? "https://api.github.com";
  const auth = JSON.stringify({
    type: "static_bearer",
    token: row.token,
    mcp_server_url: mcp,
  });
  await sql
    .prepare(
      `INSERT INTO credentials (id, tenant_id, vault_id, auth, mcp_server_url, archived_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      row.id,
      row.tenantId,
      row.vaultId,
      auth,
      mcp,
      row.archived ? "2026-01-01T00:00:00.000Z" : null,
    )
    .run();
}

const decrypt = async (stored: string) => stored;

describe("findCredentialForUrl tenant isolation", () => {
  let sql: SqlClient;

  beforeEach(async () => {
    sql = await seedSql();
    await insertCred(sql, {
      id: "cred_a",
      tenantId: "tn_aaa",
      vaultId: "vlt_a",
      token: "token-tenant-a",
    });
    await insertCred(sql, {
      id: "cred_b",
      tenantId: "tn_bbb",
      vaultId: "vlt_b",
      token: "token-tenant-b",
    });
  });

  it("does not let tenant B steal tenant A's token for the same host under wildcard scope", async () => {
    const matched = await findCredentialForUrl(HOST, {
      sql,
      scope: parseTenantScope("*"),
      decrypt,
    });
    expect(matched).toBeNull();
  });

  it("returns only the scoped tenant's token when two tenants share a host", async () => {
    const forA = await findCredentialForUrl(HOST, {
      sql,
      scope: parseTenantScope("tn_aaa"),
      decrypt,
    });
    expect(forA?.injectHeader).toEqual({
      name: "authorization",
      value: "Bearer token-tenant-a",
    });
    expect(forA?.credentialId).toBe("cred_a");

    const forB = await findCredentialForUrl(HOST, {
      sql,
      scope: parseTenantScope("tn_bbb"),
      decrypt,
    });
    expect(forB?.injectHeader).toEqual({
      name: "authorization",
      value: "Bearer token-tenant-b",
    });
    expect(forB?.credentialId).toBe("cred_b");
  });

  it("still injects for a single-operator wildcard", async () => {
    const one = await createBetterSqlite3SqlClient(":memory:");
    await one.exec(`
      CREATE TABLE credentials (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        vault_id TEXT NOT NULL,
        auth TEXT NOT NULL,
        mcp_server_url TEXT,
        archived_at TEXT
      );
    `);
    await insertCred(one, {
      id: "cred_only",
      tenantId: "tn_only",
      vaultId: "vlt_only",
      token: "token-only",
    });
    const matched = await findCredentialForUrl(HOST, {
      sql: one,
      scope: parseTenantScope(undefined),
      decrypt,
    });
    expect(matched?.injectHeader.value).toBe("Bearer token-only");
  });

  it("treats a missing credentials table as zero tenants so a fresh install boots", async () => {
    const empty = await createBetterSqlite3SqlClient(":memory:");
    expect(await listActiveCredentialTenantIds(empty)).toEqual([]);
  });

  it("lists distinct active tenant ids and ignores archived rows", async () => {
    await insertCred(sql, {
      id: "cred_archived",
      tenantId: "tn_ccc",
      vaultId: "vlt_c",
      token: "token-archived",
      archived: true,
    });
    const ids = await listActiveCredentialTenantIds(sql);
    expect(ids.sort()).toEqual(["tn_aaa", "tn_bbb"]);
  });
});

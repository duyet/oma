import type { SqlClient } from "@duyet/oma-sql-client";
import type { CredentialAuth } from "@duyet/oma-shared";
import { sqlScopeParam, type TenantScope } from "./tenant-scope";

export interface MatchedCred {
  vaultId: string;
  credentialId: string;
  tenantId: string;
  injectHeader: { name: string; value: string };
}

export interface MatchCredentialDeps {
  sql: SqlClient;
  scope: TenantScope;
  decrypt: (stored: string) => Promise<string>;
  onUndecryptable?: (credentialId: string, err: Error) => void;
  onCrossTenantHostCollision?: (host: string, tenantIds: string[]) => void;
}

interface CredentialRow {
  id: string;
  tenant_id: string;
  vault_id: string;
  auth: string;
}

export async function listActiveCredentialTenantIds(
  sql: SqlClient,
): Promise<string[]> {
  try {
    const result = await sql
      .prepare(
        `SELECT DISTINCT tenant_id
           FROM credentials
          WHERE archived_at IS NULL`,
      )
      .all<{ tenant_id: string }>();
    return (result.results ?? []).map((row) => row.tenant_id);
  } catch (err) {
    const msg = (err as Error).message ?? "";
    if (/no such table/i.test(msg) || /does not exist/i.test(msg)) return [];
    throw err;
  }
}

/**
 * Match an outbound URL to an active credential by hostname.
 *
 * Wildcard scope still scans every tenant (single-operator). If more than
 * one tenant has an injectable credential for the same host, return null
 * rather than picking the first token.
 */
export async function findCredentialForUrl(
  url: string,
  deps: MatchCredentialDeps,
): Promise<MatchedCred | null> {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    return null;
  }

  const sqlScope = sqlScopeParam(deps.scope);
  const result = await deps.sql
    .prepare(
      `SELECT id, tenant_id, vault_id, auth
         FROM credentials
        WHERE archived_at IS NULL
          AND mcp_server_url IS NOT NULL
          AND ( ? = '*' OR tenant_id = ? )`,
    )
    .bind(sqlScope, sqlScope)
    .all<CredentialRow>();

  const matches: MatchedCred[] = [];
  for (const row of result.results ?? []) {
    let auth: CredentialAuth;
    try {
      auth = JSON.parse(await deps.decrypt(row.auth)) as CredentialAuth;
    } catch (err) {
      deps.onUndecryptable?.(row.id, err as Error);
      continue;
    }
    if (!auth.mcp_server_url) continue;
    let credHost: string;
    try {
      credHost = new URL(auth.mcp_server_url).host;
    } catch {
      continue;
    }
    if (credHost !== host) continue;
    const headerSpec = authToHeader(auth);
    if (!headerSpec) continue;
    matches.push({
      vaultId: row.vault_id,
      credentialId: row.id,
      tenantId: row.tenant_id,
      injectHeader: headerSpec,
    });
  }

  if (deps.scope.kind === "wildcard") {
    const tenantIds = [...new Set(matches.map((m) => m.tenantId))];
    if (tenantIds.length > 1) {
      deps.onCrossTenantHostCollision?.(host, tenantIds);
      return null;
    }
  }

  return matches[0] ?? null;
}

export function authToHeader(
  auth: CredentialAuth,
): { name: string; value: string } | null {
  switch (auth.type) {
    case "static_bearer":
      return { name: "authorization", value: `Bearer ${auth.token}` };
    case "cap_cli":
      if (typeof auth.token === "string" && auth.token.length > 0) {
        return { name: "authorization", value: `Bearer ${auth.token}` };
      }
      return null;
    case "mcp_oauth":
      return null;
    default: {
      const _exhaustive: never = auth.type;
      void _exhaustive;
      return null;
    }
  }
}

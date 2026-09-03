/**
 * oma-vault tenant scope for outbound credential matching.
 *
 * Unset, empty, and "*" are wildcard (single-operator). A concrete `tn_*`
 * id locks lookup to that tenant. Wildcard + more than one distinct
 * tenant_id in credentials is refused at boot (issue #428).
 */

export type TenantScope =
  | { kind: "wildcard" }
  | { kind: "tenant"; id: string };

export class WildcardMultiTenantError extends Error {
  readonly distinctTenantCount: number;

  constructor(distinctTenantCount: number) {
    super(
      `Refusing to start: OMA_TENANT is unset or "*" but credentials belong to ` +
        `${distinctTenantCount} tenants. Set OMA_TENANT to a tn_* id to lock ` +
        `lookup to one tenant (required for multi-user deploys).`,
    );
    this.name = "WildcardMultiTenantError";
    this.distinctTenantCount = distinctTenantCount;
  }
}

export function parseTenantScope(raw: string | undefined): TenantScope {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "" || trimmed === "*") return { kind: "wildcard" };
  return { kind: "tenant", id: trimmed };
}

export function sqlScopeParam(scope: TenantScope): string {
  return scope.kind === "wildcard" ? "*" : scope.id;
}

export function assertWildcardScopeAllowed(
  scope: TenantScope,
  distinctTenantIds: readonly string[],
): void {
  if (scope.kind !== "wildcard") return;
  if (distinctTenantIds.length <= 1) return;
  throw new WildcardMultiTenantError(distinctTenantIds.length);
}

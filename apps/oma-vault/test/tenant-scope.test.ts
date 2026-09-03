import { describe, it, expect } from "vitest";
import {
  assertWildcardScopeAllowed,
  parseTenantScope,
  sqlScopeParam,
  WildcardMultiTenantError,
} from "../src/tenant-scope";

describe("parseTenantScope", () => {
  it("treats unset, empty, and * as wildcard", () => {
    expect(parseTenantScope(undefined)).toEqual({ kind: "wildcard" });
    expect(parseTenantScope("")).toEqual({ kind: "wildcard" });
    expect(parseTenantScope("  ")).toEqual({ kind: "wildcard" });
    expect(parseTenantScope("*")).toEqual({ kind: "wildcard" });
  });

  it("locks a concrete tenant id", () => {
    expect(parseTenantScope("tn_aaa")).toEqual({ kind: "tenant", id: "tn_aaa" });
    expect(sqlScopeParam({ kind: "tenant", id: "tn_aaa" })).toBe("tn_aaa");
    expect(sqlScopeParam({ kind: "wildcard" })).toBe("*");
  });
});

describe("assertWildcardScopeAllowed", () => {
  it("lets single-operator wildcard boot (zero or one tenant)", () => {
    expect(() => assertWildcardScopeAllowed({ kind: "wildcard" }, [])).not.toThrow();
    expect(() =>
      assertWildcardScopeAllowed({ kind: "wildcard" }, ["tn_only"]),
    ).not.toThrow();
  });

  it("lets a concrete tenant id boot even when many tenants exist", () => {
    expect(() =>
      assertWildcardScopeAllowed({ kind: "tenant", id: "tn_aaa" }, ["tn_aaa", "tn_bbb"]),
    ).not.toThrow();
  });

  it("refuses wildcard when credentials span more than one tenant", () => {
    expect(() =>
      assertWildcardScopeAllowed({ kind: "wildcard" }, ["tn_aaa", "tn_bbb"]),
    ).toThrow(WildcardMultiTenantError);
  });
});

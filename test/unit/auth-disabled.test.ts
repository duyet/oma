import { describe, expect, it } from "vitest";
import {
  AUTH_DISABLED_HTTP,
  isAuthDisabled,
  isAuthInfoDisabled,
} from "../../packages/shared/src/auth-disabled";

describe("AUTH_DISABLED helpers", () => {
  it("isAuthDisabled is true only for the literal string 1", () => {
    expect(isAuthDisabled("1")).toBe(true);
    expect(isAuthDisabled(undefined)).toBe(false);
    expect(isAuthDisabled("true")).toBe(false);
    expect(isAuthDisabled("0")).toBe(false);
    expect(isAuthDisabled("")).toBe(false);
  });

  it("isAuthInfoDisabled treats providers: [] as auth-off", () => {
    expect(isAuthInfoDisabled([])).toBe(true);
    expect(isAuthInfoDisabled(["email"])).toBe(false);
    expect(isAuthInfoDisabled(["email", "github"])).toBe(false);
    expect(isAuthInfoDisabled(undefined)).toBe(false);
  });

  it("AUTH_DISABLED_HTTP is 410 with a stable error code", () => {
    expect(AUTH_DISABLED_HTTP.status).toBe(410);
    expect(AUTH_DISABLED_HTTP.body.error).toBe("auth_disabled");
    expect(AUTH_DISABLED_HTTP.body.message).toContain("AUTH_DISABLED=1");
  });
});

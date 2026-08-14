import { describe, expect, it } from "vitest";
import { authorizeInternalTick, isInternalCronTickRequest } from "./cron-tick";

describe("authorizeInternalTick", () => {
  it("accepts a matching x-internal-secret", () => {
    const req = new Request("http://gateway/internal/cron/tick", {
      method: "POST",
      headers: { "x-internal-secret": "s3cret" },
    });
    expect(authorizeInternalTick(req, "s3cret")).toBe(true);
  });

  it("rejects a missing or mismatched secret", () => {
    const req = new Request("http://gateway/internal/cron/tick", {
      method: "POST",
      headers: { "x-internal-secret": "wrong" },
    });
    expect(authorizeInternalTick(req, "s3cret")).toBe(false);
    expect(authorizeInternalTick(req, undefined)).toBe(false);
    expect(authorizeInternalTick(new Request("http://gateway/internal/cron/tick", { method: "POST" }), "s3cret")).toBe(false);
  });
});

describe("isInternalCronTickRequest", () => {
  it("matches POST /internal/cron/tick only", () => {
    expect(isInternalCronTickRequest(new Request("http://gateway/internal/cron/tick", { method: "POST" }))).toBe(true);
    expect(isInternalCronTickRequest(new Request("http://gateway/internal/cron/tick", { method: "GET" }))).toBe(false);
    expect(isInternalCronTickRequest(new Request("http://gateway/internal/cron/other", { method: "POST" }))).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { checkInternalSecret } from "./internal-auth";

const EXPECTED = "test-internal-secret";

function appWithSecret(expected: string | null | undefined) {
  const app = new Hono();
  app.get("/gate", (c) => {
    const blocked = checkInternalSecret(c, expected);
    if (blocked) return blocked;
    return c.json({ ok: true });
  });
  return app;
}

describe("checkInternalSecret", () => {
  it("lets a matching x-internal-secret through", async () => {
    const res = await appWithSecret(EXPECTED).request("/gate", {
      headers: { "x-internal-secret": EXPECTED },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("returns 401 unauthorized when the header is wrong", async () => {
    const res = await appWithSecret(EXPECTED).request("/gate", {
      headers: { "x-internal-secret": "wrong" },
    });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });

  it("returns 401 unauthorized when the header is missing", async () => {
    const res = await appWithSecret(EXPECTED).request("/gate");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
  });
});

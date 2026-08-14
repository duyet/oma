import { describe, expect, it, vi } from "vitest";
import { INTEGRATIONS_CRON_TICK_PATH, tickIntegrationsViaBinding } from "./integrations-cron-tick";
import type { Env } from "@duyet/oma-shared";

describe("tickIntegrationsViaBinding", () => {
  it("no-ops when the binding or secret is missing", async () => {
    await tickIntegrationsViaBinding({} as Env);
    await tickIntegrationsViaBinding({ INTEGRATIONS: { fetch: vi.fn() } } as unknown as Env);
    await tickIntegrationsViaBinding({ INTEGRATIONS_INTERNAL_SECRET: "s" } as Env);
  });

  it("POSTs the shared tick path with the internal secret", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 202 }));
    await tickIntegrationsViaBinding({
      INTEGRATIONS: { fetch },
      INTEGRATIONS_INTERNAL_SECRET: "s3cret",
    } as unknown as Env);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://gateway${INTEGRATIONS_CRON_TICK_PATH}`);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["x-internal-secret"]).toBe("s3cret");
  });
});

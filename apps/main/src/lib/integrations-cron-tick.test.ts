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
    const call = fetch.mock.calls[0];
    expect(call?.[0]).toBe(`http://gateway${INTEGRATIONS_CRON_TICK_PATH}`);
    const init = call?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect((init?.headers as Record<string, string> | undefined)?.["x-internal-secret"]).toBe("s3cret");
  });
});

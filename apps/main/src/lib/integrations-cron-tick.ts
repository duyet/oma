import type { Env } from "@duyet/oma-shared";
import { logError } from "@duyet/oma-shared";

/** Path on the integrations worker. Must stay in sync with
 *  `INTERNAL_TICK_PATH` in apps/integrations/src/cron-tick.ts. */
export const INTEGRATIONS_CRON_TICK_PATH = "/internal/cron/tick";

/**
 * Fan the main worker's minute cron out to the integrations worker over
 * the service binding. Hosted prod cannot declare a second wrangler
 * trigger — Workers Free is 5 crons per account, already at the ceiling
 * (CF API 10072). Linear dispatch + Telegram idle sweep still run; they
 * just ride main's existing `* * * * *`.
 *
 * No-op when the binding or shared secret is missing (OSS / tests /
 * deploys without the integrations worker).
 */
export async function tickIntegrationsViaBinding(env: Env): Promise<void> {
  if (!env.INTEGRATIONS || !env.INTEGRATIONS_INTERNAL_SECRET) return;
  const res = await env.INTEGRATIONS.fetch(`http://gateway${INTEGRATIONS_CRON_TICK_PATH}`, {
    method: "POST",
    headers: { "x-internal-secret": env.INTEGRATIONS_INTERNAL_SECRET },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    logError(
      { op: "cron.integrations_tick", status: res.status, body: body.slice(0, 200) },
      "integrations cron fan-out failed",
    );
  }
}

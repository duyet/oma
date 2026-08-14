import type { Env } from "./env";
import { buildProviders } from "./providers";
import { buildContainer } from "./wire";
import { telegramChatStore, telegramIdleTimeoutMs } from "./routes/telegram/wire";
import { sweepIdleTelegramChats } from "@duyet/oma-telegram";
import { linearDispatchTick } from "@duyet/oma-scheduler/jobs/linear-dispatch";
import { getLogger } from "@duyet/oma-observability";
import { pingHealthchecks } from "@duyet/oma-shared";

const log = getLogger("apps.integrations");

const INTERNAL_TICK_PATH = "/internal/cron/tick";

/**
 * Linear dispatch + Telegram idle sweep. Same work the wrangler cron
 * used to run. Hosted prod no longer declares its own trigger — the
 * Free plan is 5 crons per *account*, and main already owns the minute
 * tick. Main fans out here over the INTEGRATIONS service binding.
 */
export function runIntegrationsTick(
  env: Env,
  ctx: { waitUntil(promise: Promise<unknown>): void },
  cron = "* * * * *",
): void {
  pingHealthchecks(env, "start", "linear-dispatch tick started").catch(() => {});

  const tick = linearDispatchTick({
    resolveSweeper: async () => {
      const { linear } = buildProviders(env);
      return linear;
    },
  });
  ctx.waitUntil(
    tick()
      .then(() => {
        pingHealthchecks(env, "success", "linear-dispatch tick completed").catch(() => {});
      })
      .catch((err) => {
        log.error(
          { err, op: "linear-dispatch-cron.fatal", cron },
          "linear-dispatch tick failed",
        );
        const msg = err instanceof Error ? err.message : String(err);
        pingHealthchecks(env, "fail", `linear-dispatch tick failed: ${msg}`).catch(() => {});
      }),
  );

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_AGENT_ID) {
    const container = buildContainer(env);
    ctx.waitUntil(
      sweepIdleTelegramChats({
        store: telegramChatStore,
        pause: (userId, sessionId) => container.sessions.pause(userId, sessionId),
        now: () => Date.now(),
        idleTimeoutMs: telegramIdleTimeoutMs(env),
      }).catch((err) => {
        log.error({ err, op: "telegram-idle-sweep.fatal", cron }, "telegram idle sweep failed");
      }),
    );
  }
}

export function authorizeInternalTick(req: Request, secret: string | undefined): boolean {
  return !!secret && req.headers.get("x-internal-secret") === secret;
}

export function isInternalCronTickRequest(req: Request): boolean {
  const url = new URL(req.url);
  return req.method === "POST" && url.pathname === INTERNAL_TICK_PATH;
}

export { INTERNAL_TICK_PATH };

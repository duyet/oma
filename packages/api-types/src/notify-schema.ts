// Zod schemas for `NotificationTarget`. Colocated with the wire types in
// types.ts so the agent config `notify` union is validated wherever agents
// are accepted (http-routes agents CRUD). `webhook`'s `secret_ref` is a
// vault credential id — it must never be inlined, so the schema only allows
// a string ref (the live secret is resolved at dispatch time, not stored
// alongside the agent config).

import { z } from "zod";

const githubCommentTarget = z.object({
  type: z.literal("github_comment"),
  credential_id: z.string(),
  owner: z.string(),
  repo: z.string(),
  issue_number: z.number().int(),
});

const slackMessageTarget = z.object({
  type: z.literal("slack_message"),
  credential_id: z.string(),
  channel: z.string(),
});

const matrixMessageTarget = z.object({
  type: z.literal("matrix_message"),
  credential_id: z.string(),
  homeserver_url: z.string(),
  room_id: z.string(),
});

// No `credential_id` — Telegram auth is a single bot token resolved from
// env (TELEGRAM_BOT_TOKEN), not a per-target vault credential.
const telegramMessageTarget = z.object({
  type: z.literal("telegram_message"),
  chat_id: z.number().int(),
});

// No `credential_id` — email delivery uses the deployment's configured
// email sender seam (packages/email: CF `SEND_EMAIL` binding / self-host
// nodemailer SMTP), not a per-target vault credential.
const emailTarget = z.object({
  type: z.literal("email"),
  to: z.string().email(),
  subject_prefix: z.string().optional(),
});

const webhookTarget = z.object({
  type: z.literal("webhook"),
  url: z.string().url(),
  secret_ref: z.string().optional(),
  events: z
    .array(z.enum(["idle", "error", "terminated"]))
    .optional(),
});

export const notificationTargetSchema = z.discriminatedUnion("type", [
  githubCommentTarget,
  slackMessageTarget,
  matrixMessageTarget,
  telegramMessageTarget,
  emailTarget,
  webhookTarget,
]);

export const notificationTargetsSchema = z.array(notificationTargetSchema);

export type NotificationTargetInput = z.infer<typeof notificationTargetSchema>;

/**
 * Per-schedule alert config (`agent_schedules.notify`, issue #313). Distinct
 * from an agent's `notify`: an agent's targets fire for every session it
 * runs, while this one only fires for THIS schedule's cron firings.
 *
 * `on` filters which firing outcomes alert. When absent the default is
 * `["error", "skipped_concurrency"]` — the two outcomes an operator
 * generally wants paged about; success is opt-in via an explicit `on`.
 * The filter is applied BEFORE dispatch, so it is independent of (and does
 * not interact with) a `webhook` target's own `events` filter.
 */
export const scheduleNotifySchema = z.object({
  on: z.array(z.enum(["ok", "error", "skipped_concurrency"])).optional(),
  targets: notificationTargetsSchema,
});

export type ScheduleNotifyInput = z.infer<typeof scheduleNotifySchema>;

/** Outcomes alerted on when a schedule's `notify.on` is absent. */
export const DEFAULT_SCHEDULE_NOTIFY_ON = ["error", "skipped_concurrency"] as const;

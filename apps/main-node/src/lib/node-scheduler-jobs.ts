// Node scheduler wiring — registers the same cron handlers as the CF
// entry. Started after the HTTP server boots; stopped on SIGTERM.
//
// Single-instance default: croner runs the schedule in-process. The
// retention sweeps are idempotent SQL DELETEs, so when scaling to
// multiple replicas later the worst case is "two replicas DELETE the
// same rows in the same minute" — both succeed harmlessly.

import type { SqlClient } from "@duyet/oma-sql-client";
import type { AgentService } from "@duyet/oma-agents-store";
import type { EnvironmentService } from "@duyet/oma-environments-store";
import type { SessionService } from "@duyet/oma-sessions-store";
import type { EvalRunService } from "@duyet/oma-evals-store";
import type { MemoryStoreService } from "@duyet/oma-memory-store";
import type { KvStore } from "@duyet/oma-kv-store";
import { getLogger } from "@duyet/oma-observability";

const log = getLogger("node-scheduler");
import { createNodeScheduler } from "@duyet/oma-scheduler/node";
import { memoryRetentionTick } from "@duyet/oma-scheduler/jobs/memory-retention";
import { webhookEventsRetentionTick } from "@duyet/oma-scheduler/jobs/webhook-events-retention";
import { withHealthchecks } from "@duyet/oma-shared";
import {
  linearDispatchTick,
  type LinearDispatchSweeper,
} from "@duyet/oma-scheduler/jobs/linear-dispatch";
import {
  scheduledAgentRunsTick,
  type ClaimedSchedule,
  type RecordRunInput,
  type ScheduledRunLauncher,
} from "@duyet/oma-scheduler/jobs/scheduled-agent-runs";
import { SqlClientScheduledRunsStore } from "@duyet/oma-scheduler/jobs/scheduled-agent-runs-store";
import {
  scheduledDeploymentRunsTick,
  type ScheduledDeploymentRunLauncher,
} from "@duyet/oma-scheduler/jobs/scheduled-deployment-runs";
import { SqlClientScheduledDeploymentRunsStore } from "@duyet/oma-scheduler/jobs/scheduled-deployment-runs-store";
import {
  tickEvalRuns,
  type EvalRunnerContext,
  type EvalRunnerServices,
  type SandboxFetcher,
} from "@duyet/oma-evals-runner";
import {
  collectInstallReport,
  sendInstallReport,
  resolveInstanceId,
  telemetryDisabled,
} from "@duyet/oma-http-routes";

export interface NodeSchedulerDeps {
  evalServices: EvalRunnerServices;
  memory: MemoryStoreService;
  /** Optional integrations DB SqlClient. Pass null to skip the
   *  webhook-events retention sweep on Node. */
  integrationsSql?: SqlClient | null;
  /** Optional Linear dispatch sweeper. Wired by the bootstrap when an
   *  in-process LinearProvider is available. Skip when null — most
   *  self-host deployments don't run the Linear gateway side yet. */
  linearSweeper?: (() => Promise<LinearDispatchSweeper | null>) | null;
  /** Control-plane SqlClient. Shared by the anonymous install phone-home job
   *  (aggregates local counts) and the scheduled-agent-runs tick (issue #262 —
   *  agent_schedules lives in this single Node control-plane DB). Pass null to
   *  skip both. */
  controlPlaneSql?: SqlClient | null;
  /** OMA version string reported by the install phone-home job. */
  omaVersion?: string;
  /** Launcher over the Node session-create path — mirrors the CF launcher in
   *  apps/main/src/lib/cf-scheduler-jobs.ts. Only registered alongside
   *  {@link controlPlaneSql}. */
  scheduledRunLauncher?: ScheduledRunLauncher | null;
  /** Deployment-run launcher — fires schedule-triggered deployments over the
   *  Node session-create path. Only registered alongside
   *  {@link controlPlaneSql}. Deployment CRUD is CF-only today, so on Node
   *  this fires nothing until deployment rows exist, but the tick + CAS are
   *  wired identically to CF. */
  scheduledDeploymentRunLauncher?: ScheduledDeploymentRunLauncher | null;
  /** Per-schedule alert dispatcher (issue #313). Built in
   *  apps/main-node/src/index.ts where the vault + credential services are in
   *  scope; the tick only calls it for firings the schedule's `notify.on`
   *  filter selects, and swallows anything it throws. */
  scheduleRunNotifier?:
    | ((schedule: ClaimedSchedule, run: RecordRunInput) => Promise<void>)
    | null;
  /** Override defaults via env so an operator can quiet noisy crons
   *  during a maintenance window without a code change. */
  env?: NodeJS.ProcessEnv;
}

export function buildNodeScheduler(deps: NodeSchedulerDeps) {
  const env = deps.env ?? process.env;
  const hcEnv = { HEALTHCHECKS_IO_URL: env.HEALTHCHECKS_IO_URL };
  const cron = (key: string, fallback: string) => {
    const v = env[key];
    return v && v.trim() ? v : fallback;
  };

  const scheduler = createNodeScheduler();

  // Eval-tick: runs every minute by default. Node's eval runner has no
  // SANDBOX_<env> binding to call into yet — until cloud environments
  // land on Node, this just iterates `evals.listActive()` (empty under
  // SQLite default) and exits. Cheap.
  const evalCtx: EvalRunnerContext = {
    forEachShard: async (fn) => [await fn(deps.evalServices)],
    getServicesForTenant: async () => deps.evalServices,
    getSandboxBinding: async (): Promise<SandboxFetcher | null> => null,
  };
  scheduler.register({
    name: "eval-tick",
    cron: cron("EVAL_TICK_CRON", "* * * * *"),
    handler: withHealthchecks(hcEnv, "eval-tick", async () => {
      try {
        await tickEvalRuns(evalCtx);
      } catch (err) {
        log.warn({ err, op: "scheduler.eval_tick.failed" }, "eval-tick failed");
      }
    }),
  });

  // Memory retention.
  scheduler.register({
    name: "memory-retention",
    cron: cron("MEMORY_RETENTION_CRON", "* * * * *"),
    handler: withHealthchecks(hcEnv, "memory-retention", memoryRetentionTick({
      forEachShard: async (fn) => [await fn({ memory: deps.memory }, "default")],
    })),
  });

  // Webhook-events retention — only registered if an integrations DB
  // is wired (P4 territory). Otherwise the registration is skipped so
  // it doesn't fire and log "skipping" every minute.
  if (deps.integrationsSql) {
    const integrationsSql = deps.integrationsSql;
    scheduler.register({
      name: "webhook-events-retention",
      cron: cron("WEBHOOK_EVENTS_RETENTION_CRON", "* * * * *"),
      handler: withHealthchecks(hcEnv, "webhook-events-retention", webhookEventsRetentionTick({
        resolveIntegrationsDb: () => integrationsSql,
      })),
    });
  }

  // Linear dispatch sweep + drain. Only registered when a sweeper resolver
  // is provided — most self-host deployments don't run the gateway side
  // (no Linear OAuth callback URL configured), so the registration is
  // gated rather than no-op'd.
  if (deps.linearSweeper) {
    const resolveSweeper = deps.linearSweeper;
    scheduler.register({
      name: "linear-dispatch",
      cron: cron("LINEAR_DISPATCH_CRON", "* * * * *"),
      handler: withHealthchecks(hcEnv, "linear-dispatch", linearDispatchTick({ resolveSweeper })),
    });
  }

  // Anonymous install / deployment phone-home (every 6h by default). Opt-out
  // via OMA_TELEMETRY_DISABLED / OMA_TELEMETRY=0 / DO_NOT_TRACK. Only
  // registered when a control-plane SqlClient is wired. Fully self-contained
  // + wrapped in try/catch — never throws into the scheduler.
  if (deps.controlPlaneSql) {
    const controlSql = deps.controlPlaneSql;
    scheduler.register({
      name: "telemetry-phone-home",
      cron: cron("TELEMETRY_PHONEHOME_CRON", "0 */6 * * *"),
      handler: async () => {
        try {
          if (telemetryDisabled(env)) return;
          const instanceId = await resolveInstanceId();
          const deploymentKind = env.OMA_DEPLOYMENT_KIND || "node-docker";
          const omaVersion = env.OMA_VERSION || deps.omaVersion;
          const endpoint = env.OMA_TELEMETRY_ENDPOINT || "https://app.oma.duyet.net";
          const report = await collectInstallReport(controlSql, {
            instanceId,
            omaVersion,
            deploymentKind,
          });
          await sendInstallReport(report, { endpoint });
        } catch (err) {
          log.warn(
            { err, op: "scheduler.telemetry_phone_home.failed" },
            "telemetry-phone-home failed",
          );
        }
      },
    });
  }

  // Scheduled agent runs (issue #262) — fires user-defined agent schedules on
  // the self-host Node runtime, reusing the same shared tick + store + CAS the
  // CF deployment uses (apps/main/src/lib/cf-scheduler-jobs.ts). Registered
  // only when both a control-plane DB and a launcher are wired. The tick's own
  // async resolver-and-swallow contract means a single slow tick can't overlap
  // into itself; the store's compare-and-set on next_run_at guards double-fire
  // across replicas.
  if (deps.controlPlaneSql && deps.scheduledRunLauncher) {
    const store = new SqlClientScheduledRunsStore(deps.controlPlaneSql);
    const launcher = deps.scheduledRunLauncher;
    scheduler.register({
      name: "scheduled-agent-runs",
      cron: cron("SCHEDULED_AGENT_RUNS_CRON", "* * * * *"),
      handler: withHealthchecks(
        hcEnv,
        "scheduled-agent-runs",
        scheduledAgentRunsTick({
          resolveStore: async () => store,
          resolveLauncher: async () => launcher,
          ...(deps.scheduleRunNotifier
            ? { onRunRecorded: deps.scheduleRunNotifier }
            : {}),
        }),
      ),
    });

    // Scheduled deployment runs — same shared tick + CAS store the CF entry
    // uses, its own cron so it never interferes with agent-runs.
    if (deps.scheduledDeploymentRunLauncher) {
      const depStore = new SqlClientScheduledDeploymentRunsStore(deps.controlPlaneSql);
      const depLauncher = deps.scheduledDeploymentRunLauncher;
      scheduler.register({
        name: "scheduled-deployment-runs",
        cron: cron("SCHEDULED_DEPLOYMENT_RUNS_CRON", "* * * * *"),
        handler: withHealthchecks(
          hcEnv,
          "scheduled-deployment-runs",
          scheduledDeploymentRunsTick({
            resolveStore: async () => depStore,
            resolveLauncher: async () => depLauncher,
          }),
        ),
      });
    }
  }

  return scheduler;
}

export type {
  AgentService,
  EnvironmentService,
  SessionService,
  EvalRunService,
  KvStore,
};


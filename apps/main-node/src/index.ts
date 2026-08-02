/**
 * apps/main-node — self-host Node entry for the Open Managed Agents API.
 *
 * Wiring file. ~280 lines: build services → mount route bundles from
 * @duyet/oma-http-routes → start server. All route bodies live
 * in packages/http-routes; storage adapters in their respective packages
 * (agents-store, vaults-store, memory-store, etc.).
 */

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import {
  createNodeLogger,
} from "@duyet/oma-observability/logger/node";
import {
  createNodeMetricsRecorder,
  type NodeMetricsHandle,
} from "@duyet/oma-observability/metrics/node";
import {
  createNodeTracer,
  type NodeTracerHandle,
} from "@duyet/oma-observability/tracer/node";
import {
  requestMetrics,
  tracerMiddleware,
  setRootLogger,
  type Logger,
} from "@duyet/oma-observability";
import {
  createBetterSqlite3SqlClient,
  createPostgresSqlClient,
  type SqlClient,
} from "@duyet/oma-sql-client";
import { createSqliteAgentService, seedDefaultAgent } from "@duyet/oma-agents-store";
import {
  createSqliteMemoryStoreService,
  SqlMemoryRepo,
} from "@duyet/oma-memory-store";
import { createSqliteDreamService } from "@duyet/oma-dreams-store";
import { LocalFsBlobStore as MemoryLocalFsBlobStore } from "@duyet/oma-memory-store/adapters/local-fs-blob";
import {
  S3BlobStore as FilesS3BlobStore,
  type BlobStore,
} from "@duyet/oma-blob-store";
import { LocalFsBlobStore as FilesLocalFsBlobStore } from "@duyet/oma-blob-store/adapters/local-fs";
import { createSqliteVaultService } from "@duyet/oma-vaults-store";
import { createSqliteCredentialService } from "@duyet/oma-credentials-store";
import { createSqliteSessionService } from "@duyet/oma-sessions-store";
import { createSqliteFileService } from "@duyet/oma-files-store";
import { createSqliteEvalRunService } from "@duyet/oma-evals-store";
import { createSqliteEnvironmentService, toEnvironmentConfig } from "@duyet/oma-environments-store";
import { createSqlitePublicationService } from "@duyet/oma-publications-store";
import { createSqliteModelCardService } from "@duyet/oma-model-cards-store";
import { toFileRecord } from "@duyet/oma-files-store";
import { SqlEventLog } from "@duyet/oma-event-log/sql";
import type { SessionEvent } from "@duyet/oma-shared";
import {
  generateEventId,
  findLeakedPlaceholderSecrets,
  formatLeakedSecretError,
} from "@duyet/oma-shared";
import { DefaultHarness } from "@duyet/oma-agent/harness/default-loop";
import { ClaudeAgentSdkHarness } from "@duyet/oma-agent/harness/claude-agent-sdk-loop";
import { PoolsideHarness } from "@duyet/oma-agent/harness/poolside-loop";
import { buildTools } from "@duyet/oma-agent/harness/tools";
import { resolveModel } from "@duyet/oma-agent/harness/provider";
import { composeSystemPrompt } from "@duyet/oma-agent/harness/platform-guidance";
import type { HarnessContext } from "@duyet/oma-agent/harness/interface";
import { nodeToMarkdown } from "@duyet/oma-markdown/adapters/node";
import { buildNodeMcpBinding } from "./mcp-proxy";
import { applyBetterAuthSchema } from "@duyet/oma-schema";
import { ensureSchema as ensureEventLogSchema } from "@duyet/oma-event-log/sql";
import {
  SandboxProviderRegistry,
  InMemoryQuotaStore,
  SYSTEM_PROVIDERS,
  buildUnseededHostingTypes,
  describeProviderAvailability,
  resolveDefaultLocalSandboxProvider,
  type SandboxProviderConfig,
  type SandboxUsageRecord,
} from "@duyet/oma-sandbox";
import {
  buildAgentRoutes,
  buildScheduleRoutes,
  buildTenantScheduleRoutes,
  buildVaultRoutes,
  buildMcpServerRoutes,
  buildFederationRoutes,
  buildOmaMcpRoutes,
  buildAnalyticsRoutes,
  buildTelemetryRoutes,
  buildEnvironmentRoutes,
  buildSessionRoutes,
  buildMemoryRoutes,
  buildDreamRoutes,
  buildTenantRoutes,
  buildTenantMemberRoutes,
  buildInviteAcceptRoutes,
  type InviteRoutesDeps,
  buildMeRoutes,
  buildDeviceRoutes,
  buildApiKeyRoutes,
  buildEvalRoutes,
  buildIntegrationsRoutes,
  buildIntegrationsGatewayRoutes,
  buildAnyRouterRoutes,
  buildTelegramWebhookRoute,
  buildModelCardRoutes,
  buildStatsRoutes,
  buildUsageRoutes,
  buildSkillRoutes,
  type RouteServices,
  type ApiKeyStorage,
  type ApiKeyMeta,
  type ApiKeyRecord,
  type InstallProxyForwarder,
  mintApiKeyOnStorage,
  sha256Hex,
  buildPublicPublicationRoutes,
  publicSessionCaps,
  gatePublicationState,
  buildConsumerAuthRoutes,
  createSqlConsumerAuthStore,
  verifyMagicLinkToken,
  buildPublicationRoutes,
  buildAgentPublicationRoutes,
} from "@duyet/oma-http-routes";
import {
  getActiveAnyRouterProvider,
  loadActiveAnyRouterProvider,
  setActiveAnyRouterProvider,
  clearActiveAnyRouterProvider,
} from "./lib/anyrouter-provider.js";
import {
  buildNodeRepos,
  SqlSlackInstallationRepo,
  SqlSlackPublicationRepo,
  SqlSlackAppRepo,
  WebCryptoAesGcm,
  CryptoIdGenerator,
  WorkerHttpClient,
  type NodeReposEnv,
} from "@duyet/oma-integrations-adapters-node";
import { dispatchSessionNotifications } from "@duyet/oma-agent/runtime/notify-dispatch";
import type { SessionNotifyEvent } from "@duyet/oma-integrations-core";
import {
  NodeInstallBridge,
  buildNodeProvidersForRequest,
} from "./lib/node-install-bridge.js";
import { OmaVaultResolver } from "@duyet/oma-cap-adapter";
import {
  buildCredentialCrypto,
  buildLabeledCrypto,
  FEDERATION_CRYPTO_LABEL,
  resolveFederationInstance,
  delegateToRemoteAgent as remoteAgentDelegate,
} from "@duyet/oma-shared";
import { NodeSessionRouter } from "./lib/node-session-router.js";
import { nodeOutputsAdapter } from "./lib/node-outputs-adapter.js";
import { nodeSessionLifecycle } from "./lib/node-session-lifecycle.js";
import { NodeWorkspaceBackupService } from "./lib/node-workspace-backup.js";
import { DefaultSandboxOrchestrator } from "@duyet/oma-sandbox/orchestrator";
import {
  createAuthMiddleware as buildAuthMw,
  type TrustedProxyGuardConfig,
} from "@duyet/oma-auth";
import {
  buildBetterAuth,
  ensureTenantSqlite,
  resolveTrustedProxyUser,
} from "@duyet/oma-auth-config";
import { BetterSqlite3SqlClient } from "@duyet/oma-sql-client/adapters/better-sqlite3";
import { senderFromEnv } from "@duyet/oma-email/adapters/nodemailer";
import { SqlKvStore } from "@duyet/oma-kv-store/adapters/sql";
import {
  selectBrowserHarness,
  buildSelectedBrowserHarness,
} from "@duyet/oma-browser-harness/select";
import type { BrowserHarness } from "@duyet/oma-browser-harness";
import { startMemoryBlobWatcher } from "./lib/memory-blob-watcher.js";
import { buildNodeScheduler } from "./lib/node-scheduler-jobs.js";
import type {
  ClaimedSchedule,
  RecordRunInput,
  ScheduledRunLauncher,
} from "@duyet/oma-scheduler/jobs/scheduled-agent-runs";
import type { ScheduledDeploymentRunLauncher } from "@duyet/oma-scheduler/jobs/scheduled-deployment-runs";
import { startNodeMemoryQueue } from "./lib/node-memory-queue.js";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, relative } from "node:path";
import { nanoid } from "nanoid";
import {
  InProcessEventStreamHub,
  type EventStreamHub,
} from "./lib/event-stream-hub";
import { PgEventStreamHub } from "./lib/pg-event-stream-hub";
import { NodeHarnessRuntime } from "./lib/node-harness-runtime";
import { selectHarnessName } from "./lib/harness-select";
import { resolveAgentModelBinding } from "./lib/claude-sdk-model";
import { SessionRegistry } from "./registry.js";
import {
  TelegramClient,
  InMemoryTelegramChatStore,
  TelegramAgentHandler,
} from "@duyet/oma-telegram";
import { NodeTelegramSessionCreator } from "./lib/node-telegram.js";
import { buildMemoryGates } from "@duyet/oma-rate-limit/adapters/memory";

// ─── Boot-time secret guard ──────────────────────────────────────────────
//
// .env.example used to ship prefilled values for PLATFORM_ROOT_SECRET,
// BETTER_AUTH_SECRET, API_KEY, and others (see oma#170) — an install that
// ran `cp .env.example .env` without editing those lines ends up sharing
// the exact same at-rest encryption key / session-signing key / bootstrap
// API key as every other such install, and as this public repo. Refuse to
// start rather than silently running with a publicly-known key. Runs
// before any DB/logger bootstrap so a bad checkout fails immediately.
const leakedSecrets = await findLeakedPlaceholderSecrets(
  process.env as Record<string, string | undefined>,
);
if (leakedSecrets.length > 0) {
  console.error(formatLeakedSecretError(leakedSecrets));
  process.exit(1);
}

const toMarkdownProvider = nodeToMarkdown();

// ─── Observability bootstrap ─────────────────────────────────────────────
//
// Logger is constructed first so every later step can use it instead of
// raw console.*. Metrics + tracer follow; both are no-ops by default and
// only spin up real backends when the env opts in.
//   - Prometheus metrics: always-on in-process registry; /metrics text
//     endpoint mounted below.
//   - OTel tracing: starts only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
const logger: Logger = await createNodeLogger({
  bindings: { service: "main-node", pid: process.pid },
});
setRootLogger(logger);

const metrics: NodeMetricsHandle = await createNodeMetricsRecorder();
const tracer: NodeTracerHandle = await createNodeTracer({
  serviceName: "oma-main-node",
});

// ─── Bootstrap ───────────────────────────────────────────────────────────

const dbUrl = process.env.DATABASE_URL ?? "";
const usePostgres = dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://");
const dialect = usePostgres ? "postgres" : "sqlite";

let sql: SqlClient;
let backendDescription: string;
// drizzleDb is the dependency-inversion seam new-style adapters take.
// Constructed once at the composition root from the right concrete driver.
// Existing SqlClient is still built alongside for the legacy applySchema /
// integrations adapters until those finish migrating.
import type { OmaDb } from "@duyet/oma-db-schema";
let drizzleDb: OmaDb<Record<string, unknown>>;
if (usePostgres) {
  sql = await createPostgresSqlClient(dbUrl);
  const { drizzle: drizzlePostgresJs } = await import("drizzle-orm/postgres-js");
  const postgresMod = (await import("postgres" as string)) as { default: (dsn: string) => unknown };
  const pgClient = postgresMod.default(dbUrl);
  drizzleDb = drizzlePostgresJs(pgClient as never) as unknown as OmaDb<Record<string, unknown>>;
  const u = new URL(dbUrl);
  backendDescription = `postgres ${u.hostname}:${u.port || 5432}${u.pathname}`;
} else {
  const dbPath = process.env.DATABASE_PATH ?? "./data/oma.db";
  mkdirSync(dirname(dbPath), { recursive: true });
  sql = await createBetterSqlite3SqlClient(dbPath);
  const { drizzle: drizzleBetterSqlite3 } = await import("drizzle-orm/better-sqlite3");
  const BetterSqlite3 = (await import("better-sqlite3")).default;
  const sqliteRaw = new BetterSqlite3(dbPath);
  // Match D1's runtime default — FK enforcement off. See packages/sql-client
  // for the rationale (publication-first install + a few other paths).
  sqliteRaw.exec("PRAGMA foreign_keys = OFF");
  drizzleDb = drizzleBetterSqlite3(sqliteRaw) as unknown as OmaDb<Record<string, unknown>>;
  backendDescription = `sqlite ${dbPath}`;
}

// Apply the consolidated baseline (Drizzle migrate runner — one folder per
// dialect, generated by `pnpm db:generate:node-{pg,sqlite}`). Replaces the
// pre-Drizzle applySchema / applyTenantSchema / applyIntegrationsSchema /
// applyMemoryPollerSchema chain — those creator functions hand-wrote
// CREATE TABLE IF NOT EXISTS and ad-hoc ALTER backfills, which had been
// drifting from the canonical CF migration files.
//
// session_events (event-log) is still its own concern: its idempotent
// ensureSchema lives in @duyet/oma-event-log/sql and runs after
// the baseline migration applies the rest.
const migrationsFolder = usePostgres
  ? new URL("../migrations", import.meta.url).pathname
  : new URL("../migrations-sqlite", import.meta.url).pathname;
if (usePostgres) {
  const { migrate } = await import("drizzle-orm/postgres-js/migrator");
  await migrate(drizzleDb as never, { migrationsFolder });
} else {
  const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
  migrate(drizzleDb as never, { migrationsFolder });
}
await ensureEventLogSchema(sql, dialect);

// PLATFORM_ROOT_SECRET is the at-rest encryption root for vault credentials
// (credentials.auth) and integrations OAuth tokens. The docs have always
// called it "required before first boot", and the CF deployment enforces
// that (buildServices throws) — the Node runtime silently booted without it
// and stored vault credentials in PLAINTEXT (issue #187). Fail closed,
// matching CF, rather than quietly writing secrets unencrypted.
const platformRootSecret = process.env.PLATFORM_ROOT_SECRET;
if (!platformRootSecret) {
  console.error(
    "Refusing to start: PLATFORM_ROOT_SECRET is not set.\n" +
      "It is required for at-rest encryption of vault credentials (and " +
      "integration OAuth tokens) — without it those secrets would be stored " +
      "in plaintext in the database.\n" +
      "Generate one with `openssl rand -base64 32`, set it in your .env / " +
      "docker compose environment, and back it up: losing it makes every " +
      "encrypted row unreadable.",
  );
  process.exit(1);
}

// ─── Auth ───────────────────────────────────────────────────────────────

const authDisabled = process.env.AUTH_DISABLED === "1";
const authDbPath = process.env.AUTH_DATABASE_PATH ?? "./data/auth.db";
const sender = senderFromEnv(process.env);

let auth: ReturnType<typeof buildBetterAuth> | null = null;
let authShutdown: (() => Promise<void>) | null = null;
// SqlClient scoped to wherever the better-auth "user" table actually
// lives: on Postgres that's the same physical database as the main `sql`
// client (different driver, same DSN); on sqlite it's a SEPARATE file
// (authDbPath) from the main store, so we need a client wired to that
// specific connection. Used by trusted-proxy auth's find-or-create below —
// stays null when auth is disabled (trusted-proxy auth is meaningless
// without better-auth's user table to resolve into).
let authUserSql: SqlClient | null = null;

// Shared onTenantCreated hook for every auth entry point (postgres,
// sqlite, trusted-proxy). Must stay a lazy closure: `agentsService` is
// declared further down and only exists by the time a tenant is actually
// created at request time.
const seedNewTenant = async (tenantId: string) => {
  await seedDefaultAgent(agentsService, tenantId);
};

if (!authDisabled) {
  if (usePostgres) {
    const { Pool } = (await import("pg")) as typeof import("pg");
    const pgPool = new Pool({ connectionString: dbUrl });
    await applyBetterAuthSchema({ sql, dialect: "postgres" });
    authUserSql = sql;
    auth = buildBetterAuth({
      database: pgPool,
      sender,
      secret: process.env.BETTER_AUTH_SECRET ?? randomFallback(),
      baseURL: process.env.PUBLIC_BASE_URL,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      githubClientId: process.env.GITHUB_CLIENT_ID,
      githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
      requireEmailVerify: process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1",
      cookieDomain: process.env.AUTH_COOKIE_DOMAIN,
      ensureTenant: (u) =>
        ensureTenantSqlite(sql, u.id, u.name, u.email, seedNewTenant),
    });
    authShutdown = async () => {
      await pgPool.end();
    };
  } else {
    mkdirSync(dirname(authDbPath), { recursive: true });
    const BetterSqlite3 = (await import("better-sqlite3")).default;
    const authDb = new BetterSqlite3(authDbPath);
    // Run the better-auth schema on the auth db via a thin SqlClient shim —
    // applyBetterAuthSchema only uses sql.exec which maps cleanly.
    await applyBetterAuthSchema({
      sql: betterSqliteAsSqlClient(authDb),
      dialect: "sqlite",
    });
    // Structural cast: better-sqlite3's real `Database.transaction<T>` return
    // type isn't structurally assignable to BetterSqlite3SqlClient's minimal
    // BS3Database interface (generic method variance) even though the two
    // are runtime-identical — same pattern createBetterSqlite3SqlClient
    // itself relies on via its own narrowed BS3Module type.
    authUserSql = new BetterSqlite3SqlClient(
      authDb as unknown as ConstructorParameters<typeof BetterSqlite3SqlClient>[0],
    );
    auth = buildBetterAuth({
      database: authDb,
      sender,
      secret: process.env.BETTER_AUTH_SECRET ?? randomFallback(),
      baseURL: process.env.PUBLIC_BASE_URL,
      googleClientId: process.env.GOOGLE_CLIENT_ID,
      googleClientSecret: process.env.GOOGLE_CLIENT_SECRET,
      githubClientId: process.env.GITHUB_CLIENT_ID,
      githubClientSecret: process.env.GITHUB_CLIENT_SECRET,
      requireEmailVerify: process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1",
      cookieDomain: process.env.AUTH_COOKIE_DOMAIN,
      ensureTenant: (u) =>
        ensureTenantSqlite(sql, u.id, u.name, u.email, seedNewTenant),
    });
    authShutdown = async () => {
      authDb.close();
    };
  }
}

// ─── Trusted reverse-proxy / SSO-gateway header auth (opt-in) ───────────
//
// Lets a reverse proxy / SSO gateway in front of this deployment (nginx,
// oauth2-proxy, Envoy/Istio ingress, etc.) hand us an already-authenticated
// identity via headers instead of making the user log in again. Default
// OFF and a true no-op when TRUSTED_PROXY_AUTH_ENABLED is unset — the
// `trustedProxy` dep below is simply never constructed, so the auth
// middleware never inspects the identity header at all.
//
// Threat model (see @duyet/oma-auth's trusted-proxy.ts for the
// full writeup): a header alone is never proof of anything — anyone who
// can reach this service directly could set it and impersonate any user.
// TRUSTED_PROXY_SHARED_SECRET is the mitigation: a value known only to the
// operator, injected by the trusted gateway on a second header on every
// request, that this app verifies (constant-time) before trusting the
// identity header. We fail closed and refuse to boot with the feature
// half-configured (enabled but no secret) rather than silently running in
// a permanently-rejecting state.
const trustedProxyConfig: TrustedProxyGuardConfig | null =
  process.env.TRUSTED_PROXY_AUTH_ENABLED === "1"
    ? {
        enabled: true,
        userHeader: process.env.TRUSTED_PROXY_HEADER ?? "X-Forwarded-User",
        emailHeader: process.env.TRUSTED_PROXY_EMAIL_HEADER,
        sharedSecretHeader:
          process.env.TRUSTED_PROXY_SHARED_SECRET_HEADER ?? "X-Trusted-Proxy-Secret",
        sharedSecret: process.env.TRUSTED_PROXY_SHARED_SECRET,
      }
    : null;

if (trustedProxyConfig && !trustedProxyConfig.sharedSecret) {
  throw new Error(
    "TRUSTED_PROXY_AUTH_ENABLED=1 requires TRUSTED_PROXY_SHARED_SECRET to be set " +
      "(a value known only to your reverse proxy / SSO gateway — see docs/self-host.md#trusted-reverse-proxy--sso-gateway-auth-opt-in)",
  );
}
if (trustedProxyConfig && authDisabled) {
  throw new Error(
    "TRUSTED_PROXY_AUTH_ENABLED=1 is incompatible with AUTH_DISABLED=1 " +
      "(trusted-proxy auth resolves identities into better-auth's user table, " +
      "which isn't provisioned when auth is disabled)",
  );
}

// ─── Stores ─────────────────────────────────────────────────────────────

const agentsService = createSqliteAgentService({ db: drizzleDb });
const vaultService = createSqliteVaultService({ db: drizzleDb });
// At-rest encryption for the credentials.auth column (issue #187) — same
// AES-GCM + "credentials.auth" label as the CF deployment's mintCrypto,
// with a read-side tolerance for legacy plaintext rows written before this
// wiring existed (see packages/shared/src/credential-crypto.ts; apps/
// oma-vault decrypts the same column with the same helper).
const credentialService = createSqliteCredentialService(
  { db: drizzleDb },
  { crypto: buildCredentialCrypto(platformRootSecret) },
);
const sessionsService = createSqliteSessionService({ db: drizzleDb });
const filesService = createSqliteFileService({ db: drizzleDb });
const evalsService = createSqliteEvalRunService({ db: drizzleDb });
const environmentsService = createSqliteEnvironmentService({ db: drizzleDb });
const publicationsService = createSqlitePublicationService({ db: drizzleDb });
// At-rest encryption for model_cards.api_key_cipher — same AES-GCM
// construction as the CF deployment's mintCrypto(env, "model.cards.keys")
// (packages/services/src/index.ts), just against PLATFORM_ROOT_SECRET
// directly instead of through that helper (Node has no per-store `env`
// object to mint from).
const modelCardsService = createSqliteModelCardService(
  { db: drizzleDb },
  { crypto: new WebCryptoAesGcm(platformRootSecret, "model.cards.keys") },
);

let memoryBlobs: import("@duyet/oma-memory-store").BlobStore;
let memoryBlobDescription: string;
let memoryBlobLocalDir: string | null = null;
let s3MemoryConfig: {
  endpoint: string;
  bucket: string;
  accessKey: string;
  secretKey: string;
  region: string;
} | null = null;

if (
  process.env.MEMORY_S3_ENDPOINT &&
  process.env.MEMORY_S3_BUCKET &&
  process.env.MEMORY_S3_ACCESS_KEY &&
  process.env.MEMORY_S3_SECRET_KEY
) {
  const { S3BlobStore } = await import(
    "@duyet/oma-memory-store/adapters/s3-blob"
  );
  s3MemoryConfig = {
    endpoint: process.env.MEMORY_S3_ENDPOINT,
    bucket: process.env.MEMORY_S3_BUCKET,
    accessKey: process.env.MEMORY_S3_ACCESS_KEY,
    secretKey: process.env.MEMORY_S3_SECRET_KEY,
    region: process.env.MEMORY_S3_REGION ?? "us-east-1",
  };
  memoryBlobs = new S3BlobStore({
    endpoint: s3MemoryConfig.endpoint,
    bucket: s3MemoryConfig.bucket,
    accessKeyId: s3MemoryConfig.accessKey,
    secretAccessKey: s3MemoryConfig.secretKey,
    region: s3MemoryConfig.region,
  });
  memoryBlobDescription = `s3 ${s3MemoryConfig.endpoint}/${s3MemoryConfig.bucket}`;
} else {
  memoryBlobLocalDir = process.env.MEMORY_BLOB_DIR ?? "./data/memory-blobs";
  memoryBlobs = new MemoryLocalFsBlobStore({ baseDir: memoryBlobLocalDir });
  memoryBlobDescription = `localfs ${memoryBlobLocalDir}`;
}

const memoryService = createSqliteMemoryStoreService({
  db: drizzleDb,
  blobs: memoryBlobs,
});
const dreamsService = createSqliteDreamService({
  client: sql,
  verifyMemoryStoreExists: async (tenantId, storeId) => {
    const row = await sql
      .prepare("SELECT 1 FROM memory_stores WHERE id = ? AND tenant_id = ?")
      .bind(storeId, tenantId)
      .first();
    return !!row;
  },
  verifySessionExists: async (tenantId, sessionId) => {
    const row = await sql
      .prepare("SELECT 1 FROM sessions WHERE id = ? AND tenant_id = ?")
      .bind(sessionId, tenantId)
      .first();
    return !!row;
  },
});
const memoryRepo = new SqlMemoryRepo(drizzleDb);
// Memory blob watcher — wires chokidar fs events through
// packages/queue's processMemoryEvent so CF + Node share one upsert
// code path. PG mode uses the multi-replica-safe PG queue table; SQLite
// single-instance uses an in-memory queue. Set MEMORY_QUEUE=disabled to
// skip wiring and fall back to the legacy direct-call watcher.
const useQueue = (process.env.MEMORY_QUEUE ?? "auto") !== "disabled";
const memoryWatcher = memoryBlobLocalDir && useQueue
  ? await startNodeMemoryQueue({
      mode: usePostgres ? "pg" : "in-memory",
      sql: usePostgres ? sql : undefined,
      memoryRepo,
      memoryBlobs,
      memoryRoot: memoryBlobLocalDir,
    })
  : memoryBlobLocalDir
    ? startMemoryBlobWatcher({ memoryRoot: memoryBlobLocalDir, memoryRepo })
    : { stop: async () => {} };

let s3Poller: { stop: () => Promise<void> } | null = null;
if (s3MemoryConfig) {
  // memory_blob_poller_lease lives in the consolidated baseline already; no
  // separate schema bootstrap needed here.
  const replicaId = `replica_${process.pid}_${Math.floor(Math.random() * 1e9).toString(36)}`;
  const intervalSec = Number(process.env.MEMORY_S3_POLL_INTERVAL_SEC ?? 30);
  const { startS3MemoryPoller } = await import("./lib/s3-memory-poller.js");
  s3Poller = await startS3MemoryPoller({
    sql,
    sqlDialect: dialect,
    memoryRepo,
    replicaId,
    intervalMs: Math.max(5_000, intervalSec * 1000),
    s3: s3MemoryConfig,
  });
}

const outputsRoot = process.env.SESSION_OUTPUTS_DIR ?? "./data/session-outputs";
mkdirSync(outputsRoot, { recursive: true });

// ─── Files-store blob backend ────────────────────────────────────────
//
// Keyed off FILES_S3_* env vars; falls back to a local-FS adapter under
// FILES_BLOB_DIR (default ./data/files-blobs). The blob store backs both
// the files-store table content AND workspace_backups tar archives —
// same single store, two key prefixes.

let filesBlob: BlobStore;
let filesBlobDescription: string;
if (
  process.env.FILES_S3_ENDPOINT &&
  process.env.FILES_S3_BUCKET &&
  process.env.FILES_S3_ACCESS_KEY &&
  process.env.FILES_S3_SECRET_KEY
) {
  filesBlob = new FilesS3BlobStore({
    endpoint: process.env.FILES_S3_ENDPOINT,
    bucket: process.env.FILES_S3_BUCKET,
    accessKeyId: process.env.FILES_S3_ACCESS_KEY,
    secretAccessKey: process.env.FILES_S3_SECRET_KEY,
    region: process.env.FILES_S3_REGION ?? "us-east-1",
  });
  filesBlobDescription = `s3 ${process.env.FILES_S3_ENDPOINT}/${process.env.FILES_S3_BUCKET}`;
} else {
  const filesBlobDir = process.env.FILES_BLOB_DIR ?? "./data/files-blobs";
  mkdirSync(filesBlobDir, { recursive: true });
  filesBlob = new FilesLocalFsBlobStore({ baseDir: filesBlobDir });
  filesBlobDescription = `localfs ${filesBlobDir}`;
}

const workspaceBackups = new NodeWorkspaceBackupService({
  sql,
  blobs: filesBlob,
});

const sandboxOrchestrator = new DefaultSandboxOrchestrator({
  backups: workspaceBackups,
});

// ─── Hub + event log ────────────────────────────────────────────────────

function newEventLog(sessionId: string): SqlEventLog {
  return new SqlEventLog(sql, sessionId, (e) => {
    const ev = e as SessionEvent & { id?: string; processed_at?: string };
    if (!ev.id) ev.id = `sevt_${generateEventId()}`;
    if (!ev.processed_at) ev.processed_at = new Date().toISOString();
  });
}

let hub: EventStreamHub;
if (usePostgres) {
  hub = await PgEventStreamHub.create({
    dsn: dbUrl,
    fetchEventsAfter: (sid, afterSeq) => newEventLog(sid).getEventsAsync(afterSeq),
  });
} else {
  hub = new InProcessEventStreamHub();
}

// ─── Sandbox provider registry ──────────────────────────────────────────
//
// Multi-provider sandbox registry. Supports:
//   - System providers seeded from env vars (SANDBOX_PROVIDER, etc.)
//   - User BYOK providers added via POST /v1/sandbox_providers
//   - Per-environment provider selection (environment config.sandbox_provider)
//   - Quota tracking (in-memory for OSS; CF node has its own billing)
//   - Dynamic provider management through the REST API

const sandboxRegistry = new SandboxProviderRegistry();
sandboxRegistry.seedFromEnv(process.env);

const sandboxQuota = new InMemoryQuotaStore();

export function getSandboxRegistry(): SandboxProviderRegistry {
  return sandboxRegistry;
}

export function getSandboxQuota(): InMemoryQuotaStore {
  return sandboxQuota;
}

// Resolve the sandbox provider for a session from its environment's
// config. First checks `config.sandbox_provider` (direct provider id),
// then `config.type` (legacy hosting type), then falls back to the
// global SANDBOX_PROVIDER default. Unknown types degrade gracefully
// to the default — a misconfigured env must not hard-fail a session.
// Thrown when a session's environment explicitly selects a sandbox provider
// that cannot run on the self-host Node runtime (a CF-only primitive such as
// "dynamic-workers"). Propagated out of resolveEnvProvider (past its
// fallback catch) so session start fails clearly instead of silently
// substituting a different sandbox.
class NodeIncompatibleProviderError extends Error {}

async function resolveEnvProvider(sessionId: string): Promise<string | null> {
  try {
    const row = await sql
      .prepare(`SELECT tenant_id, environment_id FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ tenant_id: string; environment_id: string | null }>();
    if (!row?.environment_id) return null;
    const env = await environmentsService.get({
      tenantId: row.tenant_id,
      environmentId: row.environment_id,
    });
    if (!env?.config) return null;

    // Direct provider id reference (new API)
    if (env.config.sandbox_provider) {
      const pid = env.config.sandbox_provider;
      // A CF-only primitive (e.g. "dynamic-workers", which needs the Worker
      // Loader binding) has no Node equivalent. Fail clearly rather than
      // silently degrading to SANDBOX_PROVIDER — the inverse of how a
      // Node-only provider fails on the Cloudflare deployment. This throws
      // past resolveEnvProvider's fallback catch (see the rethrow there) so
      // it surfaces as a session error.
      const desc = SYSTEM_PROVIDERS.find((d) => d.type === pid.toLowerCase());
      if (desc && desc.nodeCompatible === false) {
        throw new NodeIncompatibleProviderError(
          `sandbox_provider="${pid}" is a Cloudflare-only primitive and is not available on the ` +
            `self-host Node runtime — use a Node-capable provider (subprocess / boxrun / k8s / e2b / daytona).`,
        );
      }
      if (sandboxRegistry.get(pid)) return pid;
      logger.warn(
        { op: "main-node.sandbox.unknown_provider_id", session_id: sessionId, provider_id: pid },
        `environment sandbox_provider="${pid}" is not registered; falling back to SANDBOX_PROVIDER`,
      );
    }

    // Legacy type-based selection
    const type = env.config.type?.toLowerCase();
    if (!type || type === "cloud" || type === "environment") return null;
    if (sandboxRegistry.get(type)) return type;
    logger.warn(
      { op: "main-node.sandbox.unknown_env_type", session_id: sessionId, config_type: type },
      `environment config.type=${type} is not a known sandbox provider; falling back to SANDBOX_PROVIDER`,
    );
    return null;
  } catch (err) {
    // A Cloudflare-only provider selection must fail loud, not degrade.
    if (err instanceof NodeIncompatibleProviderError) throw err;
    logger.warn(
      { err, op: "main-node.sandbox.env_provider_resolve_failed", session_id: sessionId },
      "failed to resolve per-environment sandbox provider; falling back to SANDBOX_PROVIDER",
    );
    return null;
  }
}

// Auto-detect a reachable OpenShell gateway for the *implicit* default
// sandbox provider — i.e. only when neither the session's environment nor
// SANDBOX_PROVIDER pin a provider explicitly. Historically that implicit
// default was hardcoded to "subprocess"; now it prefers OpenShell when
// OPENSHELL_GATEWAY_ENDPOINT is configured and currently reachable.
// Overridable via OPENSHELL_MODE=auto|openshell|subprocess (see
// resolveDefaultLocalSandboxProvider). The reachability probe is real
// network I/O, so the decision is computed once (lazily, on first use)
// and cached for the process lifetime rather than re-probed per session.
let defaultLocalSandboxProviderPromise: Promise<string> | null = null;
function getDefaultLocalSandboxProvider(): Promise<string> {
  if (!defaultLocalSandboxProviderPromise) {
    defaultLocalSandboxProviderPromise = (async () => {
      const { probeOpenShellGateway, resolveOpenShellTlsFromEnv } = await import(
        "@duyet/oma-sandbox/adapters/openshell"
      );
      const tls = resolveOpenShellTlsFromEnv(process.env);
      const decision = await resolveDefaultLocalSandboxProvider(process.env, (endpoint) =>
        probeOpenShellGateway(endpoint, tls),
      );
      logger.info(
        { op: "main-node.sandbox.default_provider", provider_id: decision.providerId, reason: decision.reason },
        `default sandbox provider: ${decision.providerId} (${decision.reason})`,
      );
      return decision.providerId;
    })();
  }
  return defaultLocalSandboxProviderPromise;
}

// Load a session's environment `config` (networking/packages/...) so sandbox
// adapters that translate it downstream (OpenShell → SandboxPolicy) can. Best
// effort: any failure returns undefined and the adapter proceeds without it.
async function getSessionEnvConfig(
  sessionId: string,
): Promise<import("@duyet/oma-sandbox").SandboxFactoryContext["environmentConfig"] | undefined> {
  try {
    const row = await sql
      .prepare(`SELECT tenant_id, environment_id FROM sessions WHERE id = ?`)
      .bind(sessionId)
      .first<{ tenant_id: string; environment_id: string | null }>();
    if (!row?.environment_id) return undefined;
    const env = await environmentsService.get({
      tenantId: row.tenant_id,
      environmentId: row.environment_id,
    });
    return env?.config as import("@duyet/oma-sandbox").SandboxFactoryContext["environmentConfig"];
  } catch {
    return undefined;
  }
}

async function buildSandbox(
  sessionId: string,
  workdir: string,
): Promise<import("@duyet/oma-sandbox").SandboxExecutor> {
  const envProvider = await resolveEnvProvider(sessionId);
  const providerId = (
    envProvider ?? process.env.SANDBOX_PROVIDER ?? (await getDefaultLocalSandboxProvider())
  ).toLowerCase();

  const environmentConfig = await getSessionEnvConfig(sessionId);

  const sandbox = await sandboxRegistry.createExecutor(
    providerId,
    { sessionId, workdir, memoryRoot: memoryBlobLocalDir ?? "", outputsRoot, environmentConfig },
    process.env,
  );

  // Record usage for quota tracking
  sandboxQuota.record({
    providerId,
    tenantId: "", // filled in by the caller
    sessionId,
    action: "session_start",
    timestamp: new Date().toISOString(),
  });

  return sandbox;
}

// ─── Sandbox GC (startup-only) ──────────────────────────────────────────
//
// A main-node crash/restart mid-session skips destroy(), and the
// agent-sandbox controller applies no TTL to a failed Sandbox CR — it (and
// its dead pod) sit forever. Sweep once at boot, the same moment a
// crash-induced orphan would exist. Fire-and-forget: must never delay the
// HTTP listener or take main-node down if the cluster call fails.
if (["k8s", "kubernetes"].includes((process.env.SANDBOX_PROVIDER ?? "").toLowerCase())) {
  import("@duyet/oma-sandbox/adapters/kubernetes")
    .then((mod) =>
      mod.sweepOrphanedSandboxes({
        namespace: process.env.OMA_K8S_NAMESPACE,
        logger: {
          warn: (msg, ctx) => logger.warn((ctx as Record<string, unknown>) ?? {}, msg),
          log: (msg) => logger.info(msg),
        },
      }),
    )
    .then((result) => {
      if (result.deleted.length || result.errors.length) {
        logger.info({ op: "main-node.sandbox_gc", ...result }, "sandbox GC swept orphaned Sandbox CRs");
      }
    })
    .catch((err) => logger.warn({ op: "main-node.sandbox_gc.failed", err }, "sandbox GC sweep failed"));
}

// ─── Session registry ───────────────────────────────────────────────────

// An OAuth-connected AnyRouter credential (Console "Connect to AnyRouter"
// button → packages/http-routes providers/anyrouter.ts) takes priority over
// the static env vars below — it's the same "one active provider for this
// node" model, just populated at runtime instead of deploy time. Shared by
// buildModel/buildTools/buildHarnessContext so all three agree on which
// provider is active. Falls back to ANTHROPIC_API_KEY/ANTHROPIC_BASE_URL
// when nothing is connected.
//
// `agent` is optional and only consulted for the CLAUDE_CODE_OAUTH_TOKEN
// carve-out below — every other harness (Default) still hard-requires
// ANTHROPIC_API_KEY, since only ClaudeAgentSdkHarness's CLI subprocess can
// authenticate with the OAuth token instead.
function resolveProviderCreds(
  agent?: { metadata?: Record<string, unknown> },
): { apiKey: string; baseUrl: string | undefined } {
  const anyrouter = getActiveAnyRouterProvider();
  if (anyrouter) return { apiKey: anyrouter.apiKey, baseUrl: anyrouter.baseUrl };
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) return { apiKey, baseUrl: process.env.ANTHROPIC_BASE_URL };

  // ClaudeAgentSdkHarness authenticates its CLI subprocess directly via
  // CLAUDE_CODE_OAUTH_TOKEN (see claude-agent-sdk-loop.ts's
  // resolveClaudeSdkAuth) instead of the ai-sdk ANTHROPIC_API_KEY path every
  // other harness needs — so it alone may boot with an empty apiKey here
  // when that token is set. buildHarnessContext below threads the token
  // itself into ctx.env; buildModel/buildTools never use this empty-string
  // result because ClaudeAgentSdkHarness ignores ctx.model/ctx.tools.
  if (
    selectHarnessName(agent?.metadata?.harness, process.env.DEFAULT_HARNESS) === "claude-agent-sdk" &&
    process.env.CLAUDE_CODE_OAUTH_TOKEN
  ) {
    return { apiKey: "", baseUrl: process.env.ANTHROPIC_BASE_URL };
  }

  // Same escape for the "poolside" harness: it resolves its own
  // OpenAI-compatible model from POOLSIDE_API_KEY/POOLSIDE_BASE_URL inside
  // run() and never reads ctx.model, so an Anthropic key is not required.
  if (
    selectHarnessName(agent?.metadata?.harness, process.env.DEFAULT_HARNESS) === "poolside" &&
    process.env.POOLSIDE_API_KEY
  ) {
    return { apiKey: "", baseUrl: undefined };
  }

  throw new Error(
    "ANTHROPIC_API_KEY env var required for harness turns (or connect AnyRouter via the Console, " +
      "or set CLAUDE_CODE_OAUTH_TOKEN for a claude-agent-sdk agent, " +
      "or POOLSIDE_API_KEY for a poolside agent)",
  );
}

// Built here (rather than down in the services bundle) because
// sessionRegistry's buildTools callback below needs it — the mcp_servers
// registry (KV-backed) and the MCP proxy share the same store.
const kv = new SqlKvStore({ db: drizzleDb, tenantId: "default" });

// Node counterpart to the CF agent worker's `env.MAIN_MCP` service binding
// — resolves vault credentials + forwards to the upstream MCP server
// in-process instead of over an RPC. See mcp-proxy.ts for the full
// resolution rules.
const nodeMcpBinding = buildNodeMcpBinding({
  sessions: sessionsService,
  credentials: credentialService,
  kv,
});

const sessionRegistry = new SessionRegistry({
  sql,
  hub,
  agentsService,
  memoryService,
  sandboxOrchestrator,
  newEventLog,
  buildSandbox,
  sandboxWorkdirRoot: process.env.SANDBOX_WORKDIR ?? "./data/sandboxes",
  sqlDialect: dialect,
  buildModel: (agent) => {
    const anyrouter = getActiveAnyRouterProvider();
    if (anyrouter) {
      return resolveModel(agent.model, anyrouter.apiKey, anyrouter.baseUrl, anyrouter.compat);
    }
    const { apiKey, baseUrl } = resolveProviderCreds(agent);
    // OMA_API_COMPAT selects the wire format for every model on this node
    // self-host (which has no D1 model cards to choose per-model). Set it to
    // "oai"/"oai-compatible" to talk to an OpenAI-compatible gateway
    // (e.g. AnyRouter /chat/completions) instead of the Anthropic /messages
    // default. Unset → undefined → "ant" (unchanged behavior).
    const apiCompat = process.env.OMA_API_COMPAT as
      | "ant"
      | "ant-compatible"
      | "oai"
      | "oai-compatible"
      | undefined;
    return resolveModel(
      agent.model,
      apiKey,
      baseUrl,
      apiCompat,
      parseCustomHeaders(process.env.ANTHROPIC_CUSTOM_HEADERS),
    );
  },
  buildTools: async (agent, sandbox, ctx) => {
    const { apiKey, baseUrl } = resolveProviderCreds(agent);
    return buildTools(agent, sandbox, {
      ANTHROPIC_API_KEY: apiKey,
      ANTHROPIC_BASE_URL: baseUrl,
      WEB_FETCH_ALLOW_PRIVATE: process.env.WEB_FETCH_ALLOW_PRIVATE,
      toMarkdown: toMarkdownProvider,
      mcpBinding: nodeMcpBinding,
      tenantId: ctx.tenantId,
      sessionId: ctx.sessionId,
      // Cross-instance federation delegate (issue #132) — resolves a
      // registered remote instance (base URL + API key) directly off KV +
      // crypto and drives the remote session to idle. Requires
      // PLATFORM_ROOT_SECRET to decrypt the stored key.
      delegateToRemoteAgent: platformRootSecret
        ? async (instanceId, remoteAgentId, message, remoteEnvironmentId) => {
            const crypto = buildLabeledCrypto(platformRootSecret, FEDERATION_CRYPTO_LABEL);
            const target = await resolveFederationInstance(kv, crypto, ctx.tenantId, instanceId);
            if (!target) throw new Error(`federation instance ${instanceId} not found`);
            const { text } = await remoteAgentDelegate(
              { base_url: target.base_url, api_key: target.api_key },
              { remoteAgentId, message, remoteEnvironmentId },
            );
            return text;
          }
        : undefined,
    });
  },
  buildHarness: () => {
    // Route per-turn by the agent marker so OMA can manage a Claude Agent SDK
    // agent as a harness (metadata.harness === "claude-agent-sdk" or
    // _oma.harness). HarnessContext carries the agent, so selection happens at
    // run() time with no registry/interface change. Node only invokes run()
    // (compaction etc. are the harness's own concern), so a {run} wrapper is
    // sufficient.
    //
    // ClaudeAgentSdkHarness is wired here — and ONLY here, not in
    // apps/agent/src/index.ts's CF-worker harness registry — because
    // @anthropic-ai/claude-agent-sdk spawns Claude Code's CLI as a native
    // subprocess, which requires child_process spawning and a real
    // filesystem unavailable inside a Cloudflare Workers isolate. See the
    // module-level jsdoc on claude-agent-sdk-loop.ts for the full
    // rationale.
    const def = new DefaultHarness();
    const claudeAgentSdk = new ClaudeAgentSdkHarness();
    // PoolsideHarness is plain-fetch (OpenAI-compatible) with no node
    // builtins, so unlike claude-agent-sdk it is ALSO registered on the CF
    // worker registry (apps/agent/src/index.ts). It is wired here too
    // because main-node routes harnesses through this switch rather than
    // through that registry.
    const poolside = new PoolsideHarness();
    return {
      run: (ctx: unknown) => {
        const c = ctx as HarnessContext;
        const meta = (c.agent as { metadata?: Record<string, unknown> })?.metadata;
        const harnessName = selectHarnessName(meta?.harness, process.env.DEFAULT_HARNESS);
        if (harnessName === "claude-agent-sdk") return claudeAgentSdk.run(c);
        if (harnessName === "poolside") return poolside.run(c);
        return def.run(c);
      },
    };
  },
  buildHarnessContext: async (input) => {
    const { apiKey, baseUrl } = resolveProviderCreds(input.agent);
    // Per-agent model + provider for the claude-agent-sdk harness (issue
    // #316): resolve the agent's model card into a binding the harness maps
    // onto its CLI subprocess env. Only that harness consumes it; every
    // other harness still routes through buildModel's process-global
    // provider, so this is a no-op for them. A null binding (no card, or a
    // lookup failure) leaves the pre-#316 global-env behavior untouched.
    const harnessName = selectHarnessName(
      (input.agent as { metadata?: Record<string, unknown> })?.metadata?.harness,
      process.env.DEFAULT_HARNESS,
    );
    const modelProvider =
      harnessName === "claude-agent-sdk"
        ? ((await resolveAgentModelBinding({
            modelCards: modelCardsService,
            tenantId: input.tenantId,
            agent: input.agent as { model?: string | { id?: string }; metadata?: Record<string, unknown> },
            logger: { warn: (ctx, msg) => logger.warn(ctx, msg) },
          })) ?? undefined)
        : undefined;
    const runtime = new NodeHarnessRuntime({
      sessionId: input.sessionId,
      log: input.eventLog,
      hub,
      sandbox: input.sandbox,
    });
    await runtime.refreshHistory();
    const rawSystemPrompt = input.agent.system ?? "";
    return {
      agent: input.agent,
      userMessage: input.userMessage,
      session_id: input.sessionId,
      tools: input.tools as HarnessContext["tools"],
      model: input.model,
      systemPrompt: composeSystemPrompt(rawSystemPrompt),
      rawSystemPrompt,
      env: {
        ANTHROPIC_API_KEY: apiKey,
        ANTHROPIC_BASE_URL: baseUrl,
        CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
        ...(modelProvider ? { modelProvider } : {}),
      },
      runtime,
    } satisfies HarnessContext;
  },
});

await sessionRegistry.bootstrap();

// Warm the AnyRouter provider cache from any credential a previous connect
// already persisted, so a restart doesn't silently fall back to env vars
// until the next OAuth round-trip.
await loadActiveAnyRouterProvider({ sql, vaults: vaultService, credentials: credentialService });

// ─── Services bundle ────────────────────────────────────────────────────

const services: RouteServices = {
  sql,
  agents: agentsService,
  vaults: vaultService,
  credentials: credentialService,
  memory: memoryService,
  sessions: sessionsService,
  dreams: dreamsService,
  environments: environmentsService,
  publications: publicationsService,
  modelCards: modelCardsService,
  filesBlob,
  kv,
  newEventLog,
  hub: {
    publish: (sid, ev) => hub.publish(sid, ev as SessionEvent),
    attach: (sid, writer) => hub.attach(sid, writer),
  },
  sessionRegistry: {
    enqueueUserMessage: (sid, tenantId, agentId, ev) => {
      void sessionRegistry
        .getOrCreate(sid, tenantId)
        .then((entry) =>
          entry.machine.runHarnessTurn(agentId, ev as import("@duyet/oma-shared").UserMessageEvent),
        )
        .catch((err) => {
          logger.error(
            { err, op: "session.harness_turn.failed", session_id: sid, agent_id: agentId },
            "harness turn failed",
          );
          void newEventLog(sid).appendAsync({
            type: "session.error",
            error: "harness_turn_failed",
            message: err instanceof Error ? err.message : String(err),
          } as unknown as SessionEvent);
        });
    },
    interrupt: (sid) => {
      sessionRegistry.interrupt?.(sid);
    },
  },
  background: {
    run: (p) => {
      void p.catch((err) =>
        logger.error({ err, op: "main-node.background.failed" }, "background task failed"),
      );
    },
  },
  outputsRoot,
  logger,
  metrics,
  tracer,
};

// ─── API key storage (SQL) ──────────────────────────────────────────────

const apiKeyStorage: ApiKeyStorage = {
  async insert({ id, hash, prefix, record }) {
    await sql
      .prepare(
        `INSERT INTO api_keys (id, tenant_id, user_id, name, prefix, hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id,
        record.tenant_id,
        record.user_id ?? null,
        record.name,
        prefix,
        hash,
        Date.parse(record.created_at),
      )
      .run();
  },
  async listByTenant(tenantId) {
    const r = await sql
      .prepare(
        `SELECT id, name, prefix, created_at FROM api_keys
          WHERE tenant_id = ? AND revoked_at IS NULL
          ORDER BY created_at DESC`,
      )
      .bind(tenantId)
      .all<{ id: string; name: string; prefix: string; created_at: number }>();
    return (r.results ?? []).map<ApiKeyMeta>((row) => ({
      id: row.id,
      name: row.name,
      prefix: row.prefix,
      created_at: new Date(row.created_at).toISOString(),
    }));
  },
  async findByHash(hash) {
    const row = await sql
      .prepare(
        `SELECT id, tenant_id, user_id, name, created_at FROM api_keys
          WHERE hash = ? AND revoked_at IS NULL`,
      )
      .bind(hash)
      .first<{
        id: string;
        tenant_id: string;
        user_id: string | null;
        name: string;
        created_at: number;
      }>();
    if (!row) return null;
    const rec: ApiKeyRecord = {
      id: row.id,
      tenant_id: row.tenant_id,
      ...(row.user_id ? { user_id: row.user_id } : {}),
      name: row.name,
      created_at: new Date(row.created_at).toISOString(),
    };
    return rec;
  },
  async deleteById(tenantId, id) {
    const r = await sql
      .prepare(
        `UPDATE api_keys SET revoked_at = ? WHERE tenant_id = ? AND id = ? AND revoked_at IS NULL`,
      )
      .bind(Date.now(), tenantId, id)
      .run();
    return (r.meta?.changes ?? 0) > 0;
  },
};

// ─── HTTP ───────────────────────────────────────────────────────────────

const app = new Hono<{
  Variables: { tenant_id: string; user_id?: string };
}>();

// Observability middleware first so it captures auth failures, rate-limit
// rejects, and unhandled exceptions. Mirrors apps/main's CF wiring.
app.use("*", requestMetrics({ recorder: metrics }));
app.use("*", tracerMiddleware({ tracer }));

// Prometheus scrape endpoint. When METRICS_BIND_TOKEN is set, callers must
// pass it in `x-metrics-token`; absent, the endpoint is open on the same
// port (acceptable for self-host single-operator deploys, documented in
// .env.example). For prod, ops should either set the token or front the
// app with a reverse proxy that filters /metrics.
const metricsToken = process.env.METRICS_BIND_TOKEN;
app.get("/metrics", async (c) => {
  if (metricsToken && c.req.header("x-metrics-token") !== metricsToken) {
    return c.text("forbidden", 403);
  }
  const text = await metrics.getPromText();
  return new Response(text, {
    headers: { "Content-Type": metrics.promContentType() },
  });
});

app.get("/health", (c) =>
  c.json({
    status: "ok",
    runtime: "node",
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    auth: authDisabled
      ? "disabled"
      : usePostgres
        ? "better-auth-pg"
        : "better-auth-sqlite",
    backends: {
      agents: dialect,
      events: dialect,
      hub: usePostgres ? "pg-notify" : "in-process",
      memory_blobs: memoryBlobDescription,
      db: backendDescription,
    },
  }),
);

app.get("/auth-info", (c) =>
  c.json({
    providers: authDisabled
      ? []
      : [
          "email",
          ...(process.env.AUTH_REQUIRE_EMAIL_VERIFY === "1" ? ["email-otp"] : []),
          ...(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
            ? ["google"]
            : []),
          ...(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET
            ? ["github"]
            : []),
        ],
    turnstile_site_key: null,
  }),
);

if (auth) {
  app.on(["GET", "POST"], "/auth/*", (c) => auth!.handler(c.req.raw));
}

// Auth middleware via packages/auth — same core resolution as apps/main on
// CF (API key → cookie session), plus opt-in trusted-proxy header auth
// (Node/self-host only for now — see the env var block above).
const authMw = buildAuthMw({
  disabled: authDisabled,
  // Bootstrap key for first-run / CLI use before any api_keys row exists —
  // mirrors the env.API_KEY compat check apps/main has always had on CF
  // (see oma#168). Optional: unset (the .env.example default) means this
  // check never matches and x-api-key falls straight through to the
  // api_keys table lookup below, same as before this existed.
  bootstrapApiKey: process.env.API_KEY || undefined,
  bypassPath: (path) =>
    path === "/health" ||
    path.startsWith("/auth/") ||
    // Consumer (end-user) auth realm — issue #226. A consumer never holds a
    // tenant API key, so /v1/public/* must not be gated by authMw. It lives
    // under /v1 (matching CF's URL surface) but is mounted separately, and
    // `v1.use("*", authMw)` would otherwise 401 every guest/magic-link
    // request before the public handler ever ran.
    //
    // The trailing slash is load-bearing: "/v1/public/" must NOT match the
    // tenant-authed creator route "/v1/publications".
    path.startsWith("/v1/public/") ||
    // OMA's own MCP server (issue #199) — Bearer-token auth, resolves the
    // tenant itself via forwarded subrequests. Mounted on `app` (not `v1`)
    // so this bypass keeps authMw from 401ing the Bearer-only request.
    path === "/v1/mcp" ||
    path === "/v1/device/code" ||
    path === "/v1/device/token" ||
    path === "/v1/oma/device/code" ||
    path === "/v1/oma/device/token" ||
    // CLI telemetry — public, unauthenticated, IP-rate-limited (buildTelemetryRoutes).
    path === "/v1/telemetry/events" ||
    path === "/v1/telemetry/ingest" ||
    path === "/v1/telemetry/stats",
  resolveSession: async (headers) => {
    if (!auth) return null;
    const session = (await auth.api.getSession({ headers })) as
      | { user?: { id: string; email?: string | null; name?: string | null } }
      | null;
    if (!session?.user) return null;
    return {
      userId: session.user.id,
      email: session.user.email ?? null,
      name: session.user.name ?? null,
    };
  },
  resolveApiKey: async (apiKey) => {
    const hash = await sha256Hex(apiKey);
    const rec = await apiKeyStorage.findByHash(hash);
    if (!rec) return null;
    return { tenantId: rec.tenant_id, userId: rec.user_id };
  },
  defaultTenantForUser: async (userId) => {
    const row = await sql
      .prepare(
        `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
      )
      .bind(userId)
      .first<{ tenant_id: string }>();
    return row?.tenant_id ?? null;
  },
  hasMembership: async (userId, tenantId) => {
    const row = await sql
      .prepare(
        `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      )
      .bind(userId, tenantId)
      .first<{ one: number }>();
    return row !== null;
  },
  ensureTenantForUser: (s) =>
    ensureTenantSqlite(sql, s.userId, s.name, s.email, seedNewTenant),
  ...(trustedProxyConfig && authUserSql
    ? {
        trustedProxy: {
          config: trustedProxyConfig,
          resolve: async (identity) => {
            const resolved = await resolveTrustedProxyUser(authUserSql!, dialect, identity);
            return { userId: resolved.userId, email: resolved.email, name: resolved.name };
          },
        },
      }
    : {}),
});

const v1 = new Hono<{
  Variables: { tenant_id: string; user_id?: string };
}>();
v1.use("*", authMw);

// CLI telemetry — public rate limiting bucket (issue #269 item 5). Separate
// gates instance from publicSessionCapGates/consumerRateLimitGates (defined
// later in this file) since this is needed at mount time, above.
const telemetryGates = buildMemoryGates();

// Mount route bundles. Same paths CF uses; behavior preserved.
v1.route("/agents", buildAgentRoutes({ services }));
// Agent schedules CRUD (issue #262) — shared http-routes builder, mounted on
// the same /agents prefix (CF mounts it the same way). Node's control-plane
// DB is the single `sql` client — agent_schedules lives there.
v1.route("/agents", buildScheduleRoutes({ db: sql }));
// Tenant-wide schedule list — cross-agent read for the Kanban board.
v1.route("/schedules", buildTenantScheduleRoutes({ db: sql }));
// Published-agent management API (issue #72) — tenant-authed CRUD backing
// the public /p/:slug chat surface. Runtime-neutral (only needs `services`),
// mirroring apps/main's mounts at the same paths (issue #226).
v1.route("/agents/:id/publications", buildAgentPublicationRoutes({ services }, "id"));
v1.route("/publications", buildPublicationRoutes({ services }));
const sessionRouter = new NodeSessionRouter({
  sql,
  hub,
  registry: sessionRegistry,
  newEventLog,
});
v1.route("/sessions", buildSessionRoutes({
  services,
  router: sessionRouter,
  outputs: nodeOutputsAdapter(outputsRoot),
  lifecycle: nodeSessionLifecycle({ files: filesService, filesBlob }),
  // environment_id is always required now (harness-to-environment
  // migration) — resolve the real environment row so a bogus/missing id
  // 404s instead of session-create silently synthesizing a placeholder.
  loadEnvironment: async ({ tenantId, environmentId }) => {
    const row = await environmentsService.get({ tenantId, environmentId });
    return row ? toEnvironmentConfig(row) : null;
  },
}));
v1.route("/vaults", buildVaultRoutes({ services }));
v1.route("/mcp_servers", buildMcpServerRoutes({ services }));
v1.route(
  "/federation",
  buildFederationRoutes({
    services,
    crypto: platformRootSecret
      ? buildLabeledCrypto(platformRootSecret, FEDERATION_CRYPTO_LABEL)
      : undefined,
  }),
);
v1.route("/analytics", buildAnalyticsRoutes({ services }));
v1.route(
  "/telemetry",
  buildTelemetryRoutes({
    services,
    rateLimit: async (c) => {
      const ip =
        c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || "anonymous";
      const r = await telemetryGates.apiWrite.consume(`tel:${ip}`);
      return !r.ok;
    },
  }),
);
v1.route("/memory_stores", buildMemoryRoutes({ services }));
v1.route("/dreams", buildDreamRoutes({
  services,
  curatorEnv: {
    DREAM_CURATOR_MODE: process.env.DREAM_CURATOR_MODE,
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
    ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  },
}));
v1.route("/me", buildMeRoutes({
  services,
  authDisabled,
  loadTenant: async (tenantId) => {
    const r = await sql
      .prepare(`SELECT id, name FROM "tenant" WHERE id = ?`)
      .bind(tenantId)
      .first<{ id: string; name: string }>();
    return r ?? null;
  },
  listMemberships: async (userId) => {
    const r = await sql
      .prepare(
        `SELECT t.id AS id, t.name AS name, m.role AS role, m.created_at AS created_at
           FROM "membership" m JOIN "tenant" t ON t.id = m.tenant_id
          WHERE m.user_id = ? ORDER BY m.created_at ASC, t.id ASC`,
      )
      .bind(userId)
      .all<{ id: string; name: string; role: string; created_at: number }>();
    return r.results ?? [];
  },
  hasMembership: async (userId, tenantId) => {
    const row = await sql
      .prepare(
        `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      )
      .bind(userId, tenantId)
      .first<{ one: number }>();
    return row !== null;
  },
  mintApiKey: (input) => mintApiKeyOnStorage(apiKeyStorage, input),
}));
v1.route("/tenants", buildTenantRoutes({ services }));

// Tenant teammate invites (issue #175). Invites + membership live in the main
// `sql`; the better-auth `user` table (emails) lives in `authUserSql` (a
// separate sqlite file, or the same PG db). Membership timestamps are ms,
// matching this runtime's other membership writes.
const nodeInviteDeps: InviteRoutesDeps = {
  authDisabled,
  getRole: async (userId, tenantId) => {
    const r = await sql
      .prepare("SELECT role FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1")
      .bind(userId, tenantId)
      .first<{ role: string }>();
    return r?.role ?? null;
  },
  getUserEmail: async (userId) => {
    if (!authUserSql) return null;
    const r = await authUserSql
      .prepare('SELECT email FROM "user" WHERE id = ? LIMIT 1')
      .bind(userId)
      .first<{ email: string }>();
    return r?.email ?? null;
  },
  listMembers: async (tenantId) => {
    const rows = await sql
      .prepare(
        `SELECT user_id, role, created_at FROM membership
          WHERE tenant_id = ? ORDER BY created_at ASC, user_id ASC`,
      )
      .bind(tenantId)
      .all<{ user_id: string; role: string; created_at: number }>();
    const members = rows.results ?? [];
    // Emails live in a different connection — resolve them per-member (member
    // lists are tiny). Missing email (auth disabled) degrades to null.
    return Promise.all(
      members.map(async (m) => {
        let email: string | null = null;
        let name: string | null = null;
        if (authUserSql) {
          const u = await authUserSql
            .prepare('SELECT email, name FROM "user" WHERE id = ? LIMIT 1')
            .bind(m.user_id)
            .first<{ email: string; name: string | null }>();
          email = u?.email ?? null;
          name = u?.name ?? null;
        }
        return { user_id: m.user_id, email, name, role: m.role, created_at: m.created_at };
      }),
    );
  },
  createInvite: async (rec) => {
    await sql
      .prepare(
        `INSERT INTO tenant_invites
           (id, tenant_id, email, role, status, token, invited_by, created_at, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`,
      )
      .bind(rec.id, rec.tenant_id, rec.email, rec.role, rec.token, rec.invited_by, rec.created_at, rec.expires_at)
      .run();
  },
  listInvites: async (tenantId, opts) => {
    const rows = opts.after
      ? await sql
          .prepare(
            `SELECT * FROM tenant_invites
              WHERE tenant_id = ? AND status = 'pending'
                AND (created_at < ? OR (created_at = ? AND id < ?))
              ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .bind(tenantId, opts.after.createdAt, opts.after.createdAt, opts.after.id, opts.limit + 1)
          .all()
      : await sql
          .prepare(
            `SELECT * FROM tenant_invites
              WHERE tenant_id = ? AND status = 'pending'
              ORDER BY created_at DESC, id DESC LIMIT ?`,
          )
          .bind(tenantId, opts.limit + 1)
          .all();
    const items = (rows.results ?? []) as unknown as import("@duyet/oma-http-routes").InviteRecord[];
    const hasMore = items.length > opts.limit;
    return { items: items.slice(0, opts.limit), hasMore };
  },
  findPendingByEmail: async (tenantId, email) => {
    const r = await sql
      .prepare(
        `SELECT * FROM tenant_invites
          WHERE tenant_id = ? AND email = ? AND status = 'pending' AND expires_at > ?
          LIMIT 1`,
      )
      .bind(tenantId, email, Date.now())
      .first();
    return (r as unknown as import("@duyet/oma-http-routes").InviteRecord) ?? null;
  },
  revokeInvite: async (tenantId, id) => {
    const before = await sql
      .prepare("SELECT 1 AS one FROM tenant_invites WHERE id = ? AND tenant_id = ? AND status = 'pending'")
      .bind(id, tenantId)
      .first<{ one: number }>();
    if (!before) return false;
    await sql
      .prepare("UPDATE tenant_invites SET status = 'revoked' WHERE id = ? AND tenant_id = ?")
      .bind(id, tenantId)
      .run();
    return true;
  },
  getByToken: async (token) => {
    const r = await sql
      .prepare(
        `SELECT i.*, t.name AS tenant_name
           FROM tenant_invites i LEFT JOIN "tenant" t ON t.id = i.tenant_id
          WHERE i.token = ? LIMIT 1`,
      )
      .bind(token)
      .first();
    return (r as unknown as import("@duyet/oma-http-routes").InviteWithToken) ?? null;
  },
  markAccepted: async (id, userId, at) => {
    await sql
      .prepare("UPDATE tenant_invites SET status = 'accepted', accepted_by = ?, accepted_at = ? WHERE id = ?")
      .bind(userId, at, id)
      .run();
  },
  addMembership: async (userId, tenantId, role) => {
    await sql
      .prepare(
        `INSERT INTO membership (user_id, tenant_id, role, created_at)
           VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = excluded.role`,
      )
      .bind(userId, tenantId, role, Date.now())
      .run();
  },
  sendEmail: async (_c, msg) => {
    if (!sender) {
      logger.info({ to: msg.to }, "[invites] email not sent (no SMTP sender configured)");
      return;
    }
    const ws = msg.tenantName || "a workspace";
    await sender.send({
      to: msg.to,
      subject: `You've been invited to join ${ws} on OMA`,
      html:
        `<p>You've been invited to join <strong>${ws}</strong> as <strong>${msg.role}</strong>.</p>` +
        `<p><a href="${msg.acceptUrl}">Accept the invitation</a></p>` +
        `<p>Or paste this link into your browser:<br>${msg.acceptUrl}</p>`,
      text: `You've been invited to join ${ws} as ${msg.role}.\n\nAccept: ${msg.acceptUrl}\n`,
    });
  },
  publicBaseUrl: () => process.env.PUBLIC_BASE_URL,
};
v1.route("/tenant", buildTenantMemberRoutes(nodeInviteDeps));
v1.route("/invites", buildInviteAcceptRoutes(nodeInviteDeps));
v1.route("/device", buildDeviceRoutes({
  services,
  mintApiKey: (input) => mintApiKeyOnStorage(apiKeyStorage, input),
  hasMembership: async (userId, tenantId) => {
    const row = await sql
      .prepare(
        `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      )
      .bind(userId, tenantId)
      .first<{ one: number }>();
    return row !== null;
  },
  loadTenant: async (tenantId) => {
    const r = await sql
      .prepare(`SELECT id, name FROM "tenant" WHERE id = ?`)
      .bind(tenantId)
      .first<{ id: string; name: string }>();
    return r ?? null;
  },
}));
v1.route("/api_keys", buildApiKeyRoutes({ storage: apiKeyStorage }));
v1.route("/evals", buildEvalRoutes({
  evals: evalsService,
  agents: agentsService,
  // Node has no per-tenant cloud environments yet — leave the optional
  // dep undefined so the route accepts any environment_id without 404ing.
}));

// Environments — full CRUD via the shared bundle. Replaces the old
// `{ data: [] }` stub (which also 404'd POST /v1/environments — the bug
// this route fixes). Backed by the SQLite environments service assembled
// above and wired into the `services` bundle.
v1.route("/environments", buildEnvironmentRoutes({ services }));

// Model cards, dashboard stats, usage analytics, and the skill catalog
// (issue #171 — CF/Node route parity). Same shared builders CF mounts;
// `quota` is omitted for skills (undefined) — self-host Node has no
// per-tenant CF Rate Limiting binding to back an upload-frequency gate, so
// uploads soft-pass per @duyet/oma-quotas' "absent primitive = no reject"
// contract.
v1.route("/model_cards", buildModelCardRoutes({ services }));
v1.route("/stats", buildStatsRoutes({ services }));
v1.route("/usage", buildUsageRoutes({ services }));
v1.route("/skills", buildSkillRoutes({ services }));

v1.get("/hosting_types", async (c) => {
  const providers = sandboxRegistry.list();
  const env = (sandboxRegistry as unknown as { providers?: unknown })
    ? (process.env as Record<string, string | undefined>)
    : {};
  const healthResults = new Map<string, {
    status: "healthy" | "unhealthy" | "not_configured";
    latency_ms: number;
    last_checked: string;
    reason?: string;
    capacity?: import("@duyet/oma-sandbox").SandboxCapacity;
  }>();
  for (const p of providers) {
    try {
      const desc = SYSTEM_PROVIDERS.find((d) => d.type === p.type);
      // Local subprocess is always seeded but only "healthy" once a daemon
      // is connected. With no daemon it reports not_configured so the UI
      // can offer a connect dialog instead of a confusing "unhealthy".
      if (p.type === "subprocess" && !desc?.envKeys.some((k) => env[k])) {
        healthResults.set(p.id, {
          status: "not_configured",
          latency_ms: 0,
          last_checked: new Date().toISOString(),
          reason: "No local runtime connected. Start the oma bridge daemon on this machine to enable it.",
        });
        continue;
      }
      // browser-vm relays sandbox ops to a browser tab via the RuntimeRoom
      // Durable Object — a Cloudflare-only surface. On self-host Node it's
      // listed (shared SYSTEM_PROVIDERS seed) but not yet wired.
      if (p.type === "browser-vm") {
        healthResults.set(p.id, {
          status: "not_configured",
          latency_ms: 0,
          last_checked: new Date().toISOString(),
          reason: "Browser sandbox tabs are only supported on the Cloudflare deployment for now.",
        });
        continue;
      }
      const h = await sandboxRegistry.checkHealth(p.id).catch(() => null);
      if (h) {
        healthResults.set(p.id, {
          status: h.status === "ok" ? "healthy" : "unhealthy",
          latency_ms: h.latencyMs,
          last_checked: h.lastChecked,
          reason: h.status === "ok" ? undefined : (h.details ?? "Health check failed."),
          capacity: h.capacity,
        });
      }
    } catch {}
  }

  const sysCap = (type: string): string[] =>
    SYSTEM_PROVIDERS.find((d) => d.type === type)?.capabilities ?? [];

  const types = providers.map((p) => {
    const health = healthResults.get(p.id);
    return {
      id: p.id,
      label: p.label,
      description: p.description ?? "",
      type: p.isSystem ? "system" : "byok",
      provider: p.type,
      external: !p.isSystem || !["subprocess", "cloud"].includes(p.type),
      capabilities: sysCap(p.type),
      health: health ?? null,
      availability: describeProviderAvailability({
        providerId: p.type,
        runtime: "node",
        env,
      }),
    };
  });

  // Every provider this build ships that wasn't seeded still gets a row, so
  // the Console can say *why* it isn't usable here instead of omitting it.
  const seeded = new Set(providers.map((p) => p.type));
  const unseeded = buildUnseededHostingTypes(seeded, "node", env);

  return c.json({ runtime: "node", data: [...types, ...unseeded] });
});

// ─── Sandbox provider management (BYOK) ──────────────────────────────
//
// Users can register their own sandbox provider configs (bring your own
// key), list available providers, rotate keys, and view usage stats.
// System providers seeded from env vars are read-only.

// POST /v1/sandbox_providers — register a new provider (BYOK)
v1.post("/sandbox_providers", async (c) => {
  const body = await c.req.json<{
    type: string;
    label: string;
    description?: string;
    apiKey?: string;
    baseURL?: string;
    config?: Record<string, string>;
    tenantId?: string;
  }>();
  if (!body.type || !body.label) {
    return c.json({ error: "type and label are required" }, 400);
  }
  const id = body.label.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const config: SandboxProviderConfig = {
    id,
    type: body.type,
    label: body.label,
    description: body.description,
    apiKey: body.apiKey,
    baseURL: body.baseURL,
    config: body.config,
    isSystem: false,
    tenantId: body.tenantId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  sandboxRegistry.register(config);
  return c.json({ data: config });
});

// GET /v1/sandbox_providers — list all providers
v1.get("/sandbox_providers", (c) => {
  const providers = sandboxRegistry.list().map((p) => ({
    ...p,
    apiKey: p.apiKey ? "••••" + p.apiKey.slice(-4) : undefined,
  }));
  return c.json({ data: providers });
});

// GET /v1/sandbox_providers/:id — get a single provider
v1.get("/sandbox_providers/:id", (c) => {
  const p = sandboxRegistry.get(c.req.param("id"));
  if (!p) return c.json({ error: "Provider not found" }, 404);
  return c.json({
    data: {
      ...p,
      apiKey: p.apiKey ? "••••" + p.apiKey.slice(-4) : undefined,
    },
  });
});

// PUT /v1/sandbox_providers/:id — update provider (key rotation, label, etc.)
v1.put("/sandbox_providers/:id", async (c) => {
  const id = c.req.param("id");
  const existing = sandboxRegistry.get(id);
  if (!existing) return c.json({ error: "Provider not found" }, 404);

  const body = await c.req.json<{
    label?: string;
    description?: string;
    apiKey?: string;
    baseURL?: string;
    config?: Record<string, string>;
  }>();

  const updated: SandboxProviderConfig = {
    ...existing,
    label: body.label ?? existing.label,
    description: body.description ?? existing.description,
    apiKey: body.apiKey ?? existing.apiKey,
    baseURL: body.baseURL ?? existing.baseURL,
    config: body.config ?? existing.config,
    updatedAt: new Date().toISOString(),
  };
  sandboxRegistry.register(updated);
  return c.json({ data: { ...updated, apiKey: updated.apiKey ? "••••" + updated.apiKey.slice(-4) : undefined } });
});

// DELETE /v1/sandbox_providers/:id — delete a user provider
v1.delete("/sandbox_providers/:id", (c) => {
  const id = c.req.param("id");
  const existing = sandboxRegistry.get(id);
  if (!existing) return c.json({ error: "Provider not found" }, 404);
  if (existing.isSystem) return c.json({ error: "Cannot delete a system provider" }, 403);
  sandboxRegistry.unregister(id);
  return c.json({ data: { id, deleted: true } });
});

// GET /v1/sandbox_providers/:id/usage — usage stats for a provider
v1.get("/sandbox_providers/:id/usage", (c) => {
  const id = c.req.param("id");
  const existing = sandboxRegistry.get(id);
  if (!existing) return c.json({ error: "Provider not found" }, 404);
  const tenantId = c.req.query("tenant_id") || "";
  const stats = sandboxQuota.getStats(tenantId, id);
  return c.json({ data: stats });
});

// Real integration CRUD + lookup (linear/github/slack publications,
// installations, dispatch rules). Active only when PLATFORM_ROOT_SECRET is
// set — otherwise the routes 503 with a remediation message. Install-proxy
// endpoints (start-a1 / credentials / handoff-link / personal-token) return
// 503 because the OAuth/install gateway is not yet ported to Node (P4
// follow-up); the read endpoints work standalone.
// Real integration CRUD + lookup (linear/github/slack publications,
// installations, dispatch rules). Active only when PLATFORM_ROOT_SECRET is
// set — otherwise the routes 503 with a remediation message. The
// install-proxy endpoints (start-a1 / credentials / handoff-link /
// personal-token) call into the in-process InstallBridge, mirroring the
// CF /linear/publications/* etc. wire shapes verbatim.
const integrationsInternalToken = process.env.INTEGRATIONS_INTERNAL_TOKEN ?? null;
const gatewayOrigin = process.env.GATEWAY_ORIGIN ?? process.env.PUBLIC_BASE_URL ?? "http://localhost:8787";
// OMA-hosted managed Slack App credentials — mirrors apps/integrations'
// SLACK_MANAGED_CLIENT_ID/SECRET/SIGNING_SECRET. Powers the "Add to Slack"
// one-click install; unset disables it (503, BYOA wizard still works).
const slackManagedApp =
  process.env.SLACK_MANAGED_CLIENT_ID &&
  process.env.SLACK_MANAGED_CLIENT_SECRET &&
  process.env.SLACK_MANAGED_SIGNING_SECRET
    ? {
        clientId: process.env.SLACK_MANAGED_CLIENT_ID,
        clientSecret: process.env.SLACK_MANAGED_CLIENT_SECRET,
        signingSecret: process.env.SLACK_MANAGED_SIGNING_SECRET,
      }
    : null;
// OMA-hosted managed GitHub App credentials — mirrors apps/integrations'
// GITHUB_MANAGED_APP_ID/APP_SLUG/BOT_LOGIN/PRIVATE_KEY/WEBHOOK_SECRET.
// Powers the "Add to GitHub" one-click install; unset disables it (503,
// App Manifest wizard still works).
const githubManagedApp =
  process.env.GITHUB_MANAGED_APP_ID &&
  process.env.GITHUB_MANAGED_APP_SLUG &&
  process.env.GITHUB_MANAGED_BOT_LOGIN &&
  process.env.GITHUB_MANAGED_PRIVATE_KEY &&
  process.env.GITHUB_MANAGED_WEBHOOK_SECRET
    ? {
        appId: process.env.GITHUB_MANAGED_APP_ID,
        appSlug: process.env.GITHUB_MANAGED_APP_SLUG,
        botLogin: process.env.GITHUB_MANAGED_BOT_LOGIN,
        privateKey: process.env.GITHUB_MANAGED_PRIVATE_KEY,
        webhookSecret: process.env.GITHUB_MANAGED_WEBHOOK_SECRET,
        clientId: process.env.GITHUB_MANAGED_CLIENT_ID ?? null,
        clientSecret: process.env.GITHUB_MANAGED_CLIENT_SECRET ?? null,
      }
    : null;
// OMA-hosted managed Linear OAuth App credentials — mirrors apps/integrations'
// LINEAR_MANAGED_CLIENT_ID/SECRET/WEBHOOK_SECRET. Powers the "Add to Linear"
// one-click install; unset disables it (503, BYOA OAuth app flow still works).
const linearManagedApp =
  process.env.LINEAR_MANAGED_CLIENT_ID &&
  process.env.LINEAR_MANAGED_CLIENT_SECRET &&
  process.env.LINEAR_MANAGED_WEBHOOK_SECRET
    ? {
        clientId: process.env.LINEAR_MANAGED_CLIENT_ID,
        clientSecret: process.env.LINEAR_MANAGED_CLIENT_SECRET,
        webhookSecret: process.env.LINEAR_MANAGED_WEBHOOK_SECRET,
      }
    : null;
let installBridge: NodeInstallBridge | null = null;
if (platformRootSecret) {
  installBridge = new NodeInstallBridge({
    sql,
    db: drizzleDb,
    platformRootSecret,
    gatewayOrigin: gatewayOrigin.replace(/\/+$/, ""),
    vaults: vaultService,
    credentials: credentialService,
    sessions: sessionsService,
    agents: agentsService,
    slackManagedApp,
    githubManagedApp,
    linearManagedApp,
    resolveTenantId: async (userId) => {
      const row = await sql
        .prepare(
          `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
        )
        .bind(userId)
        .first<{ tenant_id: string }>();
      return row?.tenant_id ?? null;
    },
    appendUserEvent: async (sessionId, _tenantId, _agentId, event) => {
      // Webhook → session-resume drives the same NodeSessionRouter the
      // public POST /v1/sessions/:id/events route uses, so the harness
      // wakes up via the existing event-driven runtime.
      await sessionRouter.appendEvent(sessionId, event);
    },
  });
}

if (platformRootSecret) {
  const integrationsRepoEnv: NodeReposEnv = {
    sql,
    db: drizzleDb,
    PLATFORM_ROOT_SECRET: platformRootSecret,
  };
  v1.route(
    "/integrations",
    buildIntegrationsRoutes({
      bags: () => {
        const repos = buildNodeRepos(integrationsRepoEnv);
        const slackCrypto = new WebCryptoAesGcm(platformRootSecret, "integrations.tokens");
        const slackIds = new CryptoIdGenerator();
        return {
          linear: {
            installations: repos.linearInstallations,
            publications: repos.linearPublications,
            apps: repos.apps,
            dispatchRules: repos.dispatchRules,
          },
          github: {
            installations: repos.githubInstallations,
            publications: repos.githubPublications,
            githubApps: repos.githubApps,
          },
          slack: {
            installations: new SqlSlackInstallationRepo(drizzleDb, slackCrypto, slackIds),
            publications: new SqlSlackPublicationRepo(drizzleDb, slackIds, slackCrypto),
            apps: new SqlSlackAppRepo(drizzleDb, slackCrypto, slackIds),
          },
        };
      },
      installProxy: installBridge ? bridgeAsInstallProxy(installBridge) : null,
    }),
  );
}

// ── Files API (subset of apps/main/src/routes/files.ts) ──
//
// CF mounts a richer files surface with synthesized session-output ids
// and multipart upload; Node ships the read-side equivalent so the SDK
// + console can list, download, and delete files. Uploads still go via
// POST /v1/sessions/:id/files (lifecycle.promoteSandboxFile) and the
// CF-only POST /v1/files (multipart upload from the browser) — that
// route can be ported when console upload UX needs it.
v1.get("/files", async (c) => {
  const t = c.var.tenant_id;
  const scopeId = c.req.query("scope_id") ?? undefined;
  const limitParam = c.req.query("limit");
  let requested = limitParam ? parseInt(limitParam, 10) : 100;
  if (isNaN(requested) || requested < 1) requested = 100;
  if (requested > 1000) requested = 1000;
  const beforeId = c.req.query("before_id");
  const afterId = c.req.query("after_id");
  const order = c.req.query("order") === "asc" ? "asc" : "desc";
  const pageToken = c.req.query("page_token") ?? c.req.query("page") ?? undefined;
  const page = await filesService.listPage({
    tenantId: t,
    sessionId: scopeId,
    cursor: pageToken,
    beforeId,
    afterId,
    order,
    limit: requested,
  });
  const data = page.items.map(toFileRecord);
  return c.json({
    data,
    has_more: page.nextCursor !== undefined,
    first_id: data[0]?.id,
    last_id: data[data.length - 1]?.id,
    // Anthropic SDK Family B list schema: `next_page` is `string | null` — the
    // shared (created_at, id) cursor, replayed as `?page_token=` / `?page=`.
    // Same contract as the Cloudflare route (apps/main/src/routes/files.ts);
    // Node has no session-outputs R2 prefix to fold in.
    next_page: page.nextCursor ?? null,
  });
});
v1.get("/files/:id/content", async (c) => {
  const id = c.req.param("id");
  const t = c.var.tenant_id;
  const row = await filesService.get({ tenantId: t, fileId: id });
  if (!row) return c.json({ error: "File not found" }, 404);
  if (!row.downloadable) return c.json({ error: "This file is not downloadable" }, 403);
  const obj = await filesBlob.get(row.r2_key);
  if (!obj) return c.json({ error: "File content not found" }, 404);
  return new Response(obj.body, {
    headers: { "Content-Type": row.media_type },
  });
});
v1.get("/files/:id", async (c) => {
  const id = c.req.param("id");
  const t = c.var.tenant_id;
  const row = await filesService.get({ tenantId: t, fileId: id });
  if (!row) return c.json({ error: "File not found" }, 404);
  return c.json(toFileRecord(row));
});
v1.delete("/files/:id", async (c) => {
  try {
    const deleted = await filesService.delete({
      tenantId: c.var.tenant_id,
      fileId: c.req.param("id"),
    });
    await filesBlob.delete(deleted.r2_key).catch(() => undefined);
    return c.json({ type: "file_deleted", id: deleted.id });
  } catch (err) {
    if ((err as { code?: string }).code === "file_not_found") {
      return c.json({ error: "File not found" }, 404);
    }
    throw err;
  }
});

// OMA's own MCP server (issue #199) — /v1/mcp. Mounted on `app` ahead of the
// `/v1` catch-all so its static path wins; Bearer-token auth is handled in
// the route (bypassed in authMw above). Tool calls re-enter the platform API
// via an in-process app.fetch dispatch that forwards the tenant key.
app.route(
  "/v1/mcp",
  buildOmaMcpRoutes({
    dispatch: (req) => app.fetch(req),
  }),
);

app.route("/v1", v1);

// ── Consumer (end-user) auth + public chat surface (issue #226) ─────────
//
// Mirrors apps/main's /v1/public and /p mounts, ported here so the
// self-host Node runtime has the same publication surface. Both mounts sit
// OUTSIDE `v1` (which carries `authMw` for tenant x-api-key auth) — a
// consumer never holds a tenant API key, same as CF's split.
const consumerAuthStore = createSqlConsumerAuthStore(sql);
const consumerRateLimitGates = buildMemoryGates();

app.route(
  "/v1/public",
  buildConsumerAuthRoutes({
    store: consumerAuthStore,
    sendEmail: async (_c, msg) => {
      if (!sender) {
        logger.info(
          { to: msg.to, subject: msg.subject },
          "[consumer-auth] email not sent (no SMTP sender configured)",
        );
        return;
      }
      await sender.send(msg);
    },
    rateLimitMagicLinkEmail: async (_c, email) => {
      const r = await consumerRateLimitGates.authSendEmail.consume(email);
      return !r.ok;
    },
    devEchoToken: () =>
      process.env.CONSUMER_AUTH_DEV_ECHO_TOKEN === "1" ||
      process.env.CONSUMER_AUTH_DEV_ECHO_TOKEN === "true",
    publicBaseUrl: () => process.env.PUBLIC_BASE_URL,
  }),
);

// Build a standalone /sessions app for the /p/:slug forwarding path — same
// deps as the authenticated v1 mount, but NOT behind `authMw`. Tenant
// scoping instead comes from `x-oma-internal-tenant-id`, set by
// forwardToSessions (packages/http-routes/src/public/publications.ts) and
// re-hydrated into `c.var.tenant_id` by the middleware below (mirrors CF's
// invokePackage header rehydration in apps/main/src/index.ts).
function buildPublicSessionsApp() {
  const inner = buildSessionRoutes({
    services,
    router: sessionRouter,
    outputs: nodeOutputsAdapter(outputsRoot),
    lifecycle: nodeSessionLifecycle({ files: filesService, filesBlob }),
    // environment_id is always required now — resolve the real environment
    // row (mirrors the authenticated /v1/sessions mount above).
    loadEnvironment: async ({ tenantId, environmentId }) => {
      const row = await environmentsService.get({ tenantId, environmentId });
      return row ? toEnvironmentConfig(row) : null;
    },
  });
  const wrapped = new Hono<{
    Variables: { tenant_id: string; user_id?: string };
  }>();
  wrapped.use("*", async (c, next) => {
    const t = c.req.header("x-oma-internal-tenant-id");
    if (t) c.set("tenant_id", t);
    await next();
  });
  // forwardToSessions (packages/http-routes/src/public/publications.ts)
  // only strips the `/p/:slug` prefix off the incoming URL, leaving
  // `/sessions`, `/sessions/:id/messages`, etc — so the returned app must
  // itself be mounted under a `/sessions` prefix wrapping the raw session
  // routes (which live at `/`, `/:id`, ...). Mirrors the shape
  // apps/main/src/routes/publications.test.ts's fakes assert against.
  wrapped.route("/sessions", inner);
  return wrapped;
}

const publicSessionCapGates = buildMemoryGates();

function clientIpFromRequest(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "anonymous";
}

app.use("/p/*", async (c, next) => {
  const ip = clientIpFromRequest(c.req.raw);
  const isWrite = c.req.method === "POST" || c.req.method === "PUT" || c.req.method === "DELETE";
  if (isWrite) {
    const r = await publicSessionCapGates.apiWrite.consume(`ip:${ip}`);
    if (!r.ok) return c.json({ error: "Rate limit exceeded" }, 429);
  }
  await next();
});

app.route(
  "/p",
  buildPublicPublicationRoutes({
    env: {} as never,
    servicesForTenant: async () => services as never,
    buildSessionsApp: async () => buildPublicSessionsApp() as never,
    resolvePublication: async (slug: string) => {
      const pub = await publicationsService.getBySlug({ slug });
      if (!pub) {
        return new Response(JSON.stringify({ error: "Not found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        });
      }
      const gate = gatePublicationState(pub);
      if (gate) return gate;
      return pub;
    },
    guardSessionCreate: async (opts) => {
      const today = new Date().toISOString().slice(0, 10);
      return publicSessionCaps(kv, process.env, {
        slug: opts.publication.slug,
        ip: opts.ip,
        today,
      });
    },
    assertSessionOwnedByPublication: async (publication, sessionId) => {
      const sess = await services.sessions.get({
        tenantId: publication.tenant_id,
        sessionId,
      });
      if (!sess) return false;
      const pubId = (sess.metadata as Record<string, unknown> | null)?.publication_id;
      return pubId === publication.id;
    },
    // Metering/paywall is NOT ported to self-host — Stripe billing
    // (@duyet/oma-payments) requires a D1Database, which Node doesn't have.
    // free / no-pricing-row publications work end-to-end; a publication
    // configured with a metered pricing mode fails closed with an honest
    // 501 instead of silently being treated as free or half-wiring Stripe.
    //
    // In practice this is a guard, not a live path: Node doesn't mount
    // buildPublicationPricingRoutes, so a metered `publication_pricing` row
    // can't be created here through the API at all. It stays because the row
    // CAN arrive another way (a DB migrated over from CF, direct SQL), and
    // serving a paid bot for free is the one outcome worth failing closed on.
    enforcePaywall: async (opts) => {
      // Kill-switch truthiness must match @duyet/oma-payments isPaymentsEnabled:
      // ANY value other than "0"/"false" disables payments, not just "1" —
      // otherwise `PAYMENTS_DISABLED=true` on self-host would 501 a metered
      // publication instead of making it free, which is what the docs promise.
      const disabled = process.env.PAYMENTS_DISABLED;
      if (disabled && disabled !== "0" && disabled !== "false") return null;
      const row = await sql
        .prepare(`SELECT mode FROM publication_pricing WHERE publication_id = ?`)
        .bind(opts.publication.id)
        .first<{ mode: string }>();
      if (!row || row.mode === "free") return null;
      return Response.json(
        {
          error:
            "Metered publications are not supported on the self-host Node runtime yet — only free bots can be published here.",
          code: "metered_publications_not_supported",
        },
        { status: 501 },
      );
    },
    verifyMagicLink: async (token: string) => {
      return verifyMagicLinkToken(consumerAuthStore, token);
    },
    resolveEndUserId: async (req: Request) => {
      const auth = req.headers.get("authorization");
      const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
      if (token) {
        const session = await consumerAuthStore.resolveConsumerSession(token);
        if (session) return `eu:${session.consumer_id}`;
        return `tok:${token}`;
      }
      return `ip:${clientIpFromRequest(req)}`;
    },
  }),
);

// /v1/oma/* mirror — same Hono sub-app mounted twice. New OMA-only
// endpoints should be added here only; the bare /v1/<resource> mounts
// stay live for back-compat with Console + CLI.
app.route("/v1/oma/me", buildMeRoutes({
  services,
  authDisabled,
  loadTenant: async (tenantId) => {
    const r = await sql
      .prepare(`SELECT id, name FROM "tenant" WHERE id = ?`)
      .bind(tenantId)
      .first<{ id: string; name: string }>();
    return r ?? null;
  },
  listMemberships: async (userId) => {
    const r = await sql
      .prepare(
        `SELECT t.id AS id, t.name AS name, m.role AS role, m.created_at AS created_at
           FROM "membership" m JOIN "tenant" t ON t.id = m.tenant_id
          WHERE m.user_id = ? ORDER BY m.created_at ASC, t.id ASC`,
      )
      .bind(userId)
      .all<{ id: string; name: string; role: string; created_at: number }>();
    return r.results ?? [];
  },
  hasMembership: async (userId, tenantId) => {
    const row = await sql
      .prepare(
        `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      )
      .bind(userId, tenantId)
      .first<{ one: number }>();
    return row !== null;
  },
  mintApiKey: (input) => mintApiKeyOnStorage(apiKeyStorage, input),
}));
app.route("/v1/oma/tenants", buildTenantRoutes({ services }));
app.route("/v1/oma/tenant", buildTenantMemberRoutes(nodeInviteDeps));
app.route("/v1/oma/invites", buildInviteAcceptRoutes(nodeInviteDeps));
app.route("/v1/oma/device", buildDeviceRoutes({
  services,
  mintApiKey: (input) => mintApiKeyOnStorage(apiKeyStorage, input),
  hasMembership: async (userId, tenantId) => {
    const row = await sql
      .prepare(
        `SELECT 1 AS one FROM membership WHERE user_id = ? AND tenant_id = ? LIMIT 1`,
      )
      .bind(userId, tenantId)
      .first<{ one: number }>();
    return row !== null;
  },
  loadTenant: async (tenantId) => {
    const r = await sql
      .prepare(`SELECT id, name FROM "tenant" WHERE id = ?`)
      .bind(tenantId)
      .first<{ id: string; name: string }>();
    return r ?? null;
  },
}));
app.route("/v1/oma/api_keys", buildApiKeyRoutes({ storage: apiKeyStorage }));
app.route("/v1/oma/evals", buildEvalRoutes({
  evals: evalsService,
  agents: agentsService,
}));
// model_cards is in CF's /v1/oma list (apps/main/src/index.ts) — mirror it
// here too.
app.route("/v1/oma/model_cards", buildModelCardRoutes({ services }));

// /v1/oma/integrations mirror — same factory used twice. New OMA-only
// endpoints (if any) get added in the package, not here.
if (platformRootSecret) {
  const integrationsRepoEnvOma: NodeReposEnv = {
    sql,
    db: drizzleDb,
    PLATFORM_ROOT_SECRET: platformRootSecret,
  };
  app.route(
    "/v1/oma/integrations",
    buildIntegrationsRoutes({
      bags: () => {
        const repos = buildNodeRepos(integrationsRepoEnvOma);
        const slackCrypto = new WebCryptoAesGcm(platformRootSecret, "integrations.tokens");
        const slackIds = new CryptoIdGenerator();
        return {
          linear: {
            installations: repos.linearInstallations,
            publications: repos.linearPublications,
            apps: repos.apps,
            dispatchRules: repos.dispatchRules,
          },
          github: {
            installations: repos.githubInstallations,
            publications: repos.githubPublications,
            githubApps: repos.githubApps,
          },
          slack: {
            installations: new SqlSlackInstallationRepo(drizzleDb, slackCrypto, slackIds),
            publications: new SqlSlackPublicationRepo(drizzleDb, slackIds, slackCrypto),
            apps: new SqlSlackAppRepo(drizzleDb, slackCrypto, slackIds),
          },
        };
      },
      installProxy: installBridge ? bridgeAsInstallProxy(installBridge) : null,
    }),
  );
}

// ─── AnyRouter upstream provider — OAuth (PKCE) connect ────────────────
//
// GET  /v1/providers/anyrouter/connect     — redirects the browser into
//                                             AnyRouter's OAuth consent flow
// GET  /v1/providers/anyrouter/callback    — AnyRouter's redirect target;
//                                             mints + persists an sk-ar-…
//                                             key and hot-swaps buildModel
// GET  /v1/providers/anyrouter/status      — is this tenant connected?
// POST /v1/providers/anyrouter/disconnect  — revoke the stored credential
// GET  /v1/providers/anyrouter/models      — cached AnyRouter model catalog
v1.route(
  "/providers/anyrouter",
  buildAnyRouterRoutes({
    services,
    publicOrigin: gatewayOrigin.replace(/\/+$/, ""),
    returnUrl: `${gatewayOrigin.replace(/\/+$/, "")}/model-cards`,
    hooks: {
      onConnected: ({ apiKey }) => {
        setActiveAnyRouterProvider(apiKey);
      },
      onDisconnected: () => {
        clearActiveAnyRouterProvider();
      },
    },
  }),
);

// ─── Integrations gateway (OAuth callbacks, setup pages, Linear MCP,
// GitHub internal refresh, webhooks) — mounted on `app` (NOT under /v1)
// because the upstream OAuth/webhook URLs are at /linear/oauth/...,
// /linear-setup/..., /linear/webhook/..., etc. Active only when
// PLATFORM_ROOT_SECRET is set (encryption requires it). The bridge
// constructs providers per-request off the same Container builder used
// by the read-side routes, so a write hits the same underlying tables.
if (installBridge) {
  const containers = installBridge.buildContainers();
  app.route(
    "/",
    buildIntegrationsGatewayRoutes({
      installBridge,
      jwt: containers.linear.jwt,
      webhooks: {
        linear: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).linear.handleWebhook(req),
        github: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).github.handleWebhook(req),
        githubManaged: (req) =>
          buildNodeProvidersForRequest(installBridge!, gatewayOrigin).github.handleManagedWebhook(req),
        slack: (req) => buildNodeProvidersForRequest(installBridge!, gatewayOrigin).slack.handleWebhook(req),
      },
      internalSecret: integrationsInternalToken,
      // Self-host serves the Console off the same origin as this gateway, so
      // PUBLIC_BASE_URL is the console origin too.
      consoleOrigin: process.env.CONSOLE_ORIGIN ?? process.env.PUBLIC_BASE_URL ?? null,
      // Node has no per-tenant rate-limit binding by default; soft-pass.
      rateLimit: undefined,
    }),
  );
}

// ─── Telegram bot ────────────────────────────────────────────────────
//
// Inbound webhook → OMA session (create/resume) → agent's final message
// posted back to the chat, via a direct one-shot EventStreamHub observer
// (design doc "Approach B" — Node has no generic agent.notify fan-out with
// a per-session *dynamic* target, and the chat_id is dynamic per inbound
// message). The route is always mounted (mirrors CF's /telegram/webhook
// path) so Telegram's setWebhook call never 404s; when TELEGRAM_BOT_TOKEN
// or TELEGRAM_AGENT_ID is unset, buildHandler returns null and every
// request gets a clear 503 instead of silently no-op'ing.
let telegramHandler: TelegramAgentHandler | null = null;
if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_AGENT_ID) {
  const telegramClient = new TelegramClient(process.env.TELEGRAM_BOT_TOKEN);
  const telegramSessions = new NodeTelegramSessionCreator({
    sessionsService,
    agentsService,
    sessionRouter,
    hub,
    client: telegramClient,
    resolveTenantId: async (userId) => {
      const row = await sql
        .prepare(
          `SELECT tenant_id FROM membership WHERE user_id = ? ORDER BY created_at ASC, tenant_id ASC LIMIT 1`,
        )
        .bind(userId)
        .first<{ tenant_id: string }>();
      return row?.tenant_id ?? null;
    },
  });
  const telegramVaultIds = (process.env.TELEGRAM_VAULT_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  telegramHandler = new TelegramAgentHandler(telegramClient, {
    sessions: telegramSessions,
    agentId: process.env.TELEGRAM_AGENT_ID,
    vaultIds: telegramVaultIds,
    environmentId: process.env.TELEGRAM_ENVIRONMENT_ID,
    store: new InMemoryTelegramChatStore(),
  });
}
app.route(
  "/telegram",
  buildTelegramWebhookRoute({
    buildHandler: () => telegramHandler,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    log: logger,
  }),
);

// oma-cap-adapter wire — exposes a Resolver against the in-process vault
// services so a future Node outbound proxy (mirroring CF's mcp-proxy) can
// inject cap_cli credentials into sandbox traffic. Wired here at the
// services construction site so the resolver is available even before
// the outbound surface lands.
const _capResolver = new OmaVaultResolver({
  sessions: {
    get: ({ tenantId, sessionId }) => sessionsService.get({ tenantId, sessionId }) as never,
  },
  credentials: {
    listByVaults: ({ tenantId, vaultIds }) =>
      credentialService.listByVaults({ tenantId, vaultIds }) as never,
    update: ({ tenantId, vaultId, credentialId, auth }) =>
      credentialService.update({ tenantId, vaultId, credentialId, auth }) as never,
    create: ({ tenantId, vaultId, displayName, auth }) =>
      credentialService.create({ tenantId, vaultId, displayName, auth }) as never,
  },
});
void _capResolver;

// ── Session ↔ memory_store binding (Node-specific; not in package yet) ──
v1.post("/sessions/:id/memory_stores", async (c) => {
  const sid = c.req.param("id");
  const session = await sql
    .prepare(`SELECT id FROM sessions WHERE tenant_id = ? AND id = ?`)
    .bind(c.var.tenant_id, sid)
    .first();
  if (!session) return c.json({ error: "Session not found" }, 404);
  const body = await c.req.json<{ store_id: string; access?: string }>();
  if (!body.store_id) return c.json({ error: "store_id is required" }, 400);
  const store = await memoryService.getStore({
    tenantId: c.var.tenant_id,
    storeId: body.store_id,
  });
  if (!store) return c.json({ error: "Memory store not found" }, 404);
  const access = body.access === "read_only" ? "read_only" : "read_write";
  await sql
    .prepare(
      `INSERT INTO session_memory_stores (session_id, store_id, access, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(session_id, store_id) DO UPDATE SET access = excluded.access`,
    )
    .bind(sid, body.store_id, access, Date.now())
    .run();
  return c.json({ session_id: sid, store_id: body.store_id, access }, 201);
});
v1.get("/sessions/:id/memory_stores", async (c) => {
  const r = await sql
    .prepare(
      `SELECT store_id, access, created_at FROM session_memory_stores WHERE session_id = ?`,
    )
    .bind(c.req.param("id"))
    .all<{ store_id: string; access: string; created_at: number }>();
  return c.json({ data: r.results ?? [] });
});

// ── Console UI (optional) ──
const consoleDir = process.env.CONSOLE_DIR;
if (consoleDir) {
  const cwd = process.cwd();
  const rootRel = consoleDir.startsWith("/")
    ? relative(cwd, consoleDir)
    : consoleDir;
  app.use("/*", serveStatic({ root: rootRel }));
  app.get("/*", serveStatic({ root: rootRel, path: "index.html" }));
  logger.info({ op: "main-node.console_ui", dir: consoleDir, cwd_rel: rootRel }, "console UI served");
}

app.notFound((c) => c.json({ error: "not found" }, 404));
app.onError((err, c) => {
  logger.error({ err, op: "main-node.unhandled" }, "unhandled error");
  return c.json({ error: "internal_error", message: err.message }, 500);
});

// ─── Listen ──────────────────────────────────────────────────────────────

const port = Number(process.env.PORT ?? 8787);
const host = process.env.HOST ?? "0.0.0.0";
serve({ fetch: app.fetch, port, hostname: host }, (info) => {
  logger.info(
    { op: "main-node.listening", address: info.address, port: info.port, db: backendDescription },
    `listening on http://${info.address}:${info.port}`,
  );
});

// Scheduled-agent-runs launcher (issue #262) — mirrors the CF launcher in
// apps/main/src/lib/cf-scheduler-jobs.ts, but over the Node session-create +
// harness-drive path. `countActive` enforces the schedule's max_sessions cap;
// `launch` creates a session and kicks the harness turn via the same
// NodeSessionRouter the public POST /v1/sessions/:id/events route uses.
const scheduledRunLauncher: ScheduledRunLauncher = {
  async countActive(schedule) {
    return sessionsService.countActiveByScheduleId({
      tenantId: schedule.tenantId,
      scheduleId: schedule.id,
    });
  },
  async launch(schedule) {
    if (!schedule.environmentId) {
      throw new Error("schedule has no environment_id");
    }
    const agentRow = await agentsService.get({
      tenantId: schedule.tenantId,
      agentId: schedule.agentId,
    });
    if (!agentRow) throw new Error(`agent ${schedule.agentId} not found`);
    const { tenant_id: _atid, ...agentSnapshot } = agentRow;
    const envRow = await environmentsService.get({
      tenantId: schedule.tenantId,
      environmentId: schedule.environmentId,
    });
    if (!envRow) throw new Error(`environment ${schedule.environmentId} not found`);
    const envSnap = toEnvironmentConfig(envRow);
    const { session } = await sessionsService.create({
      tenantId: schedule.tenantId,
      agentId: schedule.agentId,
      environmentId: schedule.environmentId,
      title: "",
      agentSnapshot: agentSnapshot as never,
      environmentSnapshot: envSnap,
      metadata: { scheduled_run: { schedule_id: schedule.id } },
    });
    await sessionRouter.appendEvent(session.id, {
      type: "user.message",
      content: [{ type: "text", text: schedule.prompt }],
    } as never);
    return { sessionId: session.id };
  },
};

// Per-schedule alerts (issue #313) — fan a recorded schedule firing out to
// the schedule's own `notify.targets`, reusing the agent runtime's notify
// dispatcher so target formatting/signing lives in one place (the CF twin is
// `notifyScheduleRun` in apps/main/src/lib/cf-scheduler-jobs.ts). The tick
// already applied the schedule's `on` filter and swallows anything thrown
// here, so this is deliberately best-effort. A schedule has no vault_ids of
// its own (unlike a session), so credentials resolve across the tenant's
// vaults.
const scheduleRunNotifier = async (
  schedule: ClaimedSchedule,
  run: RecordRunInput,
): Promise<void> => {
  const targets = schedule.notify?.targets ?? [];
  if (!targets.length) return;

  const resolveCredentialToken = async (credentialId?: string): Promise<string | null> => {
    if (!credentialId) return null;
    const vaults = await vaultService.list({ tenantId: schedule.tenantId });
    const grouped = await credentialService.listByVaults({
      tenantId: schedule.tenantId,
      vaultIds: vaults.map((v) => v.id),
    });
    for (const { credentials } of grouped) {
      for (const cred of credentials) {
        if (cred.id === credentialId) {
          const auth = cred.auth as { token?: string; access_token?: string } | undefined;
          return auth?.token || auth?.access_token || null;
        }
      }
    }
    return null;
  };

  const event: SessionNotifyEvent = {
    sessionId: run.sessionId ?? schedule.id,
    status:
      run.status === "ok"
        ? "schedule_ok"
        : run.status === "error"
          ? "schedule_error"
          : "schedule_skipped",
    scheduleId: schedule.id,
    ...(run.error ? { detail: run.error } : {}),
  };

  await dispatchSessionNotifications(event, targets, {
    resolveCredentialToken,
    resolveSecret: (ref) => resolveCredentialToken(ref),
    resolveTelegramBotToken: () => process.env.TELEGRAM_BOT_TOKEN ?? null,
    // `email` targets (issue #317) — the same SMTP/nodemailer seam the
    // magic-link + invite emails use. No SMTP_HOST ⇒ null sender ⇒ the
    // target is skipped with a logged warning (fail-open).
    resolveEmailSender: () => sender,
    tenantId: schedule.tenantId,
    httpClient: new WorkerHttpClient(),
    onError: (target, err) =>
      logger.warn(
        {
          err,
          op: "main-node.scheduled_agent_runs.notify_failed",
          schedule_id: schedule.id,
          target_type: target.type,
        },
        "per-schedule notification failed",
      ),
  });
};

// Scheduled-deployment-runs launcher (issue #262) — mirrors the CF
// launchDeploymentSession, carrying the deployment's vaults + memory stores
// into each fired session. Node has no deployment CRUD routes yet, so no rows
// exist to fire; the launcher is wired for parity + forward-compat. Agent
// version pinning isn't resolved on Node (no per-version snapshot store) — it
// runs the latest agent version, the same fallback the session route uses.
const scheduledDeploymentRunLauncher: ScheduledDeploymentRunLauncher = {
  async launch(deployment) {
    if (!deployment.environmentId) {
      throw new Error("deployment has no environment_id");
    }
    const agentRow = await agentsService.get({
      tenantId: deployment.tenantId,
      agentId: deployment.agentId,
    });
    if (!agentRow) throw new Error(`agent ${deployment.agentId} not found`);
    const { tenant_id: _dtid, ...agentSnapshot } = agentRow;
    const envRow = await environmentsService.get({
      tenantId: deployment.tenantId,
      environmentId: deployment.environmentId,
    });
    if (!envRow) throw new Error(`environment ${deployment.environmentId} not found`);
    const envSnap = toEnvironmentConfig(envRow);
    const resources = deployment.memoryStoreIds.map((id) => ({
      type: "memory_store",
      memory_store_id: id,
      access: "read_write",
    }));
    const { session } = await sessionsService.create({
      tenantId: deployment.tenantId,
      agentId: deployment.agentId,
      environmentId: deployment.environmentId,
      title: "",
      vaultIds: deployment.vaultIds,
      agentSnapshot: agentSnapshot as never,
      environmentSnapshot: envSnap,
      metadata: { deployment_run: { deployment_id: deployment.id } },
      resources: resources as never,
    });
    await sessionRouter.appendEvent(session.id, {
      type: "user.message",
      content: [{ type: "text", text: deployment.initialMessage }],
    } as never);
    return { sessionId: session.id };
  },
};

// Cron — eval-tick + memory retention sweep + (when integrations schema is
// applied) webhook-events retention + scheduled-agent-runs (issue #262) +
// telemetry phone-home. Linear dispatch is left un-wired here because
// main-node doesn't construct a LinearProvider; pass `linearSweeper` when an
// in-process gateway lands.
// Best-effort read of our own package.json version for install telemetry.
function nodeOmaVersion(): string | undefined {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url).pathname, "utf-8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

const scheduler = buildNodeScheduler({
  evalServices: {
    agents: agentsService,
    environments: environmentsService,
    sessions: sessionsService,
    evals: evalsService,
    kv,
  },
  memory: memoryService,
  integrationsSql: platformRootSecret ? sql : null,
  controlPlaneSql: sql,
  omaVersion: nodeOmaVersion(),
  scheduledRunLauncher,
  scheduledDeploymentRunLauncher,
  scheduleRunNotifier,
});
await scheduler.start();
logger.info({ op: "main-node.scheduler.started" }, "scheduler started");

const shutdown = async (signal: string) => {
  logger.info({ op: "main-node.shutdown", signal }, `received ${signal}, shutting down`);
  try { await scheduler.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.scheduler_stop_failed" }, "scheduler stop failed"); }
  try { await memoryWatcher.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.watcher_stop_failed" }, "memory watcher stop failed"); }
  if (s3Poller) {
    try { await s3Poller.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.s3_poller_stop_failed" }, "s3-poller stop failed"); }
  }
  if (hub instanceof PgEventStreamHub) {
    try { await hub.stop(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.pg_hub_stop_failed" }, "pg-hub stop failed"); }
  }
  if (authShutdown) {
    try { await authShutdown(); } catch (err) { logger.warn({ err, op: "main-node.shutdown.auth_failed" }, "auth shutdown failed"); }
  }
  try { await tracer.shutdown(); } catch { /* tracer shutdown is best-effort */ }
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// ─── Helpers ─────────────────────────────────────────────────────────────

function parseCustomHeaders(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const part of raw.split(",")) {
    const [name, ...rest] = part.split(":");
    if (!name || rest.length === 0) continue;
    out[name.trim()] = rest.join(":").trim();
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function randomFallback(): string {
  // Pre-bootstrap fallback — logger is built before BetterAuth in the
  // current ordering, so this can use the structured logger.
  logger.warn(
    { op: "main-node.auth_secret_missing" },
    "BETTER_AUTH_SECRET not set — generating per-process random secret. Sessions will not survive restart.",
  );
  return Array.from(crypto.getRandomValues(new Uint8Array(32)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * In-process forwarder for the package's `installProxy` deps. Each subpath
 * (e.g. "linear/publications/start-a1") routes to bridge.startInstallation.
 * Mirrors apps/main/src/routes/integrations.ts but skips the
 * INTEGRATIONS.fetch hop.
 *
 * Linear's publication-first endpoints use distinct subpath shapes:
 *   - POST  linear/publications                       → mode='create-publication'
 *   - PATCH linear/publications/<id>/credentials      → mode='submit-credentials-pub'
 * Slack/GitHub continue using the legacy /start-a1, /credentials,
 * /handoff-link variants until they ship their own publication-first
 * refactors.
 */
function bridgeAsInstallProxy(bridge: NodeInstallBridge): InstallProxyForwarder {
  return {
    async forward({ subpath, body, method }) {
      // Managed-app availability probe — powers the Console's "OMA managed
      // app" chooser. Reports availability from the same env-derived
      // managedApp objects wired into NodeInstallBridge, no gateway
      // round-trip needed.
      const availability = /^([^/]+)\/managed-availability$/.exec(subpath);
      if (availability && (method ?? "GET") === "GET") {
        const [, provider] = availability;
        const available =
          provider === "slack"
            ? Boolean(slackManagedApp)
            : provider === "github"
              ? Boolean(githubManagedApp)
              : provider === "linear"
                ? Boolean(linearManagedApp)
                : false;
        return new Response(JSON.stringify({ available }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      // GitHub managed workspace connect — no publication, github-only.
      const managedConnect = /^github\/managed\/connect$/.exec(subpath);
      if (managedConnect && (method ?? "POST") === "POST") {
        const result = await bridge.startInstallation!({
          provider: "github",
          mode: "connect-managed-workspace",
          body: (body ?? {}) as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }

      // GitHub reconcile: link pre-existing installations + live detail.
      const managedLink = /^github\/managed\/link$/.exec(subpath);
      if (managedLink && (method ?? "POST") === "POST") {
        const result = await bridge.startInstallation!({
          provider: "github",
          mode: "link-managed-installations",
          body: (body ?? {}) as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }
      const installDetail = /^github\/managed\/installation-detail$/.exec(subpath);
      if (installDetail && (method ?? "POST") === "POST") {
        const result = await bridge.startInstallation!({
          provider: "github",
          mode: "managed-installation-detail",
          body: (body ?? {}) as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }

      // Linear publication-first endpoints first — they share a subpath
      // prefix with the legacy ones so order matters.
      const newPub = /^linear\/publications$/.exec(subpath);
      if (newPub && method === "POST") {
        const result = await bridge.startInstallation!({
          provider: "linear",
          mode: "create-publication",
          body: (body ?? {}) as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }
      const newCreds = /^linear\/publications\/([^/]+)\/credentials$/.exec(subpath);
      if (newCreds && (method === "PATCH" || method === "POST")) {
        const result = await bridge.startInstallation!({
          provider: "linear",
          mode: "submit-credentials-pub",
          body: { ...(body ?? {}), publicationId: newCreds[1] } as Record<string, unknown>,
        });
        return new Response(JSON.stringify(result.body), {
          status: result.status,
          headers: { "content-type": "application/json" },
        });
      }

      const m = /^([^/]+)\/publications\/(start-a1|start-managed|credentials|handoff-link|personal-token)$/.exec(
        subpath,
      );
      if (!m) {
        return new Response(
          JSON.stringify({ error: `unsupported install proxy subpath: ${subpath}` }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      }
      const [, provider, mode] = m;
      const result = await bridge.startInstallation!({
        provider: provider as "linear" | "github" | "slack",
        mode: mode as "start-a1" | "start-managed" | "credentials" | "handoff-link" | "personal-token",
        body: (body ?? {}) as Record<string, unknown>,
      });
      return new Response(JSON.stringify(result.body), {
        status: result.status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

/**
 * Lightweight SqlClient shim around a better-sqlite3 Database. Used only
 * to run the better-auth schema apply against the auth db (separate
 * connection from the main SqlClient). We don't ship a full adapter — only
 * .exec() is needed.
 */
function betterSqliteAsSqlClient(
  db: import("better-sqlite3").Database,
): SqlClient {
  return {
    exec: async (s: string) => {
      db.exec(s);
    },
    prepare: () => {
      throw new Error("not implemented");
    },
    batch: async () => [],
  } as SqlClient;
}

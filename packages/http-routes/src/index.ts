// Public surface — every mount factory and the shared types.
//
// CF + Node both `import { buildXxxRoutes, type RouteServices } from
// "@duyet/oma-http-routes"`, build their services bundle, and
// mount the routes under the same paths.

export type {
  RouteServices,
  RouteServicesArg,
  EventStreamHub,
  BackgroundRunner,
  SessionRegistryLike,
} from "./types";
export { resolveServices } from "./types";

export { buildAgentRoutes } from "./agents";
export type { AgentRoutesDeps } from "./agents";

export {
  buildDailySummaryRoutes,
  parseDailySummaryDays,
  buildDailySummary,
} from "./agents/daily-summary";
export type {
  DailySummaryRoutesDeps,
  DailySummaryDays,
  ScheduleRunStatus,
  TokenTotals,
  DailySummaryDay,
  DailySummaryRecentRun,
  AgentDailySummary,
  ParseDailySummaryDaysResult,
  DailySummaryDaysError,
  ScheduleRunRaw,
  UsageEventRaw,
} from "./agents/daily-summary";

export { buildAnalyticsRoutes, parseAnalyticsRange } from "./analytics";
export type { AnalyticsRoutesDeps } from "./analytics";

export { buildTelemetryRoutes } from "./telemetry";
export type { TelemetryRoutesDeps } from "./telemetry";
export {
  collectInstallReport,
  sendInstallReport,
  telemetryDisabled,
  resolveInstanceId,
} from "./telemetry/phone-home";
export type { InstallReport } from "./telemetry/phone-home";

export { buildVaultRoutes } from "./vaults";
export type { VaultRoutesDeps } from "./vaults";

export { buildEnvironmentRoutes } from "./environments";
export type { EnvironmentRoutesDeps } from "./environments";
export {
  validateEnvVars,
  reconcileEnvVars,
  deleteAllEnvSecrets,
  envSecretKey,
} from "./environments/env-vars";

export { buildSessionRoutes } from "./sessions";
export type {
  SessionRoutesDeps,
  SessionLifecycleHooks,
  OutputsAdapter,
} from "./sessions";

export { buildMemoryRoutes } from "./memory";
export type { MemoryRoutesDeps } from "./memory";

export { buildDreamRoutes } from "./dreams";
export type { DreamRoutesDeps } from "./dreams";

export { buildTenantRoutes, buildMeRoutes } from "./tenants";
export type { TenantRoutesDeps, MeRoutesDeps } from "./tenants";
export {
  buildTenantMemberRoutes,
  buildInviteAcceptRoutes,
  INVITE_TTL_MS,
} from "./tenants";
export type {
  InviteRoutesDeps,
  InviteRecord,
  InviteWithToken,
  MemberRecord,
  InviteEmail,
  InviteRole,
} from "./tenants";

export { buildDeviceRoutes } from "./device";
export type { DeviceRoutesDeps, DeviceToken } from "./device";

export {
  buildApiKeyRoutes,
  mintApiKeyOnStorage,
  sha256Hex,
} from "./api-keys";
export type {
  ApiKeyRoutesDeps,
  ApiKeyStorage,
  ApiKeyRecord,
  ApiKeyMeta,
} from "./api-keys";

export { buildEvalRoutes } from "./evals";
export type { EvalRoutesDeps, EvalTaskSpec } from "./evals";

export { buildPublicationRoutes, buildAgentPublicationRoutes } from "./publications";
export type {
  PublicationRoutesDeps,
} from "./publications";

// Public consumer surface (issue #226) — /p/:slug hosted chat page + widget +
// session/message pass-throughs, shared by both runtimes.
export {
  buildPublicPublicationRoutes,
  gatePublicationState,
  publicSessionCaps,
  renderChatPage,
  renderWidgetScript,
  buildConsumerAuthRoutes,
  createSqlConsumerAuthStore,
  magicLinkEmailHtml,
  magicLinkEmailText,
  magicLinkVerifyUrl,
  verifyMagicLinkToken,
  MAGIC_LINK_EMAIL_SUBJECT,
} from "./public";
export type {
  PublicPublicationRoutesDeps,
  PublicPublicationServices,
  PublicEnv,
  ConsumerAuthRoutesDeps,
  ConsumerAuthStore,
  ConsumerAuthEmail,
  ConsumerSessionRow,
  VerifyMagicLinkOk,
  VerifyMagicLinkErr,
  VerifyMagicLinkResult,
} from "./public";

export { buildFederationRoutes } from "./federation";
export type { FederationRoutesDeps } from "./federation";

export {
  federatedListBody,
  fanOutRemoteList,
  mergeFederatedPages,
  wantsRemoteFanOut,
  parseInstanceIds,
  forwardableSearch,
} from "./federation-fanout";
export type {
  FederationCryptoDep,
  FederatedRow,
  RemoteListError,
} from "./federation-fanout";

export { buildIntegrationsRoutes } from "./integrations";
export type {
  IntegrationsRoutesDeps,
  IntegrationsBags,
  IntegrationsRepoBag,
  InstallProxyForwarder,
} from "./integrations";

export { buildIntegrationsGatewayRoutes } from "./integrations/gateway";
export type {
  IntegrationsGatewayDeps,
  WebhookHandler,
  WebhookHandlers,
  RateLimitHooks,
} from "./integrations/gateway";

export { buildAnyRouterRoutes } from "./providers/anyrouter";
export type {
  AnyRouterRoutesDeps,
  AnyRouterConnectHooks,
  AnyRouterConnectedInfo,
} from "./providers/anyrouter";

export { buildMcpServerRoutes, resolveRegisteredMcpServer } from "./mcp-servers";
export type { McpServerRoutesDeps, McpRegistryRow } from "./mcp-servers";

export { buildOmaMcpRoutes } from "./mcp";
export type { OmaMcpRoutesDeps } from "./mcp";

export { buildTelegramWebhookRoute } from "./telegram";
export type { TelegramWebhookRouteDeps } from "./telegram";
export {
  buildTelegramConnectionRoutes,
  telegramConnectionKvKey,
} from "./telegram/connection";
export type {
  TelegramConnectionRoutesDeps,
  TelegramConnectionRow,
  TelegramConnectionMode,
  TelegramLinkedChat,
} from "./telegram/connection";

export { buildScheduleRoutes, buildTenantScheduleRoutes } from "./schedules";
export type { ScheduleRoutesDeps, ScheduleDbArg } from "./schedules";

export { checkInternalSecret } from "./internal-auth";

export { buildModelCardRoutes } from "./model-cards";
export type { ModelCardRoutesDeps } from "./model-cards";

export { buildStatsRoutes } from "./stats";
export type { StatsRoutesDeps } from "./stats";

export { buildUsageRoutes } from "./usage";
export type {
  UsageRoutesDeps,
  UsageByKind,
  UsageByInstanceType,
  DailyBucket,
  UsageByAgent,
  UsagePeriod,
  UsageSummary,
} from "./usage";

export { buildSkillRoutes } from "./skills";
export type { SkillRoutesDeps } from "./skills";

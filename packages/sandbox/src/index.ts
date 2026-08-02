export type {
  ProcessHandle,
  SandboxExecutor,
  SandboxFactory,
  SandboxFactoryContext,
  SandboxFactoryEnv,
  SandboxCapacity,
} from "./ports";

export { DEFAULT_SANDBOX_IMAGE } from "./ports";

export {
  DefaultSandboxOrchestrator,
  type SandboxOrchestrator,
  type SandboxCapabilities,
  type ProvisionInput,
  type OrchestratorMemoryMount,
  type OrchestratorBackupHandle,
  type WorkspaceBackupService,
  type DefaultSandboxOrchestratorDeps,
} from "./orchestrator";

export {
  SandboxProviderRegistry,
  type ProviderHealth,
} from "./registry";

export type {
  SandboxProviderConfig,
  ResolvedSandboxProvider,
  SystemProviderDescriptor,
  CfSandboxResolution,
  LocalSandboxMode,
  DefaultProviderSelection,
} from "./provider-config";

export {
  seedSystemProviders,
  providerConfigToEnv,
  checkProviderRequirements,
  classifyCfSandboxProvider,
  parseOpenShellMode,
  resolveDefaultLocalSandboxProvider,
  SYSTEM_PROVIDERS,
} from "./provider-config";

export type {
  DeploymentRuntime,
  ProviderAvailability,
  ProviderAvailabilityState,
  AvailabilityInput,
  HostingTypeEntry,
} from "./availability";

export {
  describeProviderAvailability,
  describeAllProviderAvailability,
  buildUnseededHostingTypes,
} from "./availability";

export { KubernetesRemoteSandbox } from "./adapters/kubernetes-remote";

export {
  InMemoryQuotaStore,
  type SandboxUsageRecord,
  type UsageStats,
  type SandboxQuotaStore,
} from "./quota";

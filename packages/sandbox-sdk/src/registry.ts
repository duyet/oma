// SandboxProviderRegistry — the multi-provider sandbox registry.
//
// Holds a set of SandboxProviderConfigs (system-seeded + user BYOK),
// lazy-loads their adapter factories on first use, and creates
// SandboxExecutor instances from the selected provider config.
//
// Usage:
//   const registry = new SandboxProviderRegistry();
//   registry.seedFromEnv(process.env);           // load system providers
//   registry.register(userConfig);               // add BYOK provider
//   const ex = await registry.createExecutor(
//     "my-daytona", { sessionId, workdir }, process.env
//   );

import type {
  SandboxExecutor,
  SandboxFactory,
  SandboxFactoryContext,
  SandboxFactoryEnv,
} from "./ports";
import type { SandboxProviderConfig, ResolvedSandboxProvider } from "./provider-config";
import { seedSystemProviders, providerConfigToEnv, SYSTEM_PROVIDERS } from "./provider-config";
import type { SandboxCapacity } from "./ports";

export interface ProviderHealth {
  id: string;
  status: "ok" | "error";
  latencyMs: number;
  lastChecked: string;
  details?: string;
  /** Best-effort capacity snapshot — only set for providers that expose one. */
  capacity?: SandboxCapacity;
}

export class SandboxProviderRegistry {
  private providers = new Map<string, ResolvedSandboxProvider>();
  private factoryCache = new Map<string, SandboxFactory>();

  /**
   * Seed system providers from the current env. Called once at startup.
   * Skips providers whose env keys are missing (e.g. no DAYTONA_API_KEY).
   */
  seedFromEnv(env: Record<string, string | undefined>): void {
    const systemConfigs = seedSystemProviders(env);
    for (const config of systemConfigs) {
      // Only add if not already registered (e.g. a user provider with the same id)
      if (!this.providers.has(config.id)) {
        this.providers.set(config.id, { config, factory: undefined as unknown as SandboxFactory });
      }
    }
  }

  /**
   * Register a provider config (BYOK or system). Overwrites existing
   * if the id matches — the caller controls the id namespace.
   * Returns the previous provider if one was replaced.
   */
  register(config: SandboxProviderConfig): SandboxProviderConfig | undefined {
    const prev = this.providers.get(config.id);
    // Clear cached factory — will be reloaded on next createExecutor
    this.providers.set(config.id, { config, factory: undefined as unknown as SandboxFactory });
    return prev?.config;
  }

  /**
   * Remove a provider. Returns true if it existed.
   * System providers (isSystem=true) cannot be removed.
   */
  unregister(id: string): boolean {
    const existing = this.providers.get(id);
    if (!existing) return false;
    if (existing.config.isSystem) return false;
    this.providers.delete(id);
    this.factoryCache.delete(id);
    return true;
  }

  /**
   * Get a provider config by id.
   */
  get(id: string): SandboxProviderConfig | undefined {
    return this.providers.get(id)?.config;
  }

  /**
   * List all registered provider configs.
   */
  list(): SandboxProviderConfig[] {
    return Array.from(this.providers.values()).map((r) => r.config);
  }

  /**
   * List provider configs visible to a tenant (system-wide + tenant-scoped).
   */
  listForTenant(tenantId: string): SandboxProviderConfig[] {
    return this.list().filter(
      (p) => !p.tenantId || p.tenantId === tenantId,
    );
  }

  /**
   * Update an existing provider's API key (key rotation).
   */
  updateKey(id: string, apiKey: string): boolean {
    const existing = this.providers.get(id);
    if (!existing) return false;
    existing.config.apiKey = apiKey;
    existing.config.updatedAt = new Date().toISOString();
    return true;
  }

  /**
   * Get the hosting types this registry knows about, optionally filtered
   * by whether the provider is reachable with the current env.
   */
  getHostingTypes(): Array<{ id: string; label: string; description: string }> {
    return SYSTEM_PROVIDERS.map((p) => ({
      id: p.type,
      label: p.label,
      description: p.description,
    }));
  }

  /**
   * Create a SandboxExecutor for the given provider id.
   * Lazily loads the adapter factory on first use.
   */
  async createExecutor(
    providerId: string,
    ctx: SandboxFactoryContext,
    env: SandboxFactoryEnv,
  ): Promise<SandboxExecutor> {
    const resolved = this.providers.get(providerId);
    if (!resolved) {
      throw new Error(
        `Sandbox provider "${providerId}" not registered. ` +
          `Available: ${this.list().map((p) => p.id).join(", ") || "(none)"}`,
      );
    }

    // Lazy-load factory
    if (!resolved.factory) {
      resolved.factory = await this.loadFactory(resolved.config.type);
    }

    // Build env override map from the provider config, then merge with
    // the global env (provider config wins for its own keys).
    const providerEnv = providerConfigToEnv(resolved.config);
    const mergedEnv: Record<string, string | undefined> = { ...env };
    for (const [k, v] of Object.entries(providerEnv)) {
      mergedEnv[k] = v;
    }

    return resolved.factory(ctx, mergedEnv);
  }

  /**
   * Resolve a provider from an environment config.
   * Falls back: environment sandbox_provider → environment type → default.
   */
  async resolveForEnvironment(
    envConfig: { sandbox_provider?: string; type?: string } | undefined | null,
    defaultProvider: string,
  ): Promise<string> {
    // Direct provider id reference
    if (envConfig?.sandbox_provider && this.providers.has(envConfig.sandbox_provider)) {
      return envConfig.sandbox_provider;
    }
    // Legacy type-based selection
    if (envConfig?.type && this.providers.has(envConfig.type)) {
      return envConfig.type;
    }
    // "cloud" → use default
    if (envConfig?.type === "cloud" || !envConfig?.type) {
      return defaultProvider;
    }
    // Fallback
    return defaultProvider;
  }

  /**
   * Total registered provider count.
   */
  get size(): number {
    return this.providers.size;
  }

  /**
   * Health-check a single provider by id. Creates a short-lived executor,
   * calls ping(), and returns the health result. Does not throw — returns
   * error status on any failure.
   */
  async checkHealth(providerId: string): Promise<ProviderHealth> {
    const start = performance.now();

    // Built-in providers (e.g. "cloud"/Cloudflare Sandbox) have no adapter
    // factory — they are part of the runtime itself. Skip executor creation
    // and report healthy immediately.
    const config = this.providers.get(providerId);
    if (config) {
      const desc = SYSTEM_PROVIDERS.find((p) => p.type === config.config.type);
      if (desc && !desc.factoryPath) {
        return {
          id: providerId,
          status: "ok",
          latencyMs: Math.round(performance.now() - start),
          lastChecked: new Date().toISOString(),
          details: "built-in provider, always available",
        };
      }
    }

    try {
      const executor = await this.createExecutor(
        providerId,
        { sessionId: `healthcheck-${providerId}`, workdir: "/tmp" },
        {},
      );
      const result = await (executor.ping?.() ?? Promise.resolve({ status: "error" as const, latencyMs: 0, details: "ping not implemented" }));
      // Best-effort capacity snapshot — never fails the health check.
      const capacity = result.status === "ok"
        ? await (executor.getCapacity?.().catch(() => null) ?? Promise.resolve(null))
        : null;
      return {
        id: providerId,
        status: result.status,
        latencyMs: Math.round(performance.now() - start),
        lastChecked: new Date().toISOString(),
        details: result.details,
        ...(capacity ? { capacity } : {}),
      };
    } catch (err) {
      return {
        id: providerId,
        status: "error",
        latencyMs: Math.round(performance.now() - start),
        lastChecked: new Date().toISOString(),
        details: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Health-check all registered providers in parallel. Returns one result
   * per provider. Does not throw.
   */
  async checkAllHealth(): Promise<ProviderHealth[]> {
    const ids = Array.from(this.providers.keys());
    const results = await Promise.allSettled(
      ids.map((id) => this.checkHealth(id)),
    );
    return results.map((r, i) =>
      r.status === "fulfilled"
        ? r.value
        : {
            id: ids[i],
            status: "error" as const,
            latencyMs: 0,
            lastChecked: new Date().toISOString(),
            details: r.reason instanceof Error ? r.reason.message : String(r.reason),
          },
    );
  }

  // ── Private ──

  private async loadFactory(type: string): Promise<SandboxFactory> {
    const cached = this.factoryCache.get(type);
    if (cached) return cached;

    const desc = SYSTEM_PROVIDERS.find((p) => p.type === type);
    if (!desc || !desc.factoryPath) {
      throw new Error(`No factory path for sandbox type: ${type}`);
    }

    const mod = (await import(desc.factoryPath)) as {
      sandboxFactory: SandboxFactory;
    };
    this.factoryCache.set(type, mod.sandboxFactory);
    return mod.sandboxFactory;
  }
}

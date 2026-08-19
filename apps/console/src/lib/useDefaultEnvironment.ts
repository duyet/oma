import { useApiQuery } from "./useApiQuery";

export interface EnvironmentLite {
  id: string;
  name: string;
}

export interface DefaultEnvironmentResult {
  /** All environments visible to the current tenant. Empty while loading. */
  environments: EnvironmentLite[];
  isLoading: boolean;
  /** Env to use silently when there's exactly one — null otherwise. */
  singleEnvironmentId: string | null;
  /** True once loaded and the tenant has zero environments. */
  hasNoEnvironments: boolean;
  /** True when the caller must show a picker (2+ environments). */
  needsPicker: boolean;
}

/**
 * Shared "which environment does this session run in" resolution used by
 * every Console flow that creates a session for a cloud agent
 * (`environment_id` is required server-side — packages/http-routes/src/
 * sessions/index.ts). Centralizes the three-way UX:
 *   - exactly one environment → use it silently
 *   - several → caller renders a picker (defaulting to the first)
 *   - none → caller creates a default env inline (New session modal) instead of
 *     letting the request 400
 */
export function useDefaultEnvironment(): DefaultEnvironmentResult {
  const { data, isLoading } = useApiQuery<{ data: EnvironmentLite[] }>("/v1/environments");
  const environments = data?.data ?? [];

  return {
    environments,
    isLoading,
    singleEnvironmentId: environments.length === 1 ? environments[0].id : null,
    hasNoEnvironments: !isLoading && environments.length === 0,
    needsPicker: environments.length > 1,
  };
}

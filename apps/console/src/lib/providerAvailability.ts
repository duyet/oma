/**
 * Sandbox-provider availability, as reported by `/v1/hosting_types`.
 *
 * Availability answers "can this deployment run this provider at all?" and is
 * distinct from `health` ("is the configured provider responding right now?").
 * A provider can be perfectly healthy-capable and still be `unavailable` here
 * — e.g. `k8s` on the Cloudflare deployment, which needs a local kubeconfig a
 * Worker cannot load.
 *
 * The backend is the authority (only it can see secrets and bindings); this
 * module only turns its verdict into display shape. An older backend that
 * doesn't send `availability` yields the neutral "available" view, so the page
 * degrades to its pre-existing behaviour instead of falsely accusing a
 * provider of being broken.
 */

export type ProviderAvailabilityState = "available" | "needs_config" | "unavailable";

export interface ProviderAvailability {
  state: ProviderAvailabilityState;
  reason: string;
  missing_env?: string[];
}

export interface ProviderAvailabilityView {
  state: ProviderAvailabilityState;
  /** Short badge label, or null when the provider is plainly available. */
  badge: string | null;
  /** Why — rendered verbatim. Null when there's nothing worth saying. */
  reason: string | null;
  /** Env vars / secrets that would unblock it. Never null, may be empty. */
  missingEnv: string[];
  /** False only for `unavailable` — nothing the operator does here helps. */
  usable: boolean;
}

export function providerAvailabilityView(
  availability?: ProviderAvailability | null,
): ProviderAvailabilityView {
  if (!availability) {
    return { state: "available", badge: null, reason: null, missingEnv: [], usable: true };
  }
  const missingEnv = availability.missing_env ?? [];
  if (availability.state === "unavailable") {
    return {
      state: "unavailable",
      badge: "Unavailable here",
      reason: availability.reason,
      missingEnv,
      usable: false,
    };
  }
  if (availability.state === "needs_config") {
    return {
      state: "needs_config",
      badge: "Needs config",
      reason: availability.reason,
      missingEnv,
      usable: true,
    };
  }
  return { state: "available", badge: null, reason: null, missingEnv: [], usable: true };
}

/**
 * Split providers into the ones this deployment can actually run and the ones
 * it can't. The unavailable set is kept (never dropped) so the page can
 * explain each one — that diagnostic is the point of the page.
 */
export function partitionByAvailability<T>(
  items: T[],
  getAvailability: (item: T) => ProviderAvailability | null | undefined,
): { usable: T[]; unavailable: T[] } {
  const usable: T[] = [];
  const unavailable: T[] = [];
  for (const item of items) {
    if (providerAvailabilityView(getAvailability(item)).usable) usable.push(item);
    else unavailable.push(item);
  }
  return { usable, unavailable };
}

/** Human label for the deployment runtime reported alongside the list. */
export function runtimeLabel(runtime?: string | null): string | null {
  if (runtime === "cloudflare") return "Cloudflare deployment";
  if (runtime === "node") return "Self-host Node runtime";
  return null;
}

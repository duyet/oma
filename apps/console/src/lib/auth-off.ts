interface User {
  id: string;
  name: string;
  email: string;
  image?: string | null;
}

interface AuthCtx {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** True when `/auth-info` returned `providers: []` (AUTH_DISABLED=1). */
  authDisabled: boolean;
}

/** Stub identity matching `buildMeRoutes` AUTH_DISABLED `/v1/me`. */
export const AUTH_DISABLED_USER: User = {
  id: "default",
  name: "Default User",
  email: "default@local",
};

/**
 * `/auth-info` advertises enabled login methods. An empty `providers` array
 * means AUTH_DISABLED=1 (Node) — not "email+password with no OAuth". The
 * Login page used to ignore this and still offer signup against unmounted
 * `/auth/*` routes.
 */
export function isAuthOff(providers: string[] | undefined): boolean {
  return Array.isArray(providers) && providers.length === 0;
}

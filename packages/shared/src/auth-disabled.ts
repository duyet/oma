/** True when `AUTH_DISABLED=1` — single-user local trial. Every request
 *  becomes `tenant_id="default"` and the Console skips login. */
export function isAuthDisabled(value: string | undefined): boolean {
  return value === "1";
}

/** `/auth-info` returns `providers: []` when auth is off. The Console
 *  treats that empty list as skip-login (not "email+password with no OAuth"). */
export function isAuthInfoDisabled(providers: string[] | undefined): boolean {
  return Array.isArray(providers) && providers.length === 0;
}

/** Body for `/auth/*` when better-auth is not mounted. 410 rather than 404
 *  so a leftover Login form can show a real message instead of a generic
 *  "Authentication failed". */
export const AUTH_DISABLED_HTTP = {
  status: 410 as const,
  body: {
    error: "auth_disabled",
    message:
      "Authentication is disabled (AUTH_DISABLED=1). The Console runs as the default tenant without login.",
  },
};

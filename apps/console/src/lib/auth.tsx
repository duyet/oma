import { createContext, useContext, type ReactNode } from "react";
import { authClient } from "./auth-client";
import { useApiQuery } from "./useApiQuery";
import { AUTH_DISABLED_USER, isAuthOff } from "./auth-off";

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

const AuthContext = createContext<AuthCtx>({
  user: null,
  isLoading: true,
  isAuthenticated: false,
  authDisabled: false,
});

export { AUTH_DISABLED_USER, isAuthOff } from "./auth-off";

export function AuthProvider({ children }: { children: ReactNode }) {
  // /auth-info is public. Node returns `providers: []` when AUTH_DISABLED=1;
  // the Login page used to ignore that and still offer email signup against
  // unmounted `/auth/*` routes (404 → "Authentication failed").
  const { data: authInfo, isPending: authInfoPending } = useApiQuery<{
    providers?: string[];
  }>("/auth-info");
  const authDisabled = isAuthOff(authInfo?.providers);

  const { data: session, isPending } = authClient.useSession();

  const sessionUser = session?.user
    ? {
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
        image: session.user.image,
      }
    : null;

  const user = authDisabled ? AUTH_DISABLED_USER : sessionUser;

  return (
    <AuthContext.Provider
      value={{
        user,
        // Wait for /auth-info so we don't flash the login form (or bounce
        // to /login) before we know AUTH_DISABLED is on. Skip waiting on
        // better-auth's session fetch when auth is off — that call 410s.
        isLoading: authInfoPending || (!authDisabled && isPending && !sessionUser),
        isAuthenticated: authDisabled || !!sessionUser,
        authDisabled,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

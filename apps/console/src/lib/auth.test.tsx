import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createMemoryRouter, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "../mocks/server";
import { AuthProvider, useAuth } from "./auth";
import { isAuthOff } from "./auth-off";
import { Login } from "../pages/Login";

vi.mock("./auth-client", () => ({
  authClient: {
    useSession: () => ({ data: null, isPending: false }),
    signUp: { email: vi.fn() },
    signIn: { email: vi.fn(), social: vi.fn() },
    emailOtp: { sendVerificationOtp: vi.fn(), verifyEmail: vi.fn() },
  },
}));

function renderWithAuth(ui: ReactNode) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>{ui}</AuthProvider>
    </QueryClientProvider>,
  );
}

function Probe() {
  const a = useAuth();
  if (a.isLoading) return <div>probe-loading</div>;
  return (
    <div>
      <span data-testid="authenticated">{String(a.isAuthenticated)}</span>
      <span data-testid="disabled">{String(a.authDisabled)}</span>
      <span data-testid="email">{a.user?.email ?? "none"}</span>
    </div>
  );
}

describe("isAuthOff", () => {
  it("treats providers: [] as AUTH_DISABLED, not as email-only login", () => {
    expect(isAuthOff([])).toBe(true);
    expect(isAuthOff(["email"])).toBe(false);
    expect(isAuthOff(undefined)).toBe(false);
  });
});

describe("AuthProvider AUTH_DISABLED", () => {
  it("enters the app as the default tenant when /auth-info returns providers: []", async () => {
    server.use(
      http.get("/auth-info", () => HttpResponse.json({ providers: [] })),
    );
    renderWithAuth(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId("authenticated")).toHaveTextContent("true");
    });
    expect(screen.getByTestId("disabled")).toHaveTextContent("true");
    expect(screen.getByTestId("email")).toHaveTextContent("default@local");
  });

  it("stays unauthenticated when /auth-info lists email and there is no session", async () => {
    server.use(
      http.get("/auth-info", () =>
        HttpResponse.json({ providers: ["email"] }),
      ),
    );
    renderWithAuth(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId("authenticated")).toHaveTextContent("false");
    });
    expect(screen.getByTestId("disabled")).toHaveTextContent("false");
    expect(screen.getByTestId("email")).toHaveTextContent("none");
  });
});

describe("Login AUTH_DISABLED", () => {
  it("does not offer signup when providers is empty — redirects into the app", async () => {
    server.use(
      http.get("/auth-info", () => HttpResponse.json({ providers: [] })),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter(
      [
        { path: "/login", element: <Login /> },
        { path: "/", element: <div>app-home</div> },
      ],
      { initialEntries: ["/login"] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByText("app-home")).toBeInTheDocument();
    });
    expect(screen.queryByText("Create your account")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sign up" })).not.toBeInTheDocument();
  });

  it("shows email signup when providers includes email", async () => {
    server.use(
      http.get("/auth-info", () =>
        HttpResponse.json({ providers: ["email"] }),
      ),
    );
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const router = createMemoryRouter(
      [{ path: "/login", element: <Login /> }],
      { initialEntries: ["/login"] },
    );
    render(
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <RouterProvider router={router} />
        </AuthProvider>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Sign up" })).toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
  });
});

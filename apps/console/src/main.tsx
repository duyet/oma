import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import {
  Navigate,
  RouterProvider,
  createBrowserRouter,
  type RouteObject,
  type UIMatch,
} from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
// Bundled font (woff2 shipped with the app) so Logo's `[ ]` brackets render
// in JetBrains Mono on first paint — Google Fonts `display=swap` would
// otherwise render the brackets in SF Mono first, then re-render in
// JetBrains Mono when the network fetch resolves, producing a visible
// width shift in the sidebar header.
import "@fontsource-variable/jetbrains-mono";
import "./index.css";
import { AuthProvider } from "./lib/auth";
import { BrowserVmProvider } from "./lib/browser-vm/BrowserVmProvider";
import { ConfirmProvider } from "./hooks/useConfirm";
import { Toaster } from "./components/ui/sonner";
import { AppShell } from "./components/AppShell";
import { HubLayout, type HubConfig } from "./components/HubLayout";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { queryClient } from "./lib/query-client";
import { Login } from "./pages/Login";
import { Dashboard } from "./pages/Dashboard";
import { LaunchWizard } from "./pages/LaunchWizard";
import { AgentsList } from "./pages/AgentsList";
import { AgentDetail } from "./pages/AgentDetail";
import { AgentOverviewTab } from "./pages/agents/AgentOverviewTab";
import { AgentSessionsTab } from "./pages/agents/AgentSessionsTab";
import { AgentDeploymentsTab } from "./pages/agents/AgentDeploymentsTab";
import { AgentSchedulesTab } from "./pages/agents/AgentSchedulesTab";
import { AgentObservabilityTab } from "./pages/agents/AgentObservabilityTab";
import { AgentPublishingTab } from "./pages/agents/AgentPublishingTab";
import { SessionsList } from "./pages/SessionsList";
import { AgentSessionBoard, KanbanBoard } from "./pages/KanbanBoard";
import { GitHubIssuesBoard } from "./components/GitHubIssuesBoard";
import { Usage } from "./pages/Usage";
import { FilesList } from "./pages/FilesList";
import { EnvironmentsList } from "./pages/EnvironmentsList";
import { EnvironmentDetail } from "./pages/EnvironmentDetail";
import { VaultsList } from "./pages/VaultsList";
import { VaultDetail } from "./pages/VaultDetail";
import { SkillsList } from "./pages/SkillsList";
import { MemoryStoresList } from "./pages/MemoryStoresList";
import { MemoryStoreDetail } from "./pages/MemoryStoreDetail";
import { ModelCardsList } from "./pages/ModelCardsList";
import { ApiKeysList } from "./pages/ApiKeysList";
import { Members } from "./pages/Members";
import { CliLogin } from "./pages/CliLogin";
import { CliDevice } from "./pages/CliDevice";
import { RuntimesList } from "./pages/RuntimesList";
import { ConnectRuntime } from "./pages/ConnectRuntime";
import { CrashPage } from "./pages/CrashPage";
import { AgentBuilder } from "./pages/AgentBuilder";
import { MyBots } from "./pages/MyBots";
import { AgentChat } from "./pages/AgentChat";
import { EvalRunsList } from "./pages/EvalRunsList";
import { EvalRunDetail } from "./pages/EvalRunDetail";
import {
  IntegrationsLinearList,
  IntegrationsLinearWorkspace,
  IntegrationsLinearPublishPage,
  IntegrationsLinearPatInstallPage,
} from "./pages/IntegrationsLinear";
import {
  IntegrationsGitHubList,
  IntegrationsGitHubWorkspace,
  IntegrationsGitHubBindPage,
} from "./pages/IntegrationsGitHub";
import {
  IntegrationsSlackList,
  IntegrationsSlackWorkspace,
  IntegrationsSlackPublishPage,
} from "./pages/IntegrationsSlack";
import { IntegrationsHub, IntegrationsTelegramSetup } from "./integrations";
import { consolePlugins } from "./plugins/registry";

/**
 * Router config. Migrated from declarative `<BrowserRouter><Routes>` to
 * the data router (`createBrowserRouter` + `<RouterProvider>`) so we
 * can use `useMatches()` / per-route `handle` / loaders / actions.
 * Hooks that throw "must be used within a data router" — AppBreadcrumb,
 * future loader-driven pages — now work.
 *
 * Lazy chunks use the data-router-native `lazy:` field, which returns
 * an object with `Component` (and optionally `loader`, `action`,
 * `errorElement` etc). Compared to wrapping `<React.lazy />` in a
 * `<Suspense>`, the data router knows to await the chunk before
 * rendering the route, avoiding a flash of fallback during navigation.
 *
 * Per-route `handle.crumb` publishes a label for AppBreadcrumb. For
 * fixed labels pass a string; for dynamic labels (resource name from
 * the loader) pass a function that reads the match.
 */

/**
 * Hub configs — the tab strips for the three tabbed hub pages. Tabs are
 * absolute paths so each hub's `<HubLayout>` works regardless of the base
 * path its children mount under (the layout routes below are pathless).
 */
// Sessions hub — the live list of "what my agents are doing right now",
// plus the Kanban board view over that same session data. Usage moved out
// to its own standalone route (it owns a full "Usage & cost" page header
// of its own, so wrapping it in the hub produced a duplicated header);
// Eval Runs live under Settings now.
const SESSIONS_HUB: HubConfig = {
  title: "Sessions",
  description: "Trace, debug, and monitor your agents' sessions.",
  tabs: [
    { label: "Sessions", path: "/sessions" },
    {
      label: "Kanban",
      path: "/kanban",
      description:
        "Track work across your agent sessions and, optionally, a configurable board of GitHub issues you can hand off to agents.",
    },
  ],
};

const RESOURCES_HUB: HubConfig = {
  title: "Resources",
  description:
    "Environments, credentials, memory, skills, files, and model cards your agents use.",
  tabs: [
    { label: "Environments", path: "/environments", description: "Sandbox definitions — provider, packages, networking, and hardware." },
    { label: "Vaults", path: "/vaults", description: "Credential stores — secrets injected at the network layer, never into the sandbox." },
    { label: "Memory Stores", path: "/memory", description: "Persistent memory mounted into sessions at /mnt/memory — versioned and auditable." },
    { label: "Skills", path: "/skills", description: "Reusable prompt fragments and files attached to agents." },
    { label: "Files", path: "/files", description: "Uploaded files agents can mount into a session's sandbox." },
    { label: "Model Cards", path: "/model-cards", description: "Model + provider + credential bindings agents reference by handle." },
  ],
};

const SETTINGS_HUB: HubConfig = {
  title: "Settings",
  description: "Workspace configuration: members, API keys, sandbox providers, and eval runs.",
  tabs: [
    { label: "Members", path: "/members", description: "People with access to this workspace — invite teammates by email and manage roles." },
    { label: "API Keys", path: "/api-keys", description: "Authenticate the CLI, the SDK, or your own code against this platform's API." },
    { label: "Sandbox providers", path: "/runtimes", description: "Everywhere a sandbox can run — system providers, BYOK providers, and connected machines." },
    { label: "Eval Runs", path: "/evals", description: "Task suites scored against one agent in one environment — pass rates per trial." },
  ],
};

const protectedRoutes: RouteObject[] = [
  { index: true, element: <Dashboard />, handle: { crumb: "Overview" } },
  // Guided first-run path (audit Option B) — composes existing create
  // surfaces; same control plane on CF Workers and self-host k3s.
  { path: "launch", element: <LaunchWizard />, handle: { crumb: "Launch" } },
  // Nested route groups so detail pages publish a proper hierarchy
  // through `useMatches()` — `/agents/:id` resolves to
  // [agents-parent, agents/:id], so AppBreadcrumb renders
  // `Agents › Agent` instead of just `Agent` with no link back.
  {
    path: "agents",
    handle: { crumb: "Agents" },
    children: [
      { index: true, element: <AgentsList /> },
      {
        path: "new",
        element: <AgentBuilder />,
        handle: { crumb: "New Agent" },
      },
      {
        path: ":id",
        element: <AgentDetail />,
        handle: { crumb: (m: UIMatch) => (m.params.id as string | undefined) ?? "Agent" },
        children: [
          { index: true, element: <AgentOverviewTab /> },
          {
            path: "sessions",
            element: <AgentSessionsTab />,
            handle: { crumb: "Sessions" },
          },
          {
            path: "deployments",
            element: <AgentDeploymentsTab />,
            handle: { crumb: "Deployments" },
          },
          {
            path: "schedules",
            element: <AgentSchedulesTab />,
            handle: { crumb: "Schedules" },
          },
          {
            path: "observability",
            element: <AgentObservabilityTab />,
            handle: { crumb: "Observability" },
          },
          {
            path: "publishing",
            element: <AgentPublishingTab />,
            handle: { crumb: "Publishing" },
          },
        ],
      },
    ],
  },

  // ── Sessions hub ── the live sessions list + Kanban board, two views of
  // the same session data sharing one heading/tab strip. Session detail
  // stays full-page (chat shell) so it lives OUTSIDE the hub.
  {
    element: <HubLayout {...SESSIONS_HUB} />,
    children: [
      { path: "sessions", element: <SessionsList />, handle: { crumb: "Sessions" } },
      // Kanban — a shell route holding the tab strip; each board is its own
      // child route so it deep-links and only fetches while it is active.
      {
        path: "kanban",
        element: <KanbanBoard />,
        handle: { crumb: "Kanban Board" },
        children: [
          { index: true, element: <Navigate to="/kanban/agent" replace /> },
          { path: "agent", element: <AgentSessionBoard />, handle: { crumb: "Agent Sessions" } },
          { path: "github", element: <GitHubIssuesBoard />, handle: { crumb: "GitHub Issues" } },
        ],
      },
    ],
  },
  // Usage — standalone. It renders its own "Usage & cost" page header, so it
  // isn't wrapped in a tab hub (that produced a duplicated header). Reached
  // via the sidebar's daily path.
  { path: "usage", element: <Usage />, handle: { crumb: "Usage" } },
  // Session detail — full-page, no hub tabs. Pathless parent carries the
  // `Sessions` crumb (linking back to the list) so the breadcrumb reads
  // `Sessions › sess-xxx` as before.
  {
    handle: { crumb: { label: "Sessions", to: "/sessions" } },
    children: [
      {
        path: "sessions/:id",
        handle: { crumb: (m: UIMatch) => (m.params.id as string | undefined) ?? "Session" },
        // SessionDetail lazy-loads — it pulls in ai-elements + Shiki +
        // Streamdown + mermaid + dozens of language defs (~500 kB
        // gzipped). Splitting it out keeps the initial bundle for
        // /agents, /sessions list, etc. under 350 kB.
        lazy: async () => {
          const { SessionDetail } = await import("./pages/SessionDetail");
          return { Component: SessionDetail };
        },
      },
    ],
  },

  // ── Resources hub ── Environments / Vaults / Memory / Skills / Files /
  // Model Cards. List and detail routes keep their current paths; details
  // render under the hub (parent tab stays highlighted).
  {
    element: <HubLayout {...RESOURCES_HUB} />,
    children: [
      {
        path: "environments",
        handle: { crumb: "Environments" },
        children: [
          { index: true, element: <EnvironmentsList /> },
          {
            path: ":id",
            element: <EnvironmentDetail />,
            handle: { crumb: (m: UIMatch) => (m.params.id as string | undefined) ?? "Environment" },
          },
        ],
      },
      {
        path: "vaults",
        handle: { crumb: "Credential Vaults" },
        children: [
          { index: true, element: <VaultsList /> },
          {
            path: ":id",
            element: <VaultDetail />,
            handle: { crumb: (m: UIMatch) => (m.params.id as string | undefined) ?? "Vault" },
          },
        ],
      },
      {
        path: "memory",
        handle: { crumb: "Memory Stores" },
        children: [
          { index: true, element: <MemoryStoresList /> },
          {
            path: ":id",
            element: <MemoryStoreDetail />,
            handle: { crumb: (m: UIMatch) => (m.params.id as string | undefined) ?? "Memory Store" },
          },
        ],
      },
      { path: "skills", element: <SkillsList />, handle: { crumb: "Skills" } },
      { path: "files", element: <FilesList />, handle: { crumb: "Files" } },
      { path: "model-cards", element: <ModelCardsList />, handle: { crumb: "Model Cards" } },
    ],
  },

  // ── Settings hub ── API Keys / Sandbox providers / Eval Runs. (ConnectRuntime
  // lives at the top-level `/connect-runtime` route, outside AppShell.) The
  // eval-run detail renders under the hub too (parent tab stays highlighted),
  // matching the Resources hub's list+detail routes.
  {
    element: <HubLayout {...SETTINGS_HUB} />,
    children: [
      { path: "members", element: <Members />, handle: { crumb: "Members" } },
      { path: "api-keys", element: <ApiKeysList />, handle: { crumb: "API Keys" } },
      { path: "runtimes", element: <RuntimesList />, handle: { crumb: "Sandbox providers" } },
      {
        path: "evals",
        handle: { crumb: "Eval Runs" },
        children: [
          { index: true, element: <EvalRunsList /> },
          {
            path: ":id",
            element: <EvalRunDetail />,
            handle: { crumb: (m: UIMatch) => (m.params.id as string | undefined) ?? "Eval Run" },
          },
        ],
      },
    ],
  },

  // ── My Bots + Linear / GitHub / Slack integrations. No shared hub tab
  // strip — the Integrations sidebar item (Resources group) is the nav
  // for this whole subtree, and each page renders its own header.
  { path: "my-bots", element: <MyBots />, handle: { crumb: "My Bots" } },
  {
    path: "integrations",
    handle: { crumb: "Integrations" },
    children: [
      { index: true, element: <IntegrationsHub /> },
      {
        path: "linear",
        handle: { crumb: "Linear" },
        children: [
          { index: true, element: <IntegrationsLinearList /> },
          {
            path: "publish",
            element: <IntegrationsLinearPublishPage />,
            handle: { crumb: "Publish" },
          },
          {
            path: "install-pat",
            element: <IntegrationsLinearPatInstallPage />,
            handle: { crumb: "Install PAT" },
          },
          {
            path: "installations/:id",
            element: <IntegrationsLinearWorkspace />,
            handle: { crumb: "Workspace" },
          },
        ],
      },
      {
        path: "github",
        handle: { crumb: "GitHub" },
        children: [
          { index: true, element: <IntegrationsGitHubList /> },
          {
            path: "bind",
            element: <IntegrationsGitHubBindPage />,
            handle: { crumb: "Bind" },
          },
          {
            path: "installations/:id",
            element: <IntegrationsGitHubWorkspace />,
            handle: { crumb: "Workspace" },
          },
        ],
      },
      {
        path: "slack",
        handle: { crumb: "Slack" },
        children: [
          { index: true, element: <IntegrationsSlackList /> },
          {
            path: "publish",
            element: <IntegrationsSlackPublishPage />,
            handle: { crumb: "Publish" },
          },
          {
            path: "installations/:id",
            element: <IntegrationsSlackWorkspace />,
            handle: { crumb: "Workspace" },
          },
        ],
      },
      {
        path: "telegram",
        handle: { crumb: "Telegram" },
        children: [{ index: true, element: <IntegrationsTelegramSetup /> }],
      },
    ],
  },
  // Plugin-contributed routes (hosted-only extensions). Default empty in
  // OSS — hosted deploy overlays plugins/registry.ts to inject billing
  // / etc. PluginRoute keeps the same `{ path, element }` shape that
  // RouteObject expects.
  ...consolePlugins.flatMap((p) => p.routes ?? []),
  { path: "*", element: <Navigate to="/agents" replace /> },
];

const router = createBrowserRouter([
  { path: "login", element: <Login /> },
  { path: "cli/login", element: <CliLogin /> },
  { path: "publish/:agent_id", element: <AgentChat /> },
  { path: "connect-runtime", element: <ConnectRuntime /> },
  {
    element: <AppShell />,
    errorElement: <CrashPage />,
    children: protectedRoutes,
  },
]);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <ConfirmProvider>
            {/* Mounted above the router so the hidden sandbox iframe
                persists across route changes instead of remounting (and
                losing its paired VM) on every navigation. */}
            <BrowserVmProvider>
              <Suspense fallback={null}>
                <RouterProvider router={router} />
              </Suspense>
            </BrowserVmProvider>
          </ConfirmProvider>
        </AuthProvider>
        <Toaster />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);

// Typed wrapper around fetch for /v1/integrations/* endpoints.
//
// Credentials are sent via session cookie (better-auth). The base path is
// configurable for tests; defaults to the Console's same-origin "".
//
// Each integration provider gets a sub-client (api.linear.*, api.slack.*,
// api.github.*) with the same method shapes. Provider-specific quirks
// (e.g. signingSecret vs webhookSecret) live in narrow input types.

import type {
  A1FormStep,
  A1InstallLink,
  GitHubA1FormStep,
  GitHubA1InstallLink,
  GitHubInstallation,
  GitHubInstallationDetail,
  GitHubIssue,
  GitHubIssueFilters,
  GitHubAssignee,
  GitHubPublication,
  GitHubRepo,
  HandoffLink,
  LinearInstallation,
  LinearPublication,
  LinearPublicationCredentialsInput,
  LinearPublicationInstallLink,
  LinearPublicationShell,
  LinearSubmitCredentialsInput,
  LinearPersonalTokenInput,
  LinearPersonalTokenResult,
  LinearDispatchRule,
  LinearDispatchRuleInput,
  PublishWizardInput,
  SessionSummary,
  SlackInstallation,
  SlackPublication,
  SlackSubmitCredentialsInput,
  TelegramConnection,
  TelegramConnectInput,
} from "./types";

export interface IntegrationsApiOptions {
  basePath?: string;
}

async function request<T = unknown>(
  basePath: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetch(`${basePath}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    // Server may emit either the legacy `{error: "<str>", details?}` shape
    // (older endpoints) or the Anthropic-compat envelope `{type:"error",
    // error:{type, message}, request_id}`. Honor both so thrown errors
    // carry a real message either way.
    const body = (await res.json().catch(() => ({}))) as {
      error?: string | { message?: string };
      details?: string;
    };
    let msg: string;
    if (body.details) msg = body.details;
    else if (typeof body.error === "string") msg = body.error;
    else if (body.error && typeof body.error === "object" && body.error.message)
      msg = body.error.message;
    else msg = `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return (await res.json()) as T;
}

// ─── Linear sub-client ─────────────────────────────────────────────────

class LinearClient {
  constructor(private readonly basePath: string) {}

  async listInstallations(): Promise<LinearInstallation[]> {
    const r = await request<{ data: LinearInstallation[] }>(
      this.basePath,
      "/v1/integrations/linear/installations",
    );
    return r.data;
  }

  async listPublications(installationId: string): Promise<LinearPublication[]> {
    const r = await request<{ data: LinearPublication[] }>(
      this.basePath,
      `/v1/integrations/linear/installations/${encodeURIComponent(installationId)}/publications`,
    );
    return r.data;
  }

  async listAgentPublications(agentId: string): Promise<LinearPublication[]> {
    const r = await request<{ data: LinearPublication[] }>(
      this.basePath,
      `/v1/integrations/linear/agents/${encodeURIComponent(agentId)}/publications`,
    );
    return r.data;
  }

  /**
   * Publications owned by the calling user that are still in-progress
   * (pending_setup / credentials_filled / awaiting_install). Used by the
   * Console list page to surface refresh-resumable wizard runs alongside
   * live workspaces.
   */
  async listPendingPublications(): Promise<LinearPublication[]> {
    const r = await request<{ data: LinearPublication[] }>(
      this.basePath,
      "/v1/integrations/linear/publications?status=pending",
    );
    return r.data;
  }

  /**
   * Re-derive the publication shell (callback/webhook URLs) for an existing
   * pub. Linear doesn't use a formToken — its wizard keys directly off
   * publicationId — so the response shape matches `createPublication`.
   * Server-side validates status and ownership; throws on 404 / 409.
   */
  async reissueFormToken(publicationId: string): Promise<LinearPublicationShell> {
    return request<LinearPublicationShell>(
      this.basePath,
      `/v1/integrations/linear/publications/${encodeURIComponent(publicationId)}/form-token`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  async getPublication(id: string): Promise<LinearPublication> {
    return request<LinearPublication>(
      this.basePath,
      `/v1/integrations/linear/publications/${encodeURIComponent(id)}`,
    );
  }

  async updatePublication(
    id: string,
    patch: {
      persona?: Partial<{ name: string; avatarUrl: string | null }>;
      capabilities?: string[];
    },
  ): Promise<LinearPublication> {
    return request<LinearPublication>(
      this.basePath,
      `/v1/integrations/linear/publications/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  }

  async unpublish(id: string): Promise<void> {
    await request(
      this.basePath,
      `/v1/integrations/linear/publications/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  async startA1(input: PublishWizardInput): Promise<A1FormStep> {
    return request<A1FormStep>(this.basePath, "/v1/integrations/linear/start-a1", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Whether this deployment has a managed Linear app configured. */
  async managedAvailability(): Promise<{ available: boolean }> {
    try {
      return await request<{ available: boolean }>(
        this.basePath,
        "/v1/integrations/linear/managed-availability",
      );
    } catch {
      return { available: false };
    }
  }

  /**
   * One-click install via OMA's managed Linear app — skips the BYOA
   * credentials form and returns the OAuth authorize URL directly, staged
   * server-side with this deployment's managed App credentials. Throws
   * (surfaced as a 503) when no managed App is configured.
   */
  async startManaged(input: PublishWizardInput): Promise<A1InstallLink> {
    return request<A1InstallLink>(this.basePath, "/v1/integrations/linear/start-managed", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async submitCredentials(input: LinearSubmitCredentialsInput): Promise<A1InstallLink> {
    return request<A1InstallLink>(this.basePath, "/v1/integrations/linear/credentials", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async createHandoffLink(formToken: string): Promise<HandoffLink> {
    return request<HandoffLink>(this.basePath, "/v1/integrations/linear/handoff-link", {
      method: "POST",
      body: JSON.stringify({ formToken }),
    });
  }

  // ─── Linear: publication-first install (new wizard surface) ─────────
  //
  // Replaces startA1 + submitCredentials. Each call writes to exactly one
  // anchor row server-side; the publication is the durable identity from
  // step 1 onward.

  async createPublication(input: PublishWizardInput): Promise<LinearPublicationShell> {
    return request<LinearPublicationShell>(
      this.basePath,
      "/v1/integrations/linear/publications",
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  async submitCredentialsForPublication(
    publicationId: string,
    input: LinearPublicationCredentialsInput,
  ): Promise<LinearPublicationInstallLink> {
    return request<LinearPublicationInstallLink>(
      this.basePath,
      `/v1/integrations/linear/publications/${encodeURIComponent(publicationId)}/credentials`,
      { method: "PATCH", body: JSON.stringify(input) },
    );
  }

  /** Symphony-equivalent install: paste a Linear PAT, get a publication. */
  async installPersonalToken(input: LinearPersonalTokenInput): Promise<LinearPersonalTokenResult> {
    return request<LinearPersonalTokenResult>(
      this.basePath,
      "/v1/integrations/linear/personal-token",
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  // ─── Linear: dispatch rules CRUD ────────────────────────────────────

  async listDispatchRules(publicationId: string): Promise<LinearDispatchRule[]> {
    const r = await request<{ rules: LinearDispatchRule[] }>(
      this.basePath,
      `/v1/integrations/linear/publications/${encodeURIComponent(publicationId)}/dispatch-rules`,
    );
    return r.rules;
  }

  async createDispatchRule(
    publicationId: string,
    input: LinearDispatchRuleInput,
  ): Promise<LinearDispatchRule> {
    return request<LinearDispatchRule>(
      this.basePath,
      `/v1/integrations/linear/publications/${encodeURIComponent(publicationId)}/dispatch-rules`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  async updateDispatchRule(
    publicationId: string,
    ruleId: string,
    patch: LinearDispatchRuleInput,
  ): Promise<LinearDispatchRule> {
    return request<LinearDispatchRule>(
      this.basePath,
      `/v1/integrations/linear/publications/${encodeURIComponent(publicationId)}/dispatch-rules/${encodeURIComponent(ruleId)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  }

  async deleteDispatchRule(publicationId: string, ruleId: string): Promise<void> {
    await request<unknown>(
      this.basePath,
      `/v1/integrations/linear/publications/${encodeURIComponent(publicationId)}/dispatch-rules/${encodeURIComponent(ruleId)}`,
      { method: "DELETE" },
    );
  }
}

// ─── GitHub sub-client ─────────────────────────────────────────────────

class GitHubClient {
  constructor(private readonly basePath: string) {}

  async listInstallations(): Promise<GitHubInstallation[]> {
    const r = await request<{ data: GitHubInstallation[] }>(
      this.basePath,
      "/v1/integrations/github/installations",
    );
    return r.data;
  }

  async listPublications(installationId: string): Promise<GitHubPublication[]> {
    const r = await request<{ data: GitHubPublication[] }>(
      this.basePath,
      `/v1/integrations/github/installations/${encodeURIComponent(installationId)}/publications`,
    );
    return r.data;
  }

  /** Live GitHub-side detail (permissions, repo selection, install date,
   *  repo names) for one connected account. */
  async installationDetail(installationId: string): Promise<GitHubInstallationDetail> {
    return request<GitHubInstallationDetail>(
      this.basePath,
      `/v1/integrations/github/installations/${encodeURIComponent(installationId)}/detail`,
    );
  }

  /** Detach a connected account from this workspace. The App stays installed
   *  on github.com — the user removes it there if they want it fully gone. */
  async disconnectInstallation(installationId: string): Promise<void> {
    await request(
      this.basePath,
      `/v1/integrations/github/installations/${encodeURIComponent(installationId)}`,
      { method: "DELETE" },
    );
  }

  /**
   * Publications still in-progress (pending_setup / credentials_filled /
   * awaiting_install). Used by the list page's "In-progress installs"
   * section so a half-finished wizard run is visible.
   */
  async listPendingPublications(): Promise<GitHubPublication[]> {
    const r = await request<{ data: GitHubPublication[] }>(
      this.basePath,
      "/v1/integrations/github/publications?status=pending",
    );
    return r.data;
  }

  /** Re-issue a fresh formToken for an existing pub shell (refresh-resume). */
  async reissueFormToken(publicationId: string): Promise<GitHubA1FormStep> {
    return request<GitHubA1FormStep>(
      this.basePath,
      `/v1/integrations/github/publications/${encodeURIComponent(publicationId)}/form-token`,
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  async getPublication(id: string): Promise<GitHubPublication> {
    return request<GitHubPublication>(
      this.basePath,
      `/v1/integrations/github/publications/${encodeURIComponent(id)}`,
    );
  }

  async updatePublication(
    id: string,
    patch: {
      persona?: Partial<{ name: string; avatarUrl: string | null }>;
      capabilities?: string[];
    },
  ): Promise<GitHubPublication> {
    return request<GitHubPublication>(
      this.basePath,
      `/v1/integrations/github/publications/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  }

  async unpublish(id: string): Promise<void> {
    await request(
      this.basePath,
      `/v1/integrations/github/publications/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  // ─── Install initiation (proxied through main → integrations gateway) ───

  async startA1(input: PublishWizardInput): Promise<GitHubA1FormStep> {
    return request<GitHubA1FormStep>(this.basePath, "/v1/integrations/github/start-a1", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Whether this deployment has a managed GitHub app configured. */
  async managedAvailability(): Promise<{ available: boolean }> {
    try {
      return await request<{ available: boolean }>(
        this.basePath,
        "/v1/integrations/github/managed-availability",
      );
    } catch {
      return { available: false };
    }
  }

  /**
   * One-click install via OMA's managed GitHub app — skips App registration
   * (manifest flow) entirely and returns the install URL directly, staged
   * server-side with this deployment's managed App credentials. Throws
   * (surfaced as a 503) when no managed App is configured.
   */
  async startManaged(input: PublishWizardInput): Promise<GitHubA1InstallLink> {
    return request<GitHubA1InstallLink>(this.basePath, "/v1/integrations/github/start-managed", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async submitCredentials(input: {
    formToken: string;
    appId: string;
    privateKey: string;
    webhookSecret: string;
    clientId?: string;
    clientSecret?: string;
  }): Promise<GitHubA1InstallLink> {
    return request<GitHubA1InstallLink>(this.basePath, "/v1/integrations/github/credentials", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async createHandoffLink(formToken: string): Promise<HandoffLink> {
    return request<HandoffLink>(this.basePath, "/v1/integrations/github/handoff-link", {
      method: "POST",
      body: JSON.stringify({ formToken }),
    });
  }

  // ─── Issues board (Console Kanban → "GitHub Issues" tab) ─────────────
  // Read-only proxies: the backend resolves the installation's vault, mints
  // a fresh installation token in the gateway, and calls the GitHub API —
  // the browser never sees a token.

  /** Repo picker options. Served from the integrations DB cache unless
   *  `refresh` forces a live GitHub read. */
  async listRepos(installationId: string, refresh = false): Promise<GitHubRepo[]> {
    const r = await request<{ data: GitHubRepo[] }>(
      this.basePath,
      `/v1/integrations/github/installations/${encodeURIComponent(installationId)}/repos${
        refresh ? "?refresh=1" : ""
      }`,
    );
    return r.data;
  }

  /** Users the board's repo can be assigned to. Backs the Assignee
   *  combobox; the field still accepts a typed login that isn't in here. */
  async listAssignees(
    installationId: string,
    repo: string,
    refresh = false,
  ): Promise<GitHubAssignee[]> {
    const params = new URLSearchParams({ repo });
    if (refresh) params.set("refresh", "1");
    const r = await request<{ data: GitHubAssignee[] }>(
      this.basePath,
      `/v1/integrations/github/installations/${encodeURIComponent(installationId)}/assignees?${params.toString()}`,
    );
    return r.data;
  }

  async listIssues(
    installationId: string,
    filters: GitHubIssueFilters,
  ): Promise<{ issues: GitHubIssue[]; totalCount: number }> {
    const params = new URLSearchParams({ repo: filters.repo });
    if (filters.state) params.set("state", filters.state);
    if (filters.labels) params.set("labels", filters.labels);
    if (filters.assignee) params.set("assignee", filters.assignee);
    if (filters.q) params.set("q", filters.q);
    if (filters.page) params.set("page", String(filters.page));
    const r = await request<{ data: GitHubIssue[]; total_count: number }>(
      this.basePath,
      `/v1/integrations/github/installations/${encodeURIComponent(installationId)}/issues?${params.toString()}`,
    );
    return { issues: r.data, totalCount: r.total_count };
  }
}

// ─── Slack sub-client ──────────────────────────────────────────────────

class SlackClient {
  constructor(private readonly basePath: string) {}

  async listInstallations(): Promise<SlackInstallation[]> {
    const r = await request<{ data: SlackInstallation[] }>(
      this.basePath,
      "/v1/integrations/slack/installations",
    );
    return r.data;
  }

  async listPublications(installationId: string): Promise<SlackPublication[]> {
    const r = await request<{ data: SlackPublication[] }>(
      this.basePath,
      `/v1/integrations/slack/installations/${encodeURIComponent(installationId)}/publications`,
    );
    return r.data;
  }

  async listAgentPublications(agentId: string): Promise<SlackPublication[]> {
    const r = await request<{ data: SlackPublication[] }>(
      this.basePath,
      `/v1/integrations/slack/agents/${encodeURIComponent(agentId)}/publications`,
    );
    return r.data;
  }

  /**
   * Publications still in-progress (pending_setup / credentials_filled /
   * awaiting_install). Used by the list page's "In-progress installs"
   * section so a half-finished wizard run is visible.
   */
  async listPendingPublications(): Promise<SlackPublication[]> {
    const r = await request<{ data: SlackPublication[] }>(
      this.basePath,
      "/v1/integrations/slack/publications?status=pending",
    );
    return r.data;
  }

  /** Re-issue a fresh formToken for an existing pub shell (refresh-resume). */
  async reissueFormToken(publicationId: string, returnUrl?: string): Promise<A1FormStep> {
    return request<A1FormStep>(
      this.basePath,
      `/v1/integrations/slack/publications/${encodeURIComponent(publicationId)}/form-token`,
      { method: "POST", body: JSON.stringify({ returnUrl: returnUrl ?? "" }) },
    );
  }

  async getPublication(id: string): Promise<SlackPublication> {
    return request<SlackPublication>(
      this.basePath,
      `/v1/integrations/slack/publications/${encodeURIComponent(id)}`,
    );
  }

  async updatePublication(
    id: string,
    patch: {
      persona?: Partial<{ name: string; avatarUrl: string | null }>;
      capabilities?: string[];
    },
  ): Promise<SlackPublication> {
    return request<SlackPublication>(
      this.basePath,
      `/v1/integrations/slack/publications/${encodeURIComponent(id)}`,
      { method: "PATCH", body: JSON.stringify(patch) },
    );
  }

  async unpublish(id: string): Promise<void> {
    await request(
      this.basePath,
      `/v1/integrations/slack/publications/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  }

  async startA1(input: PublishWizardInput): Promise<A1FormStep> {
    return request<A1FormStep>(this.basePath, "/v1/integrations/slack/start-a1", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Whether this deployment has a managed Slack app configured. */
  async managedAvailability(): Promise<{ available: boolean }> {
    try {
      return await request<{ available: boolean }>(
        this.basePath,
        "/v1/integrations/slack/managed-availability",
      );
    } catch {
      return { available: false };
    }
  }

  /**
   * "Add to Slack" one-click install. Skips the BYOA credentials form —
   * returns the Slack OAuth authorize URL directly, staged server-side
   * with this deployment's managed App credentials. Throws (surfaced as
   * a 503) when no managed App is configured; callers should fall back
   * to `startA1`.
   */
  async startManaged(input: PublishWizardInput): Promise<A1InstallLink> {
    return request<A1InstallLink>(this.basePath, "/v1/integrations/slack/start-managed", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async submitCredentials(input: SlackSubmitCredentialsInput): Promise<A1InstallLink> {
    return request<A1InstallLink>(this.basePath, "/v1/integrations/slack/credentials", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  async createHandoffLink(formToken: string): Promise<HandoffLink> {
    return request<HandoffLink>(this.basePath, "/v1/integrations/slack/handoff-link", {
      method: "POST",
      body: JSON.stringify({ formToken }),
    });
  }
}

// ─── Telegram sub-client ───────────────────────────────────────────────
//
// Telegram has no OAuth install flow: a tenant either links to the
// deployment's shared bot or pastes its own BotFather token. Chats are
// captured via the deep-link handshake (`/link` mints a nonce, `/link/poll`
// reads back the `/start <nonce>` the user sent from the chat).

class TelegramClient {
  constructor(private readonly basePath: string) {}

  status(): Promise<TelegramConnection> {
    return request<TelegramConnection>(this.basePath, "/v1/integrations/telegram");
  }

  connect(input: TelegramConnectInput): Promise<TelegramConnection> {
    return request<TelegramConnection>(this.basePath, "/v1/integrations/telegram/connect", {
      method: "POST",
      body: JSON.stringify(input),
    });
  }

  /** Mint a fresh deep link — the previous one stops working. */
  newLink(): Promise<TelegramConnection> {
    return request<TelegramConnection>(this.basePath, "/v1/integrations/telegram/link", {
      method: "POST",
      body: JSON.stringify({}),
    });
  }

  /** Read back any chat that sent `/start <nonce>` since the last poll. */
  pollLink(): Promise<TelegramConnection & { linked: number }> {
    return request<TelegramConnection & { linked: number }>(
      this.basePath,
      "/v1/integrations/telegram/link/poll",
      { method: "POST", body: JSON.stringify({}) },
    );
  }

  addChat(chatId: string, title?: string): Promise<TelegramConnection> {
    return request<TelegramConnection>(this.basePath, "/v1/integrations/telegram/chats", {
      method: "POST",
      body: JSON.stringify({ chat_id: chatId, title }),
    });
  }

  removeChat(chatId: number): Promise<TelegramConnection> {
    return request<TelegramConnection>(
      this.basePath,
      `/v1/integrations/telegram/chats/${encodeURIComponent(String(chatId))}`,
      { method: "DELETE" },
    );
  }

  async disconnect(): Promise<void> {
    const res = await fetch(`${this.basePath}/v1/integrations/telegram`, {
      method: "DELETE",
      credentials: "include",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  }
}

// ─── Public surface ────────────────────────────────────────────────────

export class IntegrationsApi {
  private readonly basePath: string;
  readonly linear: LinearClient;
  readonly slack: SlackClient;
  readonly github: GitHubClient;
  readonly telegram: TelegramClient;

  constructor(opts: IntegrationsApiOptions = {}) {
    const basePath = opts.basePath ?? "";
    this.basePath = basePath;
    this.linear = new LinearClient(basePath);
    this.slack = new SlackClient(basePath);
    this.github = new GitHubClient(basePath);
    this.telegram = new TelegramClient(basePath);
  }

  // ─── Linear backward-compat shims ─────────────────────────────────────
  // Existing Linear pages call `api.listInstallations()` directly. Keep these
  // delegating to `linear.*` so the page diffs stay zero. New code should
  // prefer `api.linear.*` or `api.slack.*`.

  listInstallations(): Promise<LinearInstallation[]> {
    return this.linear.listInstallations();
  }
  listPublications(installationId: string): Promise<LinearPublication[]> {
    return this.linear.listPublications(installationId);
  }
  getPublication(id: string): Promise<LinearPublication> {
    return this.linear.getPublication(id);
  }
  updatePublication(
    id: string,
    patch: { persona?: Partial<{ name: string; avatarUrl: string | null }>; capabilities?: string[] },
  ): Promise<LinearPublication> {
    return this.linear.updatePublication(id, patch);
  }
  unpublish(id: string): Promise<void> {
    return this.linear.unpublish(id);
  }
  startA1(input: PublishWizardInput): Promise<A1FormStep> {
    return this.linear.startA1(input);
  }
  submitCredentials(input: LinearSubmitCredentialsInput): Promise<A1InstallLink> {
    return this.linear.submitCredentials(input);
  }
  createHandoffLink(formToken: string): Promise<HandoffLink> {
    return this.linear.createHandoffLink(formToken);
  }
  installPersonalToken(input: LinearPersonalTokenInput): Promise<LinearPersonalTokenResult> {
    return this.linear.installPersonalToken(input);
  }
  listDispatchRules(publicationId: string): Promise<LinearDispatchRule[]> {
    return this.linear.listDispatchRules(publicationId);
  }
  createDispatchRule(publicationId: string, input: LinearDispatchRuleInput): Promise<LinearDispatchRule> {
    return this.linear.createDispatchRule(publicationId, input);
  }
  updateDispatchRule(publicationId: string, ruleId: string, patch: LinearDispatchRuleInput): Promise<LinearDispatchRule> {
    return this.linear.updateDispatchRule(publicationId, ruleId, patch);
  }
  deleteDispatchRule(publicationId: string, ruleId: string): Promise<void> {
    return this.linear.deleteDispatchRule(publicationId, ruleId);
  }

  // ─── Sessions (used by the integrations activity timeline) ────────────
  //
  // /v1/sessions returns the user's full session set with metadata; we
  // filter client-side. For active integrations this is fine — sessions are
  // bounded per user — but a future paged endpoint with provider-side
  // filtering would be cleaner. Lives on IntegrationsApi directly because
  // it's not provider-scoped.

  async listSessions(opts: { limit?: number } = {}): Promise<SessionSummary[]> {
    const limit = opts.limit ?? 50;
    const r = await request<{ data: SessionSummary[] }>(
      this.basePath,
      `/v1/sessions?limit=${limit}`,
    );
    return r.data;
  }
}

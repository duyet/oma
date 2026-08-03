// GitHubProvider.handleManagedWebhook — the shared managed GitHub App's
// webhook receiver (POST /github/webhook/managed). Unlike handleWebhook
// (keyed on the per-App appOmaId in the path), this route has no
// per-publication id to key off — it resolves the publication from the
// payload's `installation.id` via findByInstallationId instead.

import { describe, expect, it } from "vitest";
import type { Persona, WebhookRequest } from "@duyet/oma-integrations-core";
import { GitHubProvider } from "./provider";
import { buildFakeGitHubContainer } from "./test-fakes";

const PERSONA: Persona = { name: "Coder", avatarUrl: null };
const MANAGED_APP = {
  appId: "123456",
  appSlug: "oma-managed-bot",
  botLogin: "oma-managed-bot[bot]",
  privateKey: "MANAGED_PRIVATE_KEY_PEM",
  webhookSecret: "MANAGED_WEBHOOK_SECRET",
};

function signedRequest(body: string, secret: string): WebhookRequest {
  return {
    providerId: "github",
    installationId: null,
    deliveryId: "delivery_1",
    headers: {
      "x-github-signature-256": "",
      "x-hub-signature-256": `sha256=expected:${secret}:${body}`,
      "x-github-event": "issues",
    },
    rawBody: body,
  };
}

describe("GitHubProvider.handleManagedWebhook", () => {
  it("reports unavailable when no managed App is configured", async () => {
    const container = buildFakeGitHubContainer();
    const provider = new GitHubProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      defaultCapabilities: ["issue.read"],
      mcpServerUrl: "https://api.githubcopilot.com/mcp/",
      managedApp: null,
    });

    const outcome = await provider.handleManagedWebhook(
      signedRequest(JSON.stringify({ installation: { id: 999 } }), "whatever"),
    );
    expect(outcome).toEqual({ handled: false, reason: "managed_app_not_configured" });
  });

  it("rejects a bad signature", async () => {
    const container = buildFakeGitHubContainer();
    const provider = new GitHubProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      defaultCapabilities: ["issue.read"],
      mcpServerUrl: "https://api.githubcopilot.com/mcp/",
      managedApp: MANAGED_APP,
    });

    const body = JSON.stringify({ installation: { id: 999 } });
    const outcome = await provider.handleManagedWebhook({
      providerId: "github",
      installationId: null,
      deliveryId: "delivery_1",
      headers: { "x-hub-signature-256": "sha256=not-the-right-signature" },
      rawBody: body,
    });
    expect(outcome).toEqual({ handled: false, reason: "invalid_signature" });
  });

  it("resolves the publication by installation id and dispatches", async () => {
    const container = buildFakeGitHubContainer();
    const provider = new GitHubProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      defaultCapabilities: ["issue.read"],
      mcpServerUrl: "https://api.githubcopilot.com/mcp/",
      managedApp: MANAGED_APP,
    });

    const started = await provider.startManagedInstall({
      userId: "user_1",
      agentId: "agent_1",
      environmentId: "env_1",
      mode: "full",
      persona: PERSONA,
      returnUrl: "https://console.example.com/integrations/github",
    });
    expect(started.kind).toBe("step");
    const publicationId = (started as { data: Record<string, unknown> }).data
      .publicationId as string;

    // Simulate the install callback binding a GitHub installation onto the
    // publication (normally done by handleOAuthCallback after the user
    // completes the GitHub install flow).
    await container.publications.bindInstallation({
      publicationId,
      installationId: "998877", // GitHub's numeric installation id
      vaultId: "vault_1",
    });

    const body = JSON.stringify({
      action: "opened",
      installation: { id: 998877 },
      issue: { number: 1, title: "Test issue", body: "" },
      repository: { full_name: "acme/widgets" },
    });
    const outcome = await provider.handleManagedWebhook(
      signedRequest(body, MANAGED_APP.webhookSecret),
    );

    expect(outcome.handled).toBe(false); // not @-mentioned / no trigger label match
    expect(outcome.reason).not.toBe("unknown_installation");
    expect(outcome.reason).not.toBe("managed_app_not_configured");
    expect(outcome.reason).not.toBe("invalid_signature");
  });

  it("reports unknown_installation for an unbound installation id", async () => {
    const container = buildFakeGitHubContainer();
    const provider = new GitHubProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      defaultCapabilities: ["issue.read"],
      mcpServerUrl: "https://api.githubcopilot.com/mcp/",
      managedApp: MANAGED_APP,
    });

    const body = JSON.stringify({ installation: { id: 424242 } });
    const outcome = await provider.handleManagedWebhook(
      signedRequest(body, MANAGED_APP.webhookSecret),
    );
    expect(outcome).toEqual({ handled: false, reason: "unknown_installation" });
  });

  // `installation` lifecycle events are the fallback that keeps our rows
  // honest when the user acts on github.com and no browser redirect ever
  // reaches us.
  it("revokes the installation row on installation.deleted", async () => {
    const container = buildFakeGitHubContainer();
    const provider = new GitHubProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      defaultCapabilities: ["issue.read"],
      mcpServerUrl: "https://api.githubcopilot.com/mcp/",
      managedApp: MANAGED_APP,
    });

    await container.installations.insert({
      tenantId: "tenant_1",
      userId: "user_1",
      providerId: "github",
      workspaceId: "555000",
      workspaceName: "acme",
      installKind: "dedicated",
      appId: null,
      accessToken: "ghs_token",
      refreshToken: null,
      scopes: ["contents"],
      botUserId: MANAGED_APP.botLogin,
    });

    const body = JSON.stringify({ action: "deleted", installation: { id: 555000 } });
    const outcome = await provider.handleManagedWebhook({
      ...signedRequest(body, MANAGED_APP.webhookSecret),
      headers: {
        "x-hub-signature-256": `sha256=expected:${MANAGED_APP.webhookSecret}:${body}`,
        "x-github-event": "installation",
      },
    });

    expect(outcome).toEqual({ handled: true });
    const rows = await container.installations.listByUser("user_1", "github");
    expect(rows).toEqual([]);
  });

  it("ignores installation.created — the payload names no OMA user", async () => {
    const container = buildFakeGitHubContainer();
    const provider = new GitHubProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      defaultCapabilities: ["issue.read"],
      mcpServerUrl: "https://api.githubcopilot.com/mcp/",
      managedApp: MANAGED_APP,
    });

    const body = JSON.stringify({ action: "created", installation: { id: 555000 } });
    const outcome = await provider.handleManagedWebhook({
      ...signedRequest(body, MANAGED_APP.webhookSecret),
      headers: {
        "x-hub-signature-256": `sha256=expected:${MANAGED_APP.webhookSecret}:${body}`,
        "x-github-event": "installation",
      },
    });

    expect(outcome).toEqual({ handled: false, reason: "installation_created_ignored" });
    expect(await container.installations.listByUser("user_1", "github")).toEqual([]);
  });
});

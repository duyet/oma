// GitHubProvider.startManagedInstall — the "Add to GitHub" one-click flow.
// Skips the App Manifest wizard by staging this deployment's managed GitHub
// App identity directly onto a fresh publication shell, then returns the
// GitHub install URL. Mirrors packages/slack/src/provider.test.ts's coverage
// of SlackProvider.startManagedInstall.

import { describe, expect, it } from "vitest";
import type { Persona } from "@duyet/oma-integrations-core";
import { GitHubProvider } from "./provider";
import { buildFakeGitHubContainer } from "./test-fakes";

const PERSONA: Persona = { name: "Coder", avatarUrl: null };

describe("GitHubProvider.startManagedInstall", () => {
  it("throws a clear error when no managed App is configured", async () => {
    const container = buildFakeGitHubContainer();
    const provider = new GitHubProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      defaultCapabilities: ["issue.read"],
      mcpServerUrl: "https://api.githubcopilot.com/mcp/",
      managedApp: null,
    });

    await expect(
      provider.startManagedInstall({
        userId: "user_1",
        agentId: "agent_1",
        environmentId: "env_1",
        mode: "full",
        persona: PERSONA,
        returnUrl: "https://console.example.com/integrations/github",
      }),
    ).rejects.toThrow(/no managed App configured/i);
  });

  it("stages managed credentials and returns the GitHub install URL directly", async () => {
    const container = buildFakeGitHubContainer();
    const provider = new GitHubProvider(container, {
      gatewayOrigin: "https://gw.example.com",
      defaultCapabilities: ["issue.read"],
      mcpServerUrl: "https://api.githubcopilot.com/mcp/",
      managedApp: {
        appId: "123456",
        appSlug: "oma-managed-bot",
        botLogin: "oma-managed-bot[bot]",
        privateKey: "MANAGED_PRIVATE_KEY_PEM",
        webhookSecret: "MANAGED_WEBHOOK_SECRET",
      },
    });

    const result = await provider.startManagedInstall({
      userId: "user_1",
      agentId: "agent_1",
      environmentId: "env_1",
      mode: "full",
      persona: PERSONA,
      returnUrl: "https://console.example.com/integrations/github",
    });

    expect(result.kind).toBe("step");
    expect(result.step).toBe("install_link");
    const data = result.data as {
      url: string;
      publicationId: string;
      appOmaId: string;
      appSlug: string;
      botLogin: string;
      setupUrl: string;
      webhookUrl: string;
    };
    expect(data.publicationId).toBeTruthy();
    expect(data.appOmaId).toBeTruthy();
    expect(data.appSlug).toBe("oma-managed-bot");
    expect(data.botLogin).toBe("oma-managed-bot[bot]");
    expect(data.url).toContain("oma-managed-bot");
    // The managed App is shared and has exactly ONE Setup URL on github.com,
    // so the reported setupUrl must be the fixed managed callback — NOT the
    // per-publication one a BYOA App uses. Wiring the per-publication URL
    // onto the shared App would break every other managed install.
    expect(data.setupUrl).toBe("https://gw.example.com/github/managed/callback");
    expect(data.webhookUrl).toContain(data.appOmaId);

    // The managed callback dispatches on the state JWT's `kind` and reads
    // the publication id off it (there's no pub id in that URL's path), so
    // both fields have to be present for the install to complete.
    const installState = new URL(data.url).searchParams.get("state")!;
    const decoded = await container.jwt.verify<{ kind: string; publicationId: string }>(
      installState,
    );
    expect(decoded.kind).toBe("github.install.pub");
    expect(decoded.publicationId).toBe(data.publicationId);

    // Publication shell is created and immediately promoted to
    // awaiting_install — no user credentials-paste step needed.
    const pub = await container.publications.get(data.publicationId);
    expect(pub?.status).toBe("awaiting_install");

    // Credential staging landed on the publication row.
    const credState = await container.publications.getCredentialState(data.publicationId);
    expect(credState?.appId).toBe("123456");
    expect(credState?.appSlug).toBe("oma-managed-bot");
    expect(credState?.botLogin).toBe("oma-managed-bot[bot]");
    expect(credState?.hasPrivateKey).toBe(true);
    expect(credState?.hasWebhookSecret).toBe(true);

    // github_apps dual-write happened, keyed on the pre-allocated appOmaId.
    const appRow = await container.githubApps.get(data.appOmaId);
    expect(appRow?.appId).toBe("123456");
    expect(appRow?.publicationId).toBe(data.publicationId);
  });
});

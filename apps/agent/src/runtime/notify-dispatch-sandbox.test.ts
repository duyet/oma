// Sandbox lifecycle notifications (issue #80). Asserts the opt-in filter,
// the never-throw contract shared with the session-status path, fail-open
// rate limiting, and that no credential-shaped text reaches the payload.

import { describe, expect, it } from "vitest";
import { FakeHttpClient } from "@duyet/oma-integrations-core/test-fakes";
import type { HttpClient, SessionNotifyEvent } from "@duyet/oma-integrations-core";
import type { NotificationTarget } from "@duyet/oma-api-types";
import { dispatchSandboxNotifications, redactSecrets } from "./notify-dispatch";

const webhookTarget: NotificationTarget = {
  type: "webhook",
  url: "https://hooks.example.com/agent",
  secret_ref: "cred_webhook_secret",
  sandbox_events: ["provision_failed", "unhealthy"],
};

const event: SessionNotifyEvent & { status: "sandbox_provision_failed" } = {
  sessionId: "sess_1",
  status: "sandbox_provision_failed",
  agentName: "Reviewer",
  tenantId: "tenant_a",
  sandboxProvider: "k8s-remote",
  sandboxPhase: "warmup",
  detail: "container failed to start",
};

function depsFor(
  overrides: Partial<{
    onError: (t: NotificationTarget, e: unknown) => void;
    sandboxNotifyRateLimitGate: { consume: (k: string) => Promise<{ ok: boolean }> };
    httpClient: HttpClient;
    resolveSecret: (id?: string) => Promise<string | null>;
  }> = {},
) {
  return {
    resolveCredentialToken: async () => "tok",
    resolveSecret: async (id?: string) => (id === "cred_webhook_secret" ? "topsecret" : null),
    httpClient: new FakeHttpClient(),
    tenantId: "tenant_a",
    ...overrides,
  };
}

describe("sandbox notifications", () => {
  it("delivers to a target subscribed to the fired kind", async () => {
    const http = new FakeHttpClient();
    await dispatchSandboxNotifications(event, "provision_failed", [webhookTarget], depsFor({ httpClient: http }));

    expect(http.calls).toHaveLength(1);
    const payload = JSON.parse(http.calls[0].body ?? "") as Record<string, unknown>;
    expect(payload.status).toBe("sandbox_provision_failed");
    expect(payload.session_id).toBe("sess_1");
    expect(payload.tenant_id).toBe("tenant_a");
    expect(payload.sandbox_provider).toBe("k8s-remote");
    expect(payload.sandbox_phase).toBe("warmup");
    expect(http.calls[0].headers?.["x-oma-event"]).toBe("sandbox_provision_failed");
  });

  it("does not deliver to a target that opted into no sandbox events", async () => {
    const http = new FakeHttpClient();
    const plain: NotificationTarget = { type: "webhook", url: "https://hooks.example.com/agent" };
    await dispatchSandboxNotifications(event, "provision_failed", [plain], depsFor({ httpClient: http }));
    expect(http.calls).toHaveLength(0);
  });

  it("honors the sandbox_events filter — an unsubscribed kind is dropped", async () => {
    const http = new FakeHttpClient();
    const onlyUnhealthy: NotificationTarget = { ...webhookTarget, sandbox_events: ["unhealthy"] };
    await dispatchSandboxNotifications(event, "provision_failed", [onlyUnhealthy], depsFor({ httpClient: http }));
    expect(http.calls).toHaveLength(0);

    await dispatchSandboxNotifications(
      { ...event, status: "sandbox_unhealthy" },
      "unhealthy",
      [onlyUnhealthy],
      depsFor({ httpClient: http }),
    );
    expect(http.calls).toHaveLength(1);
  });

  it("ignores the session-only `events` filter, which never gates sandbox statuses", async () => {
    const http = new FakeHttpClient();
    const target: NotificationTarget = { ...webhookTarget, events: ["idle"] };
    await dispatchSandboxNotifications(event, "provision_failed", [target], depsFor({ httpClient: http }));
    expect(http.calls).toHaveLength(1);
  });

  it("skips an unresolvable target, reports it, and never throws", async () => {
    const errors: unknown[] = [];
    const http = new FakeHttpClient();
    const slack: NotificationTarget = {
      type: "slack_message",
      credential_id: "cred_missing",
      channel: "C123",
      sandbox_events: ["provision_failed"],
    };
    await expect(
      dispatchSandboxNotifications(event, "provision_failed", [slack, webhookTarget], {
        ...depsFor({ httpClient: http }),
        resolveCredentialToken: async () => null,
        onError: (_t, e) => errors.push(e),
      }),
    ).resolves.toBeUndefined();

    expect(errors.map((e) => (e as Error).message)).toContainEqual(
      expect.stringContaining("no credential token resolved"),
    );
    // The healthy webhook target still delivered.
    expect(http.calls).toHaveLength(1);
  });

  it("never throws when a provider call itself blows up", async () => {
    const errors: unknown[] = [];
    const exploding: HttpClient = {
      fetch: async () => {
        throw new Error("network down");
      },
    };
    await expect(
      dispatchSandboxNotifications(event, "provision_failed", [webhookTarget], {
        ...depsFor(),
        httpClient: exploding,
        onError: (_t, e) => errors.push(e),
      }),
    ).resolves.toBeUndefined();
    expect((errors[0] as Error).message).toContain("network down");
  });

  it("drops the whole fan-out fail-open when the rate limit is exhausted", async () => {
    const http = new FakeHttpClient();
    const errors: unknown[] = [];
    const keys: string[] = [];
    await dispatchSandboxNotifications(event, "provision_failed", [webhookTarget], {
      ...depsFor({ httpClient: http }),
      sandboxNotifyRateLimitGate: {
        consume: async (k: string) => {
          keys.push(k);
          return { ok: false };
        },
      },
      onError: (_t, e) => errors.push(e),
    });
    expect(keys).toEqual(["sandbox-notify:tenant_a"]);
    expect(http.calls).toHaveLength(0);
    expect((errors[0] as Error).message).toContain("rate limit exceeded");
  });

  it("delivers when the rate-limit gate allows the fan-out", async () => {
    const http = new FakeHttpClient();
    await dispatchSandboxNotifications(event, "provision_failed", [webhookTarget], {
      ...depsFor({ httpClient: http }),
      sandboxNotifyRateLimitGate: { consume: async () => ({ ok: true }) },
    });
    expect(http.calls).toHaveLength(1);
  });

  it("redacts credential-shaped text out of the failure detail", async () => {
    const http = new FakeHttpClient();
    await dispatchSandboxNotifications(
      {
        ...event,
        detail:
          'pull failed for registry: Authorization: Bearer ghp_abcdefghijklmnop and token=sk-ant-verysecretvalue',
      },
      "provision_failed",
      [webhookTarget],
      depsFor({ httpClient: http }),
    );

    const body = http.calls[0].body ?? "";
    expect(body).not.toContain("ghp_abcdefghijklmnop");
    expect(body).not.toContain("sk-ant-verysecretvalue");
    expect(body).toContain("[redacted]");
    // The signing secret itself is never echoed into the payload either.
    expect(body).not.toContain("topsecret");
  });

  it("truncates a very long detail so no pod manifest / env dump rides along", () => {
    const long = "x".repeat(5000);
    expect(redactSecrets(long).length).toBeLessThanOrEqual(501);
  });
});

import { describe, expect, it, vi } from "vitest";
import { FakeHttpClient } from "@duyet/oma-integrations-core/test-fakes";
import type { NotificationTarget } from "@duyet/oma-api-types";
import { dispatchSessionNotifications, buildSessionStatusEmail } from "./notify-dispatch";

const githubTarget: NotificationTarget = {
  type: "github_comment",
  credential_id: "cred_gh",
  owner: "acme",
  repo: "widgets",
  issue_number: 7,
};
const slackTarget: NotificationTarget = {
  type: "slack_message",
  credential_id: "cred_slack",
  channel: "C123",
};
const matrixTarget: NotificationTarget = {
  type: "matrix_message",
  credential_id: "cred_matrix",
  homeserver_url: "https://matrix.example.com",
  room_id: "!room:example.com",
};
const telegramTarget: NotificationTarget = {
  type: "telegram_message",
  chat_id: -1001234567890,
};

const emailTarget: NotificationTarget = {
  type: "email",
  to: "ops@example.com",
  subject_prefix: "[oma]",
};

const event = { sessionId: "sess_1", status: "idle" as const, agentName: "Reviewer" };

function tokenResolverFor(map: Record<string, string | null>) {
  return async (credentialId?: string) => (credentialId ? map[credentialId] ?? null : null);
}

describe("dispatchSessionNotifications", () => {
  it("dispatches to all three provider types concurrently", async () => {
    // Route the canned response by target URL rather than call order — the
    // three dispatches run concurrently via Promise.allSettled, so the
    // order fetch() actually fires in is not guaranteed to match target order.
    const calls: Array<{ method: string; url: string; headers?: Record<string, string>; body?: string }> = [];
    const httpClient = {
      fetch: async (req: { method: string; url: string; headers?: Record<string, string>; body?: string }) => {
        calls.push(req);
        if (req.url.includes("api.github.com")) {
          return { status: 201, headers: {}, body: JSON.stringify({ id: 1, html_url: "https://github.com/acme/widgets/issues/7#issuecomment-1" }) };
        }
        if (req.url.includes("slack.com")) {
          return { status: 200, headers: {}, body: JSON.stringify({ ok: true, channel: "C123", ts: "1.1" }) };
        }
        return { status: 200, headers: {}, body: JSON.stringify({ event_id: "$abc:matrix.org" }) };
      },
    };

    await dispatchSessionNotifications(event, [githubTarget, slackTarget, matrixTarget], {
      resolveCredentialToken: tokenResolverFor({
        cred_gh: "ghs_token",
        cred_slack: "xoxb-token",
        cred_matrix: "mat_token",
      }),
      resolveSecret: async () => null,
      httpClient,
    });

    expect(calls).toHaveLength(3);
    const gh = calls.find((c) => c.url.includes("api.github.com"));
    const slack = calls.find((c) => c.url.includes("slack.com"));
    const matrix = calls.find((c) => c.url.includes("matrix.example.com"));
    expect(gh).toBeDefined();
    expect(gh?.headers?.authorization).toBe("Bearer ghs_token");
    expect(gh?.url).toBe("https://api.github.com/repos/acme/widgets/issues/7/comments");

    expect(slack).toBeDefined();
    expect(slack?.headers?.authorization).toBe("Bearer xoxb-token");
    expect(slack?.url).toBe("https://slack.com/api/chat.postMessage");
    const slackBody = JSON.parse(slack?.body ?? "{}") as { channel: string; text: string };
    expect(slackBody.channel).toBe("C123");

    expect(matrix).toBeDefined();
    expect(matrix?.headers?.authorization).toBe("Bearer mat_token");
    expect(matrix?.url).toContain("https://matrix.example.com/_matrix/client/v3/rooms/");
  });

  it("skips a target with no resolvable credential token, without throwing, and still dispatches the others", async () => {
    const calls: Array<{ url: string }> = [];
    const httpClient = {
      fetch: async (req: { url: string }) => {
        calls.push(req);
        if (req.url.includes("slack.com")) {
          return { status: 200, headers: {}, body: JSON.stringify({ ok: true, channel: "C123", ts: "1.1" }) };
        }
        return { status: 200, headers: {}, body: JSON.stringify({ event_id: "$abc:matrix.org" }) };
      },
    };
    const onError = vi.fn();

    await expect(
      dispatchSessionNotifications(event, [githubTarget, slackTarget, matrixTarget], {
        resolveCredentialToken: tokenResolverFor({
          cred_gh: null, // no token resolved for github
          cred_slack: "xoxb-token",
          cred_matrix: "mat_token",
        }),
        resolveSecret: async () => null,
        httpClient,
        onError,
      }),
    ).resolves.toBeUndefined();

    // github never reached the network — only slack + matrix fired.
    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.url.includes("api.github.com"))).toBe(false);
    expect(calls.some((c) => c.url.includes("slack.com"))).toBe(true);
    expect(calls.some((c) => c.url.includes("matrix.example.com"))).toBe(true);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(githubTarget);
  });

  it("skips a target whose provider call throws, calls onError, and still dispatches the others", async () => {
    const http = new FakeHttpClient();
    // Give matrix a bad response (403) so MatrixApiClient throws MatrixApiError,
    // while slack succeeds via the fallback response below. Route by URL
    // rather than relying on concurrent-call ordering.
    http.setFallback({ status: 200, headers: {}, body: JSON.stringify({ ok: true, channel: "C123", ts: "1.1" }) });
    const onError = vi.fn();

    await dispatchSessionNotifications(event, [slackTarget, matrixTarget], {
      resolveCredentialToken: tokenResolverFor({
        cred_slack: "xoxb-token",
        cred_matrix: "mat_token",
      }),
      resolveSecret: async () => null,
      httpClient: {
        fetch: async (req) => {
          if (req.url.includes("matrix.example.com")) {
            return { status: 403, headers: {}, body: JSON.stringify({ errcode: "M_FORBIDDEN" }) };
          }
          return http.fetch(req);
        },
      },
      onError,
    });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(matrixTarget);
    expect(onError.mock.calls[0][1]).toBeInstanceOf(Error);
    // slack still got its request in despite matrix failing.
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0].url).toBe("https://slack.com/api/chat.postMessage");
  });

  it("never throws even when every target fails", async () => {
    await expect(
      dispatchSessionNotifications(event, [githubTarget], {
        resolveCredentialToken: async () => {
          throw new Error("boom");
        },
        resolveSecret: async () => null,
        httpClient: new FakeHttpClient(),
      }),
    ).resolves.toBeUndefined();
  });

  it("posts to Telegram via the bot API when a bot token resolves", async () => {
    // TelegramClient.sendMessage POSTs through global fetch directly (not
    // deps.httpClient) — stub it and restore afterward so this test stays
    // isolated from the others.
    const calls: Array<{ url: string; body: string }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: 1, chat: { id: -1001234567890, type: "supergroup" }, date: 0 },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    try {
      await dispatchSessionNotifications(event, [telegramTarget], {
        resolveCredentialToken: async () => null,
        resolveSecret: async () => null,
        resolveTelegramBotToken: () => "bot_token_123",
        httpClient: new FakeHttpClient(),
      });
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.telegram.org/botbot_token_123/sendMessage");
    const body = JSON.parse(calls[0].body) as { chat_id: number; text: string; parse_mode: string };
    expect(body.chat_id).toBe(-1001234567890);
    expect(body.parse_mode).toBe("HTML");
    // ✅ icon for an "idle" status, followed by the shared summary line.
    expect(body.text).toBe('✅ Agent "Reviewer" session sess_1 finished and is waiting for input.');
  });

  it("skips a telegram_message target with no resolvable bot token, without throwing", async () => {
    let fetchCalled = false;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async () => {
      fetchCalled = true;
      throw new Error("fetch should not be called when no bot token resolves");
    }) as typeof fetch;
    const onError = vi.fn();

    try {
      await expect(
        dispatchSessionNotifications(event, [telegramTarget], {
          resolveCredentialToken: async () => null,
          resolveSecret: async () => null,
          resolveTelegramBotToken: () => null,
          httpClient: new FakeHttpClient(),
          onError,
        }),
      ).resolves.toBeUndefined();
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalled).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(telegramTarget);
  });

  it("sends an email target through the configured email sender", async () => {
    const sent: Array<{ to: string; subject: string; text: string; html: string }> = [];
    await dispatchSessionNotifications(
      { ...event, sessionUrl: "https://console.example.com/s/sess_1", finalMessage: "All done <ok>" },
      [emailTarget],
      {
        resolveCredentialToken: async () => null,
        resolveSecret: async () => null,
        httpClient: new FakeHttpClient(),
        resolveEmailSender: () => ({
          send: async (msg) => {
            sent.push(msg as (typeof sent)[number]);
          },
        }),
      },
    );

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe("ops@example.com");
    expect(sent[0].subject).toBe('[oma] Agent "Reviewer" session sess_1: idle');
    // Same status wording every other provider renders.
    expect(sent[0].text).toContain('Agent "Reviewer" session sess_1 finished and is waiting for input.');
    expect(sent[0].text).toContain("All done <ok>");
    expect(sent[0].text).toContain("Session: https://console.example.com/s/sess_1");
    // HTML body escapes the message text.
    expect(sent[0].html).toContain("All done &lt;ok&gt;");
  });

  it("renders the subject without a prefix when subject_prefix is unset", () => {
    const msg = buildSessionStatusEmail(
      { sessionId: "sess_2", status: "error" },
      { type: "email", to: "a@b.com" },
    );
    expect(msg.subject).toBe("Agent session sess_2: error");
  });

  it("fails open with a warning when no email sender is configured", async () => {
    const onError = vi.fn();
    await expect(
      dispatchSessionNotifications(event, [emailTarget], {
        resolveCredentialToken: async () => null,
        resolveSecret: async () => null,
        httpClient: new FakeHttpClient(),
        onError,
      }),
    ).resolves.toBeUndefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(emailTarget);
    expect(String((onError.mock.calls[0][1] as Error).message)).toContain("no email sender configured");
  });

  it("is a no-op when there are no targets", async () => {
    const http = new FakeHttpClient();
    await dispatchSessionNotifications(event, [], { resolveCredentialToken: async () => null, resolveSecret: async () => null, httpClient: http });
    expect(http.calls).toHaveLength(0);
  });
});

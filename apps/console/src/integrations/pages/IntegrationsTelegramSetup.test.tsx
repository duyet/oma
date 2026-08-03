import { describe, expect, it } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server";
import { IntegrationsTelegramSetup } from "./IntegrationsTelegramSetup";

function mockStatus(body: Record<string, unknown>) {
  server.use(http.get("/v1/integrations/telegram", () => HttpResponse.json(body)));
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/integrations/telegram"]}>
      <IntegrationsTelegramSetup />
    </MemoryRouter>,
  );
}

describe("<IntegrationsTelegramSetup />", () => {
  it("names the shared bot so the user knows who to message before connecting", async () => {
    mockStatus({
      connected: false,
      mode: null,
      shared_bot_available: true,
      shared_bot_username: "omatherobot",
      chats: [],
    });
    renderPage();

    const link = await screen.findByRole("link", { name: "@omatherobot" });
    expect(link.getAttribute("href")).toBe("https://t.me/omatherobot");
    // Both connect paths are offered side by side, GitHub-style.
    expect(
      screen.getByRole("button", { name: "Connect the shared OMA bot" }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Validate & connect" })).toBeTruthy();
  });

  it("collapses the shared column and leads with own-bot when no shared bot exists", async () => {
    mockStatus({
      connected: false,
      mode: null,
      shared_bot_available: false,
      shared_bot_username: null,
      chats: [],
    });
    renderPage();

    // Own-bot is the only path offered, and it is reachable.
    expect(
      await screen.findByRole("button", { name: "Validate & connect" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Connect the shared OMA bot" }),
    ).toBeNull();
    expect(screen.getByText(/shared bot isn't available/i)).toBeTruthy();
  });

  it("never shows operator env-var instructions to an end user", async () => {
    mockStatus({
      connected: false,
      mode: null,
      shared_bot_available: false,
      shared_bot_username: null,
      chats: [],
    });
    const { container } = renderPage();

    await screen.findByRole("button", { name: "Validate & connect" });
    // The missing-secret reason is an operator concern documented in
    // docs/integrations.md — the hosted console must not surface it.
    expect(container.textContent).not.toContain("TELEGRAM_SHARED_BOT_TOKEN");
    expect(container.textContent).not.toMatch(/ask your admin/i);
  });

  it("shows the deep-link handshake and linked chats once connected", async () => {
    mockStatus({
      connected: true,
      mode: "shared_bot",
      shared_bot_available: true,
      shared_bot_username: "omatherobot",
      bot_username: "omatherobot",
      bot_id: 111,
      has_token: false,
      start_url: "https://t.me/omatherobot?start=nonce123",
      start_group_url: "https://t.me/omatherobot?startgroup=nonce123",
      chats: [{ chat_id: -1001234567890, title: "Ops", type: "group", linked_at: 1 }],
    });
    renderPage();

    await waitFor(() =>
      expect(
        screen.getByRole("link", { name: "Open the bot in Telegram" }).getAttribute("href"),
      ).toBe("https://t.me/omatherobot?start=nonce123"),
    );
    expect(screen.getByText("-1001234567890")).toBeTruthy();
    expect(screen.getByRole("button", { name: "I've messaged the bot" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
    // The active mode is marked, and its card no longer re-offers Connect.
    expect(
      (screen.getByRole("button", { name: "Connected" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

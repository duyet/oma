import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

import {
  NotificationBell,
  NotificationProvider,
  useConsoleNotices,
} from "./NotificationCenter";
import { NOTICE_STORAGE_KEY } from "@/lib/console-notices";

function SeedAndBell() {
  const { publish } = useConsoleNotices();
  return (
    <>
      <button
        type="button"
        onClick={() =>
          publish({
            kind: "approval",
            sessionId: "sess_1",
            title: "Approval required",
            body: "bash on sess_1",
            href: "/sessions/sess_1",
            createdAt: Date.now(),
          })
        }
      >
        seed
      </button>
      <NotificationBell />
    </>
  );
}

describe("<NotificationBell />", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("lists a published notice and clears the unread mark when opened", async () => {
    render(
      <MemoryRouter>
        <NotificationProvider>
          <SeedAndBell />
        </NotificationProvider>
      </MemoryRouter>,
    );

    await userEvent.click(screen.getByRole("button", { name: "seed" }));
    expect(
      screen.getByRole("button", { name: "Notifications, 1 unread" }),
    ).toBeInTheDocument();

    await userEvent.click(
      screen.getByRole("button", { name: "Notifications, 1 unread" }),
    );
    expect(await screen.findByText("Approval required")).toBeInTheDocument();
    expect(screen.getByText("bash on sess_1")).toBeInTheDocument();
    expect(localStorage.getItem(NOTICE_STORAGE_KEY)).toContain("sess_1");
  });
});

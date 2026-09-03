import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ApprovalCard } from "./ApprovalCard";
import type { PendingApproval } from "@/lib/pending-approvals";

const approval: PendingApproval = {
  toolUseId: "call_1",
  toolName: "bash",
  input: { command: "rm -rf /workspace/build && npm run build" },
  sessionThreadId: "sthr_primary",
};

describe("<ApprovalCard />", () => {
  it("shows the tool name, input preview, and posts via the three actions", async () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    const onAllowAndRemember = vi.fn();
    render(
      <ApprovalCard
        approval={approval}
        onAllow={onAllow}
        onDeny={onDeny}
        onAllowAndRemember={onAllowAndRemember}
      />,
    );

    expect(screen.getByRole("region", { name: "Approval required" })).toBeInTheDocument();
    expect(screen.getByText("bash")).toBeInTheDocument();
    expect(
      screen.getByText("rm -rf /workspace/build && npm run build"),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Deny" }));
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    await userEvent.click(
      screen.getByRole("button", { name: /Approve and don't ask again this session/i }),
    );

    expect(onDeny).toHaveBeenCalledOnce();
    expect(onAllow).toHaveBeenCalledOnce();
    expect(onAllowAndRemember).toHaveBeenCalledOnce();
  });

  it("disables actions while a confirmation is in flight", async () => {
    const onAllow = vi.fn();
    render(
      <ApprovalCard
        approval={approval}
        busy
        onAllow={onAllow}
        onDeny={() => {}}
        onAllowAndRemember={() => {}}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onAllow).not.toHaveBeenCalled();
  });
});

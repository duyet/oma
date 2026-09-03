import { Button } from "@/components/ui/button"
import { previewToolInput } from "@/lib/pending-approvals"
import type { PendingApproval } from "@/lib/pending-approvals"

export function ApprovalCard({
  approval,
  busy = false,
  onAllow,
  onDeny,
  onAllowAndRemember,
}: {
  approval: PendingApproval
  busy?: boolean
  onAllow: () => void
  onDeny: () => void
  onAllowAndRemember: () => void
}) {
  const preview = previewToolInput(approval.input)
  return (
    <div
      role="region"
      aria-label="Approval required"
      className="mx-3 mb-2 rounded-xl border border-warning/40 bg-warning-subtle px-4 py-3 text-sm text-fg shrink-0"
    >
      <div className="font-medium text-fg">Approval required</div>
      <p className="mt-1 text-fg-muted">
        The agent wants to run <span className="font-mono text-fg">{approval.toolName}</span>
      </p>
      {preview ? (
        <pre className="mt-2 max-h-32 overflow-auto whitespace-pre-wrap break-all rounded-md bg-bg/60 px-3 py-2 font-mono text-[12px] text-fg">
          {preview}
        </pre>
      ) : null}
      <div className="mt-3 flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="destructive"
          disabled={busy}
          onClick={onDeny}
        >
          Deny
        </Button>
        <Button type="button" size="sm" disabled={busy} onClick={onAllow}>
          Approve
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={onAllowAndRemember}
        >
          Approve and don&apos;t ask again this session
        </Button>
      </div>
    </div>
  )
}

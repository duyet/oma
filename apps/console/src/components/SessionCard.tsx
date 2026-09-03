import { StatusPill } from "@/components/StatusPill"
import { formatCompact, formatRelative } from "@/lib/format"
import { rowActivateKeyDown } from "@/lib/utils"

export interface SessionCardModel {
  id: string
  title?: string | null
  status?: string
  created_at: string
  agentLabel: string
  input_tokens?: number | null
  output_tokens?: number | null
}

export function SessionCard({
  session,
  onActivate,
}: {
  session: SessionCardModel
  onActivate: () => void
}) {
  const tokens =
    (session.input_tokens ?? 0) + (session.output_tokens ?? 0)
  const created = Date.parse(session.created_at)
  const when = Number.isFinite(created) ? formatRelative(Date.now() - created) : ""
  return (
    <button
      type="button"
      onClick={onActivate}
      onKeyDown={rowActivateKeyDown(onActivate)}
      className="w-full rounded-xl border border-border bg-card px-4 py-3 text-left transition-colors hover:bg-muted/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-medium text-foreground">
            {session.title || "Untitled"}
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {session.agentLabel}
          </div>
        </div>
        <StatusPill status={session.status || "idle"} />
      </div>
      <div className="mt-2 flex items-center gap-3 text-[12px] text-muted-foreground">
        {when ? <span>{when}</span> : null}
        <span className="tabular-nums">
          {tokens > 0 ? `${formatCompact(tokens)} tokens` : "No tokens yet"}
        </span>
      </div>
    </button>
  )
}

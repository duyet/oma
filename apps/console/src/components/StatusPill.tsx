/**
 * Status pill — small colored chip that represents a state (idle / running /
 * completed / errored / terminated / warning). Used in session header + turn cards.
 *
 * Tones map to design-system status colors. `running` gets an animated dot
 * to communicate "in progress" without users staring for a status change.
 */
export type StatusTone = "idle" | "running" | "completed" | "errored" | "terminated" | "warning" | "neutral";

const TONE_CLASS: Record<StatusTone, string> = {
  idle: "bg-muted text-muted-foreground",
  running: "bg-info-subtle text-info",
  completed: "bg-success-subtle text-success",
  errored: "bg-danger-subtle text-danger",
  terminated: "bg-danger-subtle text-danger",
  warning: "bg-warning-subtle text-warning",
  neutral: "bg-muted text-muted-foreground",
};

export function StatusPill({ status, label }: { status: StatusTone | string; label?: string }) {
  const tone: StatusTone = (TONE_CLASS as Record<string, unknown>)[status] ? (status as StatusTone) : "neutral";
  const text = label ?? (status[0]?.toUpperCase() + status.slice(1));
  return (
    <span className={`text-[11px] px-2 py-0.5 rounded-2xl font-medium ${TONE_CLASS[tone]}`}>
      {tone === "running" && (
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-info animate-pulse mr-1.5 align-middle" />
      )}
      {text}
    </span>
  );
}

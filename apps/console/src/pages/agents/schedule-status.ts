import type { StatusTone } from "../../components/StatusPill";

export function scheduleStatusTone(status: string | null | undefined): StatusTone {
  switch (status) {
    case "ok":
      return "completed";
    case "error":
      return "errored";
    case "skipped_concurrency":
      return "warning";
    default:
      return "neutral";
  }
}

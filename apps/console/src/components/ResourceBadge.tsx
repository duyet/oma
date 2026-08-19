import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/**
 * Compact icon + label chip for resource / metric metadata (session header
 * agent/env/vault badges, agents list tool counts, etc.).
 *
 * Distinct from shadcn `Badge` (`@/components/ui/badge`) which is the
 * status/variant chip. This keeps the icon+label + optional click API that
 * those call sites need without colliding with the ui primitive name.
 */
export function ResourceBadge({
  icon,
  label,
  title,
  onClick,
  className,
}: {
  icon?: ReactNode;
  label: ReactNode;
  title?: string;
  onClick?: () => void;
  className?: string;
}) {
  const inner = (
    <>
      {icon && <span className="text-muted-foreground shrink-0 flex">{icon}</span>}
      <span className="truncate">{label}</span>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "text-[11px] px-2 py-0.5 min-h-11 sm:min-h-0 rounded-2xl border border-border hover:bg-muted text-muted-foreground flex items-center gap-1.5 font-mono max-w-xs",
          className,
        )}
        title={title ?? (typeof label === "string" ? label : undefined)}
      >
        {inner}
      </button>
    );
  }
  return (
    <span
      className={cn(
        "text-[11px] px-2 py-0.5 text-muted-foreground font-mono flex items-center gap-1.5",
        className,
      )}
      title={title}
    >
      {inner}
    </span>
  );
}

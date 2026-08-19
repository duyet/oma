import * as React from "react"
import { InfoIcon } from "lucide-react"

import { cn } from "@/lib/utils"

import { Tooltip, TooltipContent, TooltipTrigger } from "./tooltip"

function Input({
  className,
  type,
  label,
  labelTooltip,
  description,
  ...props
}: React.ComponentProps<"input"> & {
  label?: React.ReactNode
  labelTooltip?: React.ReactNode
  description?: React.ReactNode
}) {
  const field = (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-2xl border border-transparent bg-input/50 px-2.5 py-1 text-base transition-[color,box-shadow] duration-200 outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
        className,
      )}
      {...props}
    />
  )

  if (label == null && description == null) return field

  return (
    <label className="flex flex-col gap-1.5">
      {label != null && (
        <span className="inline-flex items-center gap-1 text-sm font-medium">
          {label}
          {labelTooltip != null && (
            <Tooltip>
              <TooltipTrigger asChild>
                <InfoIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              </TooltipTrigger>
              <TooltipContent>{labelTooltip}</TooltipContent>
            </Tooltip>
          )}
        </span>
      )}
      {field}
      {description != null && <p className="text-xs text-muted-foreground">{description}</p>}
    </label>
  )
}

export { Input }

import { cn } from "@/lib/utils"

const roundedClass = {
  none: "rounded-none",
  sm: "rounded-sm",
  md: "rounded-md",
  lg: "rounded-lg",
  xl: "rounded-xl",
  "2xl": "rounded-2xl",
  full: "rounded-full",
} as const

type SkeletonRounded = keyof typeof roundedClass

function Skeleton({
  className,
  rounded = "md",
  ...props
}: React.ComponentProps<"div"> & { rounded?: SkeletonRounded }) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse bg-muted", roundedClass[rounded], className)}
      {...props}
    />
  )
}

function SkeletonRows({
  count = 3,
  className,
}: {
  count?: number;
  className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  )
}

export { Skeleton, SkeletonRows }

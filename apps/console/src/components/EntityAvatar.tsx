import { Avatar as ShadcnAvatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
const SIZE: Record<"xs" | "sm" | "md" | "lg", string> = { xs: "size-5 text-[10px]", sm: "size-6 text-[11px]", md: "size-7 text-[12px]", lg: "size-8 text-[13px]" };
export function EntityAvatar({ name, src, size = "md", squared, className = "" }: { name: string; src?: string | null; size?: keyof typeof SIZE; squared?: boolean; className?: string; }) {
  const initial = (name?.trim().charAt(0) || "?").toUpperCase();
  const shape = squared ? "rounded-md after:rounded-md *:rounded-md" : "rounded-full";
  return (
    <ShadcnAvatar className={cn(SIZE[size], shape, "shrink-0", className)}>
      {src && <AvatarImage src={src} alt="" loading="lazy" decoding="async" className={squared ? "rounded-md" : undefined} />}
      <AvatarFallback className={cn("bg-brand-subtle text-brand font-mono font-bold", squared ? "rounded-md" : "rounded-full")}>{initial}</AvatarFallback>
    </ShadcnAvatar>
  );
}

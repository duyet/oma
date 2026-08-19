import { forwardRef, type ReactNode } from "react";
import { Select as ShadcnSelect, SelectContent as ShadcnSelectContent, SelectGroup as ShadcnSelectGroup, SelectItem, SelectLabel as ShadcnSelectLabel, SelectSeparator as ShadcnSelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";

export function Select({ value, onValueChange, placeholder, disabled, name, className, children }: { value: string; onValueChange: (value: string) => void; placeholder?: string; disabled?: boolean; name?: string; className?: string; children: ReactNode; }) {
  return (
    <ShadcnSelect value={value || undefined} onValueChange={onValueChange} disabled={disabled} name={name}>
      <SelectTrigger aria-label={placeholder} className={className ?? "w-full"}><SelectValue placeholder={placeholder} /></SelectTrigger>
      <ShadcnSelectContent>{children}</ShadcnSelectContent>
    </ShadcnSelect>
  );
}

export const SelectOption = forwardRef<HTMLDivElement, { value: string; disabled?: boolean; children: ReactNode }>(({ value, disabled, children }, ref) => (
  <SelectItem ref={ref} value={value} disabled={disabled}>{children}</SelectItem>
));
SelectOption.displayName = "SelectOption";
export function SelectGroupLabel({ children }: { children: ReactNode }) { return <ShadcnSelectLabel>{children}</ShadcnSelectLabel>; }
export function SelectGroup({ children }: { children: ReactNode }) { return <ShadcnSelectGroup>{children}</ShadcnSelectGroup>; }
export function SelectSeparator() { return <ShadcnSelectSeparator />; }

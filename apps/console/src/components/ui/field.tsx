import { Children, cloneElement, isValidElement, useId, type ReactElement, type ReactNode } from "react";
import { Label } from "@/components/ui/label";
interface FieldProps { label?: ReactNode; hint?: ReactNode; error?: ReactNode; className?: string; children: ReactNode; }
export function Field({ label, hint, error, className, children }: FieldProps) {
  const generatedId = useId();
  const child = Children.only(children) as ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean; }>;
  const inputId = (isValidElement(child) && child.props.id) || generatedId;
  const hintId = hint || error ? `${inputId}-hint` : undefined;
  const childWithProps = isValidElement(child) ? cloneElement(child, { id: inputId, "aria-describedby": hintId ?? child.props["aria-describedby"], "aria-invalid": error ? true : child.props["aria-invalid"] }) : child;
  if (!label && !hint && !error) return <>{childWithProps}</>;
  return (
    <div className={className}>
      {label && <Label htmlFor={inputId} className="block text-[13px] font-medium text-foreground mb-1.5">{label}</Label>}
      {childWithProps}
      {error ? <p id={hintId} className="mt-1 text-[12px] text-destructive">{error}</p> : hint ? <p id={hintId} className="mt-1 text-[12px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

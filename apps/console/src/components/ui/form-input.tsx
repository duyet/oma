import { useState, type InputHTMLAttributes, type ReactNode } from "react";
import { EyeIcon, EyeOffIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";

type CommonProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className"> & {
  className?: string;
  label?: ReactNode;
  hint?: ReactNode;
};

const TOUCH_TARGET = "min-h-11 sm:min-h-0";

export function TextInput({ className, label, hint, autoComplete, ...rest }: CommonProps) {
  const input = (
    <Input type="text" autoComplete={autoComplete ?? "off"} data-1p-ignore data-lpignore="true" className={[TOUCH_TARGET, className].filter(Boolean).join(" ")} {...rest} />
  );
  if (!label && !hint) return input;
  return <Field label={label} hint={hint}>{input}</Field>;
}

export function SecretInput({ className, label, hint, ...rest }: CommonProps) {
  const [revealed, setRevealed] = useState(false);
  const input = (
    <div className="relative">
      <Input type={revealed ? "text" : "password"} autoComplete="new-password" data-1p-ignore data-lpignore="true" className={[TOUCH_TARGET, "pr-10", className].filter(Boolean).join(" ")} {...rest} />
      <Button type="button" variant="ghost" size="icon-sm" onClick={() => setRevealed((r) => !r)} className="absolute inset-y-0 right-1 my-auto text-muted-foreground hover:text-foreground" title={revealed ? "Hide" : "Show"} aria-label={revealed ? "Hide secret" : "Show secret"}>
        {revealed ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
    </div>
  );
  if (!label && !hint) return input;
  return <Field label={label} hint={hint}>{input}</Field>;
}

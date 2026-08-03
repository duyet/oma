import { CheckIcon, ClipboardIcon } from "lucide-react";

interface CopyButtonProps {
  text: string;
  id: string;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
  className?: string;
  preClassName?: string;
}

export function CopyButton({
  text,
  id,
  copied,
  onCopy,
  className = "group w-full text-left rounded-md border border-border bg-bg p-3 flex items-start gap-3 hover:border-border-strong transition-colors",
  preClassName = "flex-1 min-w-0 overflow-x-auto font-mono text-xs leading-relaxed text-fg whitespace-pre",
}: CopyButtonProps) {
  const ok = copied === id;
  return (
    <button
      onClick={() => onCopy(text, id)}
      aria-label={`Copy: ${text.split("\n")[0]}`}
      type="button"
    >
      <pre className={preClassName}>{text}</pre>
      <span className="shrink-0 mt-0.5 text-fg-subtle group-hover:text-fg">
        {ok ? (
          <CheckIcon className="size-3.5" />
        ) : (
          <ClipboardIcon className="size-3.5" />
        )}
      </span>
    </button>
  );
}

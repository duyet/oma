// Console-styled syntax-highlighted code block (filename bar + copy).
// Uses the same lowlight/highlight.js path as Markdown.tsx so tokens pick
// up github.css + the dark-mode overrides in index.css. Avoids the ai-
// elements shiki CodeBlock, which relies on content-visibility and shadcn
// chrome that renders poorly inside dense dialogs.
import { useMemo, useState } from "react";
import { createLowlight } from "lowlight";
import { toJsxRuntime } from "hast-util-to-jsx-runtime";
import { Fragment, jsx, jsxs } from "react/jsx-runtime";
import { CheckIcon, ClipboardIcon } from "lucide-react";
import bash from "highlight.js/lib/languages/bash";
import yaml from "highlight.js/lib/languages/yaml";
import plaintext from "highlight.js/lib/languages/plaintext";

import { cn } from "@/lib/utils";

const lowlight = createLowlight({
  bash,
  sh: bash,
  shell: bash,
  zsh: bash,
  yaml,
  yml: yaml,
  plaintext,
  text: plaintext,
});

const jsxRuntime = { Fragment, jsx, jsxs } as Parameters<typeof toJsxRuntime>[1];

type Lang = "bash" | "yaml" | "text";

export function HighlightedCode({
  code,
  language,
  filename,
  className,
  maxHeightClass = "max-h-48",
}: {
  code: string;
  language: Lang | string;
  filename?: string;
  className?: string;
  maxHeightClass?: string;
}) {
  const [copied, setCopied] = useState(false);

  const lang = language === "shell" ? "bash" : language;
  const highlighted = useMemo(() => {
    const body = code.replace(/\n$/, "");
    if (lang && lowlight.registered(lang)) {
      try {
        const tree = lowlight.highlight(lang, body);
        return toJsxRuntime(tree, jsxRuntime);
      } catch {
        return body;
      }
    }
    return body;
  }, [code, lang]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      // Clipboard can fail outside secure contexts — leave UI unchanged.
    }
  }

  return (
    <div
      className={cn(
        "w-full overflow-hidden rounded-md border border-border bg-bg-surface text-fg",
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 border-b border-border bg-bg px-2.5 py-1.5">
        <span className="min-w-0 truncate font-mono text-[11px] text-fg-muted">
          {filename ?? lang}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle hover:bg-bg-surface hover:text-fg transition-colors"
          aria-label={copied ? "Copied" : "Copy code"}
        >
          {copied ? (
            <CheckIcon className="size-3.5 text-success" />
          ) : (
            <ClipboardIcon className="size-3.5" />
          )}
        </button>
      </div>
      <pre
        className={cn(
          "m-0 overflow-auto p-3 text-[12px] leading-relaxed",
          maxHeightClass,
        )}
      >
        <code
          className={cn(
            "font-mono hljs block bg-transparent! p-0! text-[12px] text-fg",
            `language-${lang}`,
          )}
        >
          {highlighted}
        </code>
      </pre>
    </div>
  );
}

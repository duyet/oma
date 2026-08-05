// Compact syntax-highlighted code block with a one-click copy button.
// Built on the shared shiki CodeBlock used in the session tool timeline so
// install snippets (bash / yaml) match the rest of the console.
import type { BundledLanguage } from "shiki";

import {
  CodeBlock,
  CodeBlockActions,
  CodeBlockCopyButton,
  CodeBlockFilename,
  CodeBlockHeader,
  CodeBlockTitle,
} from "@/components/ai-elements/code-block";
import { cn } from "@/lib/utils";

export function HighlightedCode({
  code,
  language,
  filename,
  className,
  /** Tailwind max-height for the scrollable body (shiki content wrapper). */
  maxHeightClass = "max-h-48",
}: {
  code: string;
  language: BundledLanguage;
  filename?: string;
  className?: string;
  maxHeightClass?: string;
}) {
  return (
    <CodeBlock
      code={code}
      language={language}
      className={cn(
        // Tighten padding + pin body height so install dialogs stay compact.
        "text-[12px] [&>div.relative]:overflow-auto [&_pre]:p-3 [&_pre]:text-[12px] [&_pre]:leading-relaxed",
        maxHeightClass === "max-h-40" && "[&>div.relative]:max-h-40",
        maxHeightClass === "max-h-48" && "[&>div.relative]:max-h-48",
        maxHeightClass === "max-h-56" && "[&>div.relative]:max-h-56",
        maxHeightClass === "max-h-64" && "[&>div.relative]:max-h-64",
        maxHeightClass === "max-h-72" && "[&>div.relative]:max-h-72",
        // Fallback if caller passes something else.
        ![
          "max-h-40",
          "max-h-48",
          "max-h-56",
          "max-h-64",
          "max-h-72",
        ].includes(maxHeightClass) && "[&>div.relative]:max-h-48",
        className,
      )}
    >
      <CodeBlockHeader className="py-1.5 px-2.5">
        <CodeBlockTitle>
          {filename ? (
            <CodeBlockFilename className="text-[11px]">{filename}</CodeBlockFilename>
          ) : (
            <span className="font-mono text-[11px] uppercase tracking-wide opacity-70">
              {language}
            </span>
          )}
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton className="size-7" />
        </CodeBlockActions>
      </CodeBlockHeader>
    </CodeBlock>
  );
}

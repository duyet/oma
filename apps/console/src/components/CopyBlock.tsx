import { CopyButton } from "./CopyButton";

// Copy-block variant of the shared CopyButton used by multi-line command
// walkthroughs (K8s/Helm install steps, pairing-token displays). Renders as
// a full-width block with a `<pre>` for multi-line commands; the icon-swap
// logic lives in the shared component. Extracted from RuntimesList so the
// register-k8s dialog and the runtimes page share one definition.
export function CopyBlock({
  id,
  text,
  copied,
  onCopy,
}: {
  id: string;
  text: string;
  copied: string | null;
  onCopy: (text: string, key: string) => void;
}) {
  return (
    <CopyButton
      id={id}
      text={text}
      copied={copied}
      onCopy={onCopy}
      preClassName="flex-1 min-w-0 overflow-x-auto font-mono text-xs leading-relaxed text-fg whitespace-pre"
    />
  );
}

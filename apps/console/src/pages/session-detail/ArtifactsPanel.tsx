import { useEffect, useMemo, useState } from "react";
import type { BundledLanguage } from "shiki";
import {
  ArrowLeftIcon,
  DownloadIcon,
  EyeIcon,
  FileCodeIcon,
  FileIcon,
  FileJsonIcon,
  FileTextIcon,
  ImageIcon,
  LayoutGridIcon,
  ListIcon,
} from "lucide-react";

import { useApi } from "../../lib/api";
import type { Event } from "../../lib/events";
import { useIsMobile } from "../../hooks/use-mobile";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { CodeBlock } from "../../components/ai-elements/code-block";
import { cn } from "@/lib/utils";
import {
  filterArtifacts,
  formatBytes,
  outputDownloadHref,
  sortArtifacts,
  useSessionArtifacts,
  type ArtifactKind,
  type ArtifactSortKey,
  type ArtifactSource,
  type SandboxOutputFile,
  type SessionArtifact,
} from "./artifacts";

const SOURCE_CHIPS: Array<{ id: ArtifactSource; label: string }> = [
  { id: "tool_output", label: "Tool output" },
  { id: "sandbox", label: "Sandbox" },
  { id: "user_upload", label: "User upload" },
];

function KindIcon({ kind }: { kind: ArtifactKind }) {
  const cls = "size-4 text-fg-subtle shrink-0";
  switch (kind) {
    case "image":
      return <ImageIcon className={cls} aria-hidden />;
    case "pdf":
      return <FileTextIcon className={cls} aria-hidden />;
    case "code":
      return <FileCodeIcon className={cls} aria-hidden />;
    case "data":
      return <FileJsonIcon className={cls} aria-hidden />;
    case "text":
      return <FileTextIcon className={cls} aria-hidden />;
    case "other":
      return <FileIcon className={cls} aria-hidden />;
    default: {
      const _never: never = kind;
      void _never;
      return <FileIcon className={cls} aria-hidden />;
    }
  }
}

function downloadInline(name: string, text: string) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadHrefOf(a: SessionArtifact, sessionId: string): string | undefined {
  if (a.downloadHref) return a.downloadHref;
  if (a.path?.startsWith("/mnt/session/outputs/")) {
    return outputDownloadHref(sessionId, a.name);
  }
  if (a.preview.kind === "image" || a.preview.kind === "pdf" || a.preview.kind === "href") {
    return a.preview.kind === "href" ? a.preview.href : a.preview.src;
  }
  return undefined;
}

function triggerDownload(artifact: SessionArtifact, sessionId: string) {
  if (artifact.text && !artifact.downloadHref) {
    downloadInline(artifact.name, artifact.text);
    return;
  }
  const href = downloadHrefOf(artifact, sessionId);
  if (!href) return;
  const a = document.createElement("a");
  a.href = href;
  a.download = artifact.name;
  a.click();
}

export function ArtifactsPanel({
  sessionId,
  events,
}: {
  sessionId: string;
  events: Event[];
}) {
  const { api } = useApi();
  const isMobile = useIsMobile();
  const [files, setFiles] = useState<SandboxOutputFile[] | undefined>(undefined);
  const [view, setView] = useState<"grid" | "list">("grid");
  const [sources, setSources] = useState<ArtifactSource[]>([]);
  const [extensions, setExtensions] = useState<string[]>([]);
  const [sortKey, setSortKey] = useState<ArtifactSortKey>("ts");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [selected, setSelected] = useState<SessionArtifact | null>(null);

  useEffect(() => {
    let cancelled = false;
    api<{ data: SandboxOutputFile[] }>(`/v1/sessions/${sessionId}/outputs`)
      .then((d) => {
        if (!cancelled) setFiles(d.data ?? []);
      })
      .catch(() => {
        if (!cancelled) setFiles([]);
      });
    return () => {
      cancelled = true;
    };
  }, [api, sessionId]);

  const all = useSessionArtifacts(events, files, sessionId);
  const filtered = useMemo(() => {
    return sortArtifacts(filterArtifacts(all, { sources, extensions }), sortKey, sortDir);
  }, [all, sources, extensions, sortKey, sortDir]);

  const extChips = useMemo(() => {
    const set = new Set<string>();
    for (const a of all) set.add(a.extension || "(none)");
    return [...set].sort();
  }, [all]);

  const sandboxRows = filtered.filter((a) => a.source === "sandbox");

  const toggleSource = (id: ArtifactSource) => {
    setSources((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));
  };
  const toggleExt = (ext: string) => {
    setExtensions((prev) => (prev.includes(ext) ? prev.filter((e) => e !== ext) : [...prev, ext]));
  };
  const cycleSort = (key: ArtifactSortKey) => {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h3 className="text-xs font-medium text-fg">
          Artifacts{all.length > 0 ? ` (${all.length})` : ""}
        </h3>
        <div className="ml-auto flex items-center gap-0.5">
          <button
            type="button"
            aria-pressed={view === "grid"}
            aria-label="Grid view"
            onClick={() => setView("grid")}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md text-fg-subtle hover:text-fg hover:bg-bg-surface",
              view === "grid" && "bg-bg-surface text-fg",
            )}
          >
            <LayoutGridIcon className="size-3.5" />
          </button>
          <button
            type="button"
            aria-pressed={view === "list"}
            aria-label="List view"
            onClick={() => setView("list")}
            className={cn(
              "inline-flex size-7 items-center justify-center rounded-md text-fg-subtle hover:text-fg hover:bg-bg-surface",
              view === "list" && "bg-bg-surface text-fg",
            )}
          >
            <ListIcon className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {SOURCE_CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            aria-pressed={sources.includes(c.id)}
            onClick={() => toggleSource(c.id)}
            className={cn(
              "px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wide",
              sources.includes(c.id)
                ? "bg-bg-surface text-fg font-medium"
                : "text-fg-subtle hover:text-fg-muted hover:bg-bg-surface/60",
            )}
          >
            {c.label}
          </button>
        ))}
        {extChips.map((ext) => (
          <button
            key={ext}
            type="button"
            aria-pressed={extensions.includes(ext)}
            onClick={() => toggleExt(ext)}
            className={cn(
              "px-1.5 py-0.5 rounded font-mono text-[10px]",
              extensions.includes(ext)
                ? "bg-bg-surface text-fg font-medium"
                : "text-fg-subtle hover:text-fg-muted hover:bg-bg-surface/60",
            )}
          >
            {ext === "(none)" ? "no ext" : `.${ext}`}
          </button>
        ))}
      </div>

      {all.length === 0 && (
        <p className="text-xs text-fg-subtle">
          No artifacts yet. Writes, tool-result images, user uploads, and session
          outputs show up here as the event log grows.
        </p>
      )}

      {all.length > 0 && filtered.length === 0 && (
        <p className="text-xs text-fg-subtle">No artifacts match the current filters.</p>
      )}

      {view === "grid" ? (
        <ul className="grid grid-cols-2 gap-2">
          {filtered.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => setSelected(a)}
                className="w-full rounded-md border border-border/60 bg-bg-surface/40 p-2 text-left hover:border-border hover:bg-bg-surface/80"
              >
                <div className="flex items-start gap-1.5">
                  {a.preview.kind === "image" ? (
                    <img
                      src={a.preview.src}
                      alt=""
                      className="size-10 rounded object-cover shrink-0 bg-bg-surface"
                    />
                  ) : (
                    <div className="size-10 rounded bg-bg-surface flex items-center justify-center shrink-0">
                      <KindIcon kind={a.kind} />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="font-mono text-[11px] text-fg truncate" title={a.path ?? a.name}>
                      {a.name}
                    </div>
                    <div className="text-[10px] text-fg-subtle mt-0.5">
                      {a.extension ? `.${a.extension}` : a.kind} · {formatBytes(a.sizeBytes)}
                    </div>
                  </div>
                </div>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div>
          <div className="flex gap-2 px-0.5 pb-1 text-[10px] uppercase tracking-wide text-fg-subtle">
            {(["name", "size", "source", "ts"] as ArtifactSortKey[]).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => cycleSort(key)}
                className={cn("hover:text-fg", sortKey === key && "text-fg")}
              >
                {key === "ts" ? "time" : key}
                {sortKey === key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
              </button>
            ))}
          </div>
          <ul className="space-y-1">
            {filtered.map((a) => (
              <li key={a.id} className="flex items-center gap-2 py-1">
                <KindIcon kind={a.kind} />
                <button
                  type="button"
                  onClick={() => setSelected(a)}
                  className="min-w-0 flex-1 text-left"
                >
                  <div className="font-mono text-[11px] text-fg truncate" title={a.path ?? a.name}>
                    {a.name}
                  </div>
                  <div className="text-[10px] text-fg-subtle">
                    {formatBytes(a.sizeBytes)} · {a.source.replace("_", " ")}
                    {a.isError ? " · error" : ""}
                  </div>
                </button>
                <button
                  type="button"
                  aria-label={`Preview ${a.name}`}
                  onClick={() => setSelected(a)}
                  className="text-fg-subtle hover:text-fg p-1"
                >
                  <EyeIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Download ${a.name}`}
                  onClick={() => triggerDownload(a, sessionId)}
                  className="text-fg-subtle hover:text-fg p-1"
                >
                  <DownloadIcon className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sandboxRows.length > 0 && view === "grid" && (
        <section className="space-y-1.5 pt-2">
          <h4 className="text-[10px] uppercase tracking-wide text-fg-subtle font-mono">
            From sandbox ({sandboxRows.length})
          </h4>
          <ul className="space-y-1">
            {sandboxRows.map((a) => (
              <li key={`sb-${a.id}`} className="flex items-center gap-2">
                <span className="font-mono text-[11px] text-fg truncate flex-1" title={a.path}>
                  {a.path ?? a.name}
                </span>
                <span className="text-[10px] text-fg-subtle shrink-0">{formatBytes(a.sizeBytes)}</span>
                <button
                  type="button"
                  aria-label={`Preview ${a.name}`}
                  onClick={() => setSelected(a)}
                  className="text-fg-subtle hover:text-fg p-1"
                >
                  <EyeIcon className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`Download ${a.name}`}
                  onClick={() => triggerDownload(a, sessionId)}
                  className="text-fg-subtle hover:text-fg p-1"
                >
                  <DownloadIcon className="size-3.5" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <PreviewDialog
        artifact={selected}
        sessionId={sessionId}
        fullScreen={isMobile}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

function PreviewDialog({
  artifact,
  sessionId,
  fullScreen,
  onClose,
}: {
  artifact: SessionArtifact | null;
  sessionId: string;
  fullScreen: boolean;
  onClose: () => void;
}) {
  return (
    <Dialog open={artifact !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        showCloseButton={!fullScreen}
        className={cn(
          "max-h-[90vh] overflow-hidden flex flex-col",
          fullScreen
            ? "top-0 left-0 h-[100dvh] w-full max-w-none translate-x-0 translate-y-0 rounded-none sm:max-w-none"
            : "sm:max-w-lg",
        )}
        aria-describedby={undefined}
      >
        {artifact && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 min-w-0">
                {fullScreen && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="Back"
                    onClick={onClose}
                  >
                    <ArrowLeftIcon />
                  </Button>
                )}
                <span className="font-mono text-sm truncate">{artifact.name}</span>
              </DialogTitle>
              <p className="text-[11px] text-fg-subtle">
                {formatBytes(artifact.sizeBytes)}
                {artifact.path ? ` · ${artifact.path}` : ""}
                {artifact.isError ? " · tool error" : ""}
              </p>
            </DialogHeader>
            <div className="min-h-0 flex-1 overflow-auto">
              <PreviewBody artifact={artifact} />
            </div>
            <div className="flex justify-end pt-2">
              <Button
                type="button"
                size="sm"
                variant="secondary"
                onClick={() => triggerDownload(artifact, sessionId)}
              >
                <DownloadIcon />
                Download
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function PreviewBody({ artifact }: { artifact: SessionArtifact }) {
  const preview = artifact.preview;
  switch (preview.kind) {
    case "image":
      return (
        <a href={preview.src} target="_blank" rel="noreferrer" className="block">
          <img src={preview.src} alt={artifact.name} className="max-h-[60vh] w-auto mx-auto object-contain" />
        </a>
      );
    case "pdf":
      return (
        <iframe
          title={artifact.name}
          src={preview.src}
          className="w-full h-[60vh] rounded border border-border/50 bg-bg"
        />
      );
    case "text":
      return (
        <CodeBlock
          code={preview.text}
          language={preview.language as BundledLanguage}
          className="text-xs max-h-[60vh]"
        />
      );
    case "href":
      return (
        <p className="text-xs text-fg-muted">
          Preview is not available inline.{" "}
          <a href={preview.href} download={artifact.name} className="text-info hover:underline">
            Download {artifact.name}
          </a>
        </p>
      );
    case "none":
      return (
        <p className="text-xs text-fg-muted">
          {artifact.path
            ? `Path ${artifact.path} was written in the sandbox. Open it from the Files tab if it was promoted to session outputs, or inspect the matching write/edit in the transcript.`
            : "No inline preview for this artifact."}
        </p>
      );
    default: {
      const _never: never = preview;
      void _never;
      return null;
    }
  }
}

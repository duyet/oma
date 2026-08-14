/**
 * Upstream provider behind a model handle, plus a monochrome mark for it.
 *
 * Every surface that prints a model id renders it through `<ModelName />` so
 * the same handle always carries the same glyph. Marks are inline
 * `currentColor` SVG — no external URLs (the console ships no remote assets),
 * simplified to read at 14px next to text.
 */
import { Sparkles } from "lucide-react";
import type { ReactNode } from "react";

export type ModelProviderId = "anthropic" | "openai" | "xai" | "poolside" | "anyrouter" | "unknown";

export interface ModelProviderInfo {
  id: ModelProviderId;
  name: string;
}

function Mark({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <svg
      className={className ?? "size-3.5"}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Anthropic's wordmark reduces to its splayed "A" — two strokes meeting at
 *  the apex with the crossbar gap. */
function AnthropicMark({ className }: { className?: string }) {
  return (
    <Mark className={className}>
      <path d="M7.4 4h3.1l5.6 16h-3.2l-1.1-3.4H6.9L5.8 20H2.6L7.4 4Zm.4 9.9h3.2L9.4 8.6l-1.6 5.3Z" />
      <path d="M16.2 4h3.2L24 20h-3.2L16.2 4Z" />
    </Mark>
  );
}

/** OpenAI's mark is an interlocking knot; at badge size a six-lobed rosette
 *  is the honest simplification. */
function OpenAiMark({ className }: { className?: string }) {
  return (
    <Mark className={className}>
      <path d="M12 2.2 18.5 6v7.6L12 17.4 5.5 13.6V6L12 2.2Zm0 2.3L7.5 7.1v5.3L12 15.1l4.5-2.7V7.1L12 4.5Z" />
      <path d="M12 8.1a3.4 3.4 0 1 1 0 6.8 3.4 3.4 0 0 1 0-6.8Zm0 1.9a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" />
      <path d="M11 18.4h2V22h-2z" />
    </Mark>
  );
}

/** poolside — a pool: waterline over a basin. */
function PoolsideMark({ className }: { className?: string }) {
  return (
    <Mark className={className}>
      <path d="M3 15.1c1.6 0 1.6 1.4 3.2 1.4s1.6-1.4 3.2-1.4 1.6 1.4 3.2 1.4 1.6-1.4 3.2-1.4 1.6 1.4 3.2 1.4V19c-1.6 0-1.6-1.4-3.2-1.4s-1.6 1.4-3.2 1.4-1.6-1.4-3.2-1.4-1.6 1.4-3.2 1.4S4.6 19 3 19v-3.9Z" />
      <path d="M7 3h2v9.4H7zM15 3h2v9.4h-2z" />
      <path d="M7 6.6h10v1.9H7z" />
    </Mark>
  );
}

/** xAI — a crossed X that reads at badge size next to grok-* handles. */
function XaiMark({ className }: { className?: string }) {
  return (
    <Mark className={className}>
      <path d="M4.2 4h4.1L12 10.1 15.7 4h4.1l-6.1 9.2L20.5 20h-4.2L12 13.8 7.7 20H3.5l6.8-6.8L4.2 4Z" />
    </Mark>
  );
}

/** AnyRouter — a router: one input fanning out to several upstreams. */
function AnyRouterMark({ className }: { className?: string }) {
  return (
    <Mark className={className}>
      <path d="M2 11h6.2v2H2zM15.8 5.5H22v2h-6.2zM15.8 11H22v2h-6.2zM15.8 16.5H22v2h-6.2z" />
      <path d="M8.2 11.5h2V6.5h6.6v-2H8.2v7ZM8.2 12.5h2v5h6.6v2H8.2v-7Z" />
      <path d="M10.6 9.6a2.4 2.4 0 1 1 0 4.8 2.4 2.4 0 0 1 0-4.8Z" />
    </Mark>
  );
}

const MARKS: Record<ModelProviderId, (p: { className?: string }) => ReactNode> = {
  anthropic: AnthropicMark,
  openai: OpenAiMark,
  xai: XaiMark,
  poolside: PoolsideMark,
  anyrouter: AnyRouterMark,
  unknown: ({ className }) => (
    <Sparkles className={className ?? "size-3.5"} aria-hidden="true" />
  ),
};

/**
 * Provider behind a model handle. Handles both the `provider/model` gateway
 * form and the bare vendor ids (`claude-sonnet-4-6`, `gpt-5`) that the
 * direct-API paths use.
 */
export function modelProvider(modelId: string | undefined | null): ModelProviderInfo {
  const id = (modelId ?? "").trim().toLowerCase();
  if (!id) return { id: "unknown", name: "Unknown provider" };

  const prefix = id.includes("/") ? id.slice(0, id.indexOf("/")) : "";
  if (prefix === "anthropic") return { id: "anthropic", name: "Anthropic" };
  if (prefix === "openai") return { id: "openai", name: "OpenAI" };
  if (prefix === "xai") return { id: "xai", name: "xAI" };
  if (prefix === "poolside") return { id: "poolside", name: "poolside" };
  if (prefix === "anyrouter") return { id: "anyrouter", name: "AnyRouter" };

  // Bare handles, and the alias `anyrouter` with no slash.
  if (id.startsWith("claude")) return { id: "anthropic", name: "Anthropic" };
  if (id.startsWith("grok")) return { id: "xai", name: "xAI" };
  if (id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3")) {
    return { id: "openai", name: "OpenAI" };
  }
  if (id.startsWith("anyrouter")) return { id: "anyrouter", name: "AnyRouter" };
  if (id.startsWith("laguna") || id.startsWith("malibu")) {
    return { id: "poolside", name: "poolside" };
  }
  return { id: "unknown", name: "Unknown provider" };
}

export function ModelProviderMark({
  modelId,
  className,
}: {
  modelId: string | undefined | null;
  className?: string;
}) {
  const provider = modelProvider(modelId);
  const Glyph = MARKS[provider.id];
  return (
    <span className="inline-flex shrink-0 text-fg-subtle" title={provider.name}>
      <Glyph className={className ?? "size-3.5"} />
    </span>
  );
}

/**
 * A model handle with its provider mark. When the provider resolved a
 * gateway alias to a concrete model, both are shown — `alias → resolved` —
 * each with its own mark, since the two can be different vendors.
 */
export function ModelName({
  model,
  resolved,
  className = "",
}: {
  model: string | undefined | null;
  /** Concrete model the provider reported, when it differs from `model`. */
  resolved?: string | null;
  className?: string;
}) {
  if (!model) return null;
  return (
    <span className={`inline-flex items-center gap-1.5 min-w-0 ${className}`}>
      <ModelProviderMark modelId={model} />
      <span className="truncate">{model}</span>
      {resolved && (
        <>
          <span className="text-fg-subtle" aria-hidden="true">
            →
          </span>
          <ModelProviderMark modelId={resolved} />
          <span className="truncate" title={`Resolved by the provider to ${resolved}`}>
            {resolved}
          </span>
        </>
      )}
    </span>
  );
}

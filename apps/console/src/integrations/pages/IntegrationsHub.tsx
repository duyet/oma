// Unified integrations gallery (issue #92).
//
// One landing page listing every available integration, grouped
// Connected-first then by category, with a search filter and a consistent
// route into each provider's own manage/setup page. Providers that support
// an OAuth-app handshake surface a direct Connect action; token-only
// providers (Telegram, Matrix) point at their setup instead — same row,
// same UX.
//
// Connection status is read from each provider's existing `list*` endpoints
// via IntegrationsApi so the gallery reflects live installs without a new
// backend endpoint. Providers with no status API always render "Not
// connected" and link to their setup page.

import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Link, useSearchParams } from "react-router";
import { SearchIcon, PlusIcon, MoreHorizontalIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  GitHubIcon,
  LinearIcon,
  SlackIcon,
  TelegramIcon,
  MatrixIcon,
} from "../../components/icons";
import { IntegrationsApi } from "../api/client";

const api = new IntegrationsApi();

type Category = "Development" | "Productivity" | "Communication";

const CATEGORY_ORDER: Category[] = ["Development", "Productivity", "Communication"];

interface ProviderCard {
  id: string;
  name: string;
  blurb: string;
  category: Category;
  /** Route to the provider's list/manage page. */
  href: string;
  /** How the user connects: OAuth-app one-click, or a token/manifest setup. */
  connectKind: "oauth" | "token";
  icon: ComponentType<{ className?: string }>;
  /** Resolve current connection count. null when the provider has no list API
   *  wired yet (Telegram/Matrix) — the row still renders, just always as
   *  "Not connected". */
  countConnections: (() => Promise<number>) | null;
}

const PROVIDERS: ProviderCard[] = [
  {
    id: "github",
    name: "GitHub",
    blurb: "Let agents open PRs, review code, and respond to issues on your repos.",
    category: "Development",
    href: "/integrations/github",
    connectKind: "oauth",
    icon: GitHubIcon,
    countConnections: async () => (await api.github.listInstallations()).length,
  },
  {
    id: "linear",
    name: "Linear",
    blurb: "Make agents teammates in Linear — assign issues, @mention, push status.",
    category: "Productivity",
    href: "/integrations/linear",
    connectKind: "oauth",
    icon: LinearIcon,
    countConnections: async () => (await api.linear.listInstallations()).length,
  },
  {
    id: "slack",
    name: "Slack",
    blurb: "Bring agents into channels, mention them, and get status back in-thread.",
    category: "Communication",
    href: "/integrations/slack",
    connectKind: "oauth",
    icon: SlackIcon,
    countConnections: async () => (await api.slack.listInstallations()).length,
  },
  {
    id: "telegram",
    name: "Telegram",
    blurb: "Talk to agents from a Telegram chat via a bot token.",
    category: "Communication",
    href: "/integrations/telegram",
    connectKind: "token",
    icon: TelegramIcon,
    countConnections: null,
  },
  {
    id: "matrix",
    name: "Matrix",
    blurb: "Connect agents to a Matrix room on your own homeserver.",
    category: "Communication",
    href: "/integrations/matrix",
    connectKind: "token",
    icon: MatrixIcon,
    countConnections: null,
  },
];

function ProviderRow({
  provider,
  count,
  loading,
}: {
  provider: ProviderCard;
  count: number | null | undefined;
  loading: boolean;
}) {
  const Icon = provider.icon;
  const isConnected = typeof count === "number" && count > 0;
  return (
    <div
      data-testid={`integration-${provider.id}`}
      className="group flex items-center gap-4 rounded-xl border border-border bg-bg-surface p-4 transition-colors hover:border-fg-subtle/40"
    >
      <Link
        to={provider.href}
        className="flex min-w-0 flex-1 items-center gap-4 rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-border bg-bg text-fg">
          <Icon className="h-5 w-5" />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[14px] font-semibold text-fg">
            {provider.name}
          </span>
          <span className="mt-0.5 block text-[13px] text-fg-muted line-clamp-2 sm:truncate">
            {provider.blurb}
          </span>
        </span>
      </Link>

      <div className="flex shrink-0 items-center gap-2">
        {isConnected ? (
          <Badge className="border-success/30 bg-success-subtle text-success">
            <span className="h-1.5 w-1.5 rounded-full bg-success" aria-hidden />
            Connected{count > 1 ? ` · ${count}` : ""}
          </Badge>
        ) : (
          <Badge variant="outline" className="text-fg-subtle">
            {loading ? "Checking…" : "Not connected"}
          </Badge>
        )}

        {isConnected ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" aria-label={`${provider.name} options`}>
                <MoreHorizontalIcon />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem asChild>
                <Link to={provider.href}>Manage</Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                <Link to={provider.href}>Disconnect…</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <Button asChild variant="outline" size="sm">
            <Link to={provider.href}>
              {provider.connectKind === "oauth" ? "Connect" : "Set up"}
            </Link>
          </Button>
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  providers,
  counts,
  loading,
}: {
  title: string;
  providers: ProviderCard[];
  counts: Record<string, number | null>;
  loading: boolean;
}) {
  if (providers.length === 0) return null;
  return (
    <section className="mb-8">
      <h2 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-fg-subtle">
        {title}
      </h2>
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {providers.map((p) => (
          <ProviderRow key={p.id} provider={p} count={counts[p.id]} loading={loading} />
        ))}
      </div>
    </section>
  );
}

export function IntegrationsHub() {
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [mcpOpen, setMcpOpen] = useState(false);
  const [params] = useSearchParams();

  // Banner state driven by the unified OAuth callback redirect
  // (?connected=<provider> on success, ?connect_error=<code>&provider=<id>).
  const connected = params.get("connected");
  const connectError = params.get("connect_error");
  const errorProvider = params.get("provider");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const entries = await Promise.all(
          PROVIDERS.map(async (p) => {
            if (!p.countConnections) return [p.id, null] as const;
            try {
              return [p.id, await p.countConnections()] as const;
            } catch {
              // A provider's list endpoint failing shouldn't blank the gallery.
              return [p.id, null] as const;
            }
          }),
        );
        if (!cancelled) setCounts(Object.fromEntries(entries));
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const matches = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return PROVIDERS;
    return PROVIDERS.filter(
      (p) => p.name.toLowerCase().includes(q) || p.blurb.toLowerCase().includes(q),
    );
  }, [search]);

  const isConnected = (p: ProviderCard) => {
    const c = counts[p.id];
    return typeof c === "number" && c > 0;
  };
  const connectedProviders = matches.filter(isConnected);
  const rest = matches.filter((p) => !isConnected(p));

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto max-w-[1100px] px-4 py-10 sm:px-8 lg:px-10 lg:py-12">
        <header className="mb-6">
          <h1 className="font-display text-[28px] font-semibold leading-tight tracking-tight text-fg">
            Integrations
          </h1>
          <p className="mt-1.5 max-w-xl text-[14px] text-fg-muted">
            Connect your agents to the tools your team already uses — credentials are
            stored encrypted in your vault, never in the sandbox.
          </p>
        </header>

        <div className="mb-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="relative flex-1">
            <SearchIcon
              className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle"
              aria-hidden
            />
            <Input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search integrations"
              aria-label="Search integrations"
              className="h-9 pl-8"
            />
          </div>
          <Button variant="outline" size="sm" onClick={() => setMcpOpen(true)}>
            <PlusIcon />
            Add Custom MCP
          </Button>
        </div>

        {connected && (
          <div className="mb-6 rounded-lg border border-success/30 bg-success-subtle px-4 py-3 text-[13px] text-success">
            Connected <strong className="capitalize">{connected}</strong> successfully.
          </div>
        )}
        {connectError && (
          <div className="mb-6 rounded-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-[13px] text-danger">
            Couldn't connect{errorProvider ? ` ${errorProvider}` : ""}: {connectError}. Please try again.
          </div>
        )}
        {error && (
          <div className="mb-6 rounded-lg border border-danger/30 bg-danger-subtle px-4 py-3 text-[13px] text-danger">
            {error}
          </div>
        )}

        <Section
          title="Connected"
          providers={connectedProviders}
          counts={counts}
          loading={loading}
        />
        {CATEGORY_ORDER.map((cat) => (
          <Section
            key={cat}
            title={cat}
            providers={rest.filter((p) => p.category === cat)}
            counts={counts}
            loading={loading}
          />
        ))}

        {matches.length === 0 && (
          <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-[13px] text-fg-muted">
            No integrations match “{search}”.
          </p>
        )}
      </div>

      <Dialog open={mcpOpen} onOpenChange={setMcpOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a custom MCP server</DialogTitle>
            <DialogDescription>
              MCP servers are attached per agent. Open an agent, edit its configuration,
              and add the server under “MCP servers” — the platform proxies every call so
              the credential never reaches the sandbox.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setMcpOpen(false)}>
              Cancel
            </Button>
            <Button asChild size="sm">
              <Link to="/agents" onClick={() => setMcpOpen(false)}>
                Go to Agents
              </Link>
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

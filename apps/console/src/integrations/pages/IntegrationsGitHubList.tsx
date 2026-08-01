import { useEffect, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { IntegrationsApi } from "../api/client";
import type { GitHubInstallation, GitHubPublication } from "../api/types";
import { StatusPill } from "../components/StatusPill";
import { ConnectModeChooser } from "../components/ConnectModeChooser";
import { Avatar } from "../../components/Avatar";
import { EmptyState } from "../../components/EmptyState";
import { formatRelative } from "../../lib/format";

const api = new IntegrationsApi();

/** GitHub serves a public avatar for any org/user login at this URL — lets us
 *  show the installed account's avatar without persisting it on the row. */
function githubAvatarUrl(login: string): string {
  return `https://github.com/${encodeURIComponent(login)}.png?size=80`;
}

/** Kick off OMA's managed-app install as a top-level navigation so the session
 *  cookie rides along to the backend connect route, which 302s to GitHub's
 *  app-install screen and (post-install) back here with ?managed_install=ok. */
function startManagedConnect() {
  const returnUrl = `${window.location.origin}/integrations/github`;
  window.location.assign(
    `/v1/integrations/github/managed/connect?returnUrl=${encodeURIComponent(returnUrl)}`,
  );
}

interface InstallationWithPublications {
  installation: GitHubInstallation;
  publications: GitHubPublication[];
}

export function IntegrationsGitHubList() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [items, setItems] = useState<InstallationWithPublications[]>([]);
  const [pending, setPending] = useState<GitHubPublication[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [managedAvailable, setManagedAvailable] = useState<boolean | null>(null);

  // Result of a managed-app install round-trip (set on the ?managed_install=
  // redirect the backend callback bounces us back with). `?connected=1` is
  // the same success signal under its public name.
  const managedResult =
    searchParams.get("managed_install") ??
    (searchParams.get("connected") === "1" ? "ok" : null);
  const managedResultLogin = searchParams.get("login");

  useEffect(() => {
    void api.github.managedAvailability().then((r) => setManagedAvailable(r.available));
  }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [installs, pendingPubs] = await Promise.all([
        api.github.listInstallations(),
        api.github.listPendingPublications(),
      ]);
      const withPubs = await Promise.all(
        installs.map(async (installation) => ({
          installation,
          publications: await api.github.listPublications(installation.id),
        })),
      );
      setItems(withPubs);
      setPending(pendingPubs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function disconnect(installationId: string) {
    try {
      await api.github.disconnectInstallation(installationId);
      setItems((list) => list.filter((x) => x.installation.id !== installationId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function discardPending(pubId: string) {
    try {
      await api.github.unpublish(pubId);
      setPending((p) => p.filter((x) => x.id !== pubId));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="max-w-[1100px] mx-auto px-4 sm:px-8 lg:px-10 py-10 lg:py-12">
        <header className="flex items-start justify-between gap-6 mb-8">
          <div className="min-w-0">
            <h1 className="font-display text-[28px] leading-tight font-semibold tracking-tight text-fg">
              GitHub integrations
            </h1>
            <p className="mt-1.5 text-[14px] text-fg-muted max-w-xl">
              Make your agents teammates in GitHub — assign them issues, request reviews,
              mention them in comments. Each agent gets its own bot identity.
            </p>
          </div>
        </header>

        {loading && <p className="text-sm text-fg-muted">Loading…</p>}
        {error && (
          <div className="rounded-md border border-danger/30 bg-danger-subtle px-3 py-2 text-sm text-danger">
            {error}
          </div>
        )}

        {managedResult && (
          <ManagedInstallBanner result={managedResult} login={managedResultLogin} />
        )}

        <ConnectModeChooser
          provider="GitHub"
          availability={managedAvailable}
          onSelectManaged={startManagedConnect}
          onSelectOwn={() => navigate("/integrations/github/bind")}
        />

        {pending.length > 0 && (
          <section className="mb-6">
            <h2 className="text-[12px] font-medium text-fg-muted uppercase tracking-wider mb-2">
              In-progress installs
            </h2>
            <ul className="space-y-2">
              {pending.map((p) => (
                <PendingRow key={p.id} pub={p} onDiscard={() => discardPending(p.id)} />
              ))}
            </ul>
          </section>
        )}

        {!loading && items.length === 0 && pending.length === 0 && (
          <EmptyState
            title="No GitHub orgs connected yet."
            action={
              <Link
                to="/integrations/github/bind"
                className="text-brand hover:underline text-[13px]"
              >
                Bind your first agent →
              </Link>
            }
          />
        )}

        {items.length > 0 && (
          <section>
            <div className="flex items-center justify-between gap-4 mb-2">
              <h2 className="text-[12px] font-medium text-fg-muted uppercase tracking-wider">
                Connected accounts
              </h2>
              <button
                type="button"
                onClick={startManagedConnect}
                className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 text-[12px] font-medium rounded-md border border-border text-fg hover:border-border-strong transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
              >
                Add another account →
              </button>
            </div>
            <div className="space-y-3">
              {items.map(({ installation, publications }) => (
                <WorkspaceCard
                  key={installation.id}
                  installation={installation}
                  publications={publications}
                  onDisconnect={() => disconnect(installation.id)}
                />
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

/** Banner shown after a managed-app install round-trips back here via the
 *  ?managed_install= redirect. "ok" confirms the org is connected; the other
 *  states surface a reason without derailing the page. */
function ManagedInstallBanner({
  result,
  login,
}: {
  result: string;
  login: string | null;
}) {
  if (result === "ok") {
    return (
      <div className="mb-6 flex items-center gap-3 rounded-md border border-success/30 bg-success-subtle px-4 py-3">
        {login && (
          <Avatar src={githubAvatarUrl(login)} name={login} size="sm" />
        )}
        <p className="text-[13px] text-fg">
          <span className="font-medium text-success">Connected</span>
          {login ? (
            <>
              {" "}— OMA's GitHub App is installed on{" "}
              <span className="font-medium text-fg">@{login}</span>. Bind an
              agent below to put it to work.
            </>
          ) : (
            <> — OMA's GitHub App is installed. Bind an agent below to put it to work.</>
          )}
        </p>
      </div>
    );
  }
  const message =
    result === "unavailable"
      ? "The managed GitHub App isn't configured on this deployment — ask your admin to set the managed app secrets, or bring your own app."
      : result === "unlinked"
        ? "OMA's GitHub App is installed, but the install wasn't started from here so we couldn't attach it to your workspace. Click Connect below to link it."
        : "The GitHub App install didn't complete. Try again, or bring your own app.";
  return (
    <div className="mb-6 rounded-md border border-warning/30 bg-warning-subtle px-4 py-3 text-[13px] text-fg">
      {message}
    </div>
  );
}

/** One row per in-progress publication. Resume → wizard with `?pub=`;
 *  Discard → DELETE (markUnpublished). */
function PendingRow({
  pub,
  onDiscard,
}: {
  pub: GitHubPublication;
  onDiscard: () => void;
}) {
  const stepNum =
    pub.status === "pending_setup"
      ? 1
      : pub.status === "credentials_filled"
        ? 2
        : 3;
  const statusLabel =
    pub.status === "pending_setup"
      ? "Pending setup"
      : pub.status === "credentials_filled"
        ? "Credentials staged"
        : "Awaiting install";
  return (
    <li className="flex items-center gap-3 px-4 py-3 rounded-md border border-warning/30 bg-warning-subtle/40">
      <Avatar src={pub.persona.avatarUrl} name={pub.persona.name} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="font-medium text-fg text-[14px] truncate">
            {pub.persona.name}
          </span>
          <span className="text-[11px] text-warning">
            ● Step {stepNum} of 3 ({statusLabel})
          </span>
        </div>
        <p className="text-[12px] text-fg-muted">
          Started {formatRelative(Date.now() - pub.created_at)} ago
        </p>
      </div>
      <Link
        to={`/integrations/github/bind?pub=${encodeURIComponent(pub.id)}`}
        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 text-[12px] font-medium rounded-md bg-brand text-brand-fg hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
      >
        Resume install ↗
      </Link>
      <button
        type="button"
        onClick={onDiscard}
        className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 text-[12px] font-medium text-fg-muted hover:text-danger transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
        title="Discard this in-progress install"
      >
        Discard ✕
      </button>
    </li>
  );
}

function WorkspaceCard({
  installation,
  publications,
  onDisconnect,
}: {
  installation: GitHubInstallation;
  publications: GitHubPublication[];
  onDisconnect: () => void;
}) {
  return (
    <div className="border border-border rounded-lg overflow-hidden bg-bg hover:border-border-strong transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]">
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        <div className="flex items-center gap-3 min-w-0">
          <Avatar
            src={githubAvatarUrl(installation.workspace_name)}
            name={installation.workspace_name}
            size="md"
          />
          <div className="min-w-0">
            <div className="flex items-baseline gap-2">
              <h2 className="text-[15px] font-medium text-fg truncate">
                {installation.workspace_name}
              </h2>
              <span className="text-[11px] text-fg-subtle font-mono uppercase tracking-wider">
                org · @{installation.bot_login}
              </span>
            </div>
            <p className="mt-0.5 text-[12px] text-fg-muted">
              GitHub App · full identity ·{" "}
              <span className="text-fg">
                {publications.length} agent{publications.length === 1 ? "" : "s"}
              </span>{" "}
              · installation{" "}
              <span className="font-mono text-fg">{installation.workspace_id}</span>
            </p>
          </div>
        </div>
        <div className="shrink-0 flex items-center gap-3">
          <Link
            to={`/integrations/github/installations/${installation.id}`}
            className="text-[13px] text-fg-muted hover:text-brand transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            Manage →
          </Link>
          <button
            type="button"
            onClick={onDisconnect}
            className="text-[13px] text-fg-muted hover:text-danger transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
            title="Detach this account from your workspace"
          >
            Disconnect
          </button>
        </div>
      </div>

      {publications.length > 0 ? (
        <ul className="border-t border-border divide-y divide-border bg-bg-surface/20">
          {publications.map((p) => (
            <PublicationRow key={p.id} pub={p} />
          ))}
        </ul>
      ) : (
        <div className="border-t border-border bg-bg-surface/20 px-5 py-4 flex items-center justify-between gap-4">
          <p className="text-[12px] text-fg-muted min-w-0">
            No agents bound yet — this GitHub App is installed but idle. Bind an
            agent to give it a bot identity that responds to issues and PRs.
          </p>
          <Link
            to="/integrations/github/bind?mode=managed"
            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1.5 text-[12px] font-medium rounded-md bg-brand text-brand-fg hover:bg-brand-hover transition-colors duration-[var(--dur-quick)] ease-[var(--ease-soft)]"
          >
            Bind an agent →
          </Link>
        </div>
      )}
    </div>
  );
}

// TODO: surface a "Managed" vs "Own app" badge once GitHubPublication
// exposes which connect path was used — no such field on the wire type yet.
function PublicationRow({ pub }: { pub: GitHubPublication }) {
  return (
    <li className="flex items-center gap-3 px-5 py-2.5 text-sm">
      <Avatar src={pub.persona.avatarUrl} name={pub.persona.name} size="sm" />
      <span className="font-medium text-fg flex-1 truncate">{pub.persona.name}</span>
      <StatusPill status={pub.status} />
    </li>
  );
}

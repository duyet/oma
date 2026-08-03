import { memo, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";

import { IntegrationsApi } from "../integrations/api/client";
import { formatRelative } from "../lib/format";
import {
  useGitHubBoardConfig,
  type GitHubBoardConfig,
} from "../lib/useGitHubBoardConfig";
import type { GitHubIssue } from "../integrations/api/types";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import { Select, SelectOption } from "./Select";
import { AssignIssueDialog } from "./AssignIssueDialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** One issue card. Memoized so typing in the config panel above (which is
 *  draft state on the parent) doesn't re-render every card in the grid. */
const IssueCard = memo(function IssueCard({
  issue,
  onAssign,
}: {
  issue: GitHubIssue;
  onAssign: (issue: GitHubIssue) => void;
}) {
  return (
    <div
      className="flex flex-col gap-2 border border-border rounded-lg bg-bg-surface/40 px-3 py-2.5"
      data-testid="github-issue-card"
    >
      <div className="flex items-start justify-between gap-2">
        <a
          href={issue.html_url}
          target="_blank"
          rel="noreferrer"
          className="text-sm font-medium text-fg hover:text-brand line-clamp-2"
        >
          {issue.title}
        </a>
        <span className="shrink-0 text-[11px] text-fg-subtle font-mono">#{issue.number}</span>
      </div>

      {issue.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {issue.labels.slice(0, 6).map((l) => (
            <span
              key={l.name}
              className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-[10px] text-fg-muted"
              style={l.color ? { borderColor: `#${l.color}` } : undefined}
            >
              {l.name}
            </span>
          ))}
        </div>
      )}

      <div className="flex items-center justify-between gap-2 text-[11px] text-fg-subtle">
        <span className="truncate">
          {issue.assignee?.login ? `@${issue.assignee.login}` : "Unassigned"}
        </span>
        <span className="shrink-0">
          {issue.updated_at
            ? formatRelative(Date.now() - new Date(issue.updated_at).getTime())
            : ""}
        </span>
      </div>

      <Button
        variant="secondary"
        size="sm"
        className="mt-1 self-start"
        onClick={() => onAssign(issue)}
      >
        Assign to agent
      </Button>
    </div>
  );
});

/** `<datalist>` id wiring the Assignee input to its fetched options. */
const ASSIGNEE_LIST_ID = "gh-board-assignees";

/** Whether the applied config is complete enough to fetch issues. */
function canFetchIssues(c: GitHubBoardConfig): boolean {
  return !!c.installationId && c.repo.includes("/");
}

export function GitHubIssuesBoard() {
  const nav = useNavigate();
  const api = useMemo(() => new IntegrationsApi(), []);
  const [config, setConfig] = useGitHubBoardConfig();

  // Editable draft — "Apply" commits it to the persisted `config` that
  // actually drives the issues query.
  const [draft, setDraft] = useState<GitHubBoardConfig>(config);
  const [assignIssue, setAssignIssue] = useState<GitHubIssue | null>(null);

  // Every one of these three calls costs a GitHub installation-token mint on
  // the gateway before it even reaches GitHub, so they're cached well past
  // the console-wide 30s default — installations and repos change on the
  // scale of an admin action, not a tab switch.
  const installationsQuery = useQuery({
    queryKey: ["gh-board", "installations"],
    queryFn: () => api.github.listInstallations(),
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
  });
  const installations = installationsQuery.data ?? [];

  // Default the draft installation to the first once installations load and
  // nothing is selected yet.
  useEffect(() => {
    if (!draft.installationId && installations.length > 0) {
      setDraft((d) => ({ ...d, installationId: installations[0].id }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [installations.length]);

  const reposQuery = useQuery({
    queryKey: ["gh-board", "repos", draft.installationId],
    queryFn: () => api.github.listRepos(draft.installationId),
    enabled: !!draft.installationId,
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
  });
  const repos = useMemo(() => reposQuery.data ?? [], [reposQuery.data]);

  // A repo list that failed or came back empty used to leave the picker as a
  // dropdown with nothing in it — a control that visibly does nothing. In
  // that case the field falls back to typing an `owner/repo` slug, which the
  // issues query accepts identically.
  const repoListUnusable =
    !!draft.installationId && !reposQuery.isLoading && (reposQuery.isError || repos.length === 0);
  // The picker only lists the first page of an installation's repos, so an
  // org with more than that needs a way to name one directly.
  const [manualRepo, setManualRepo] = useState(false);
  const typingRepo = repoListUnusable || manualRepo;

  // Assignable users for the repo being edited. Also a cached, proxied read —
  // the browser never talks to GitHub directly.
  const assigneesQuery = useQuery({
    queryKey: ["gh-board", "assignees", draft.installationId, draft.repo],
    queryFn: () => api.github.listAssignees(draft.installationId, draft.repo),
    enabled: !!draft.installationId && draft.repo.includes("/"),
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
  });
  const assignees = assigneesQuery.data ?? [];

  const issuesQuery = useQuery({
    queryKey: [
      "gh-board",
      "issues",
      config.installationId,
      config.repo,
      config.state,
      config.labels,
      config.assignee,
      config.q,
    ],
    queryFn: () =>
      api.github.listIssues(config.installationId, {
        repo: config.repo,
        state: config.state,
        labels: config.labels,
        assignee: config.assignee,
        q: config.q,
      }),
    enabled: canFetchIssues(config),
    staleTime: 60_000,
    gcTime: 30 * 60_000,
    // Keep the previous repo's cards on screen while a re-Apply resolves,
    // instead of flashing the skeleton grid.
    placeholderData: (prev) => prev,
  });

  if (installationsQuery.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    );
  }

  // No GitHub App connected yet → connect CTA.
  if (installations.length === 0) {
    return (
      <EmptyState
        title="Connect GitHub to build an issues board"
        body="Link a GitHub installation to pull issues into a board and assign them to your agents."
        size="lg"
        action={
          <a
            href="/integrations/github"
            className="inline-flex items-center rounded-md bg-brand px-3 py-2 text-sm font-medium text-brand-fg hover:opacity-90 transition-opacity"
          >
            Connect GitHub
          </a>
        }
      />
    );
  }

  const issues = issuesQuery.data?.issues ?? [];
  const applyDisabled = !draft.installationId || !draft.repo.includes("/");

  return (
    <div className="space-y-5">
      {/* ── Config panel ─────────────────────────────────────────────── */}
      <div className="rounded-xl border border-border bg-bg-surface/40 p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          <label className="block">
            <span className="text-xs text-fg-muted block mb-1">Board name</span>
            <Input
              value={draft.boardName}
              onChange={(e) => setDraft({ ...draft, boardName: e.target.value })}
              placeholder="e.g. Triage queue"
            />
          </label>

          {installations.length > 1 && (
            <label className="block">
              <span className="text-xs text-fg-muted block mb-1">Installation</span>
              <Select
                value={draft.installationId}
                onValueChange={(v) => setDraft({ ...draft, installationId: v, repo: "" })}
                placeholder="Select installation…"
              >
                {installations.map((inst) => (
                  <SelectOption key={inst.id} value={inst.id}>
                    {inst.workspace_name}
                  </SelectOption>
                ))}
              </Select>
            </label>
          )}

          <label className="block">
            <span className="text-xs text-fg-muted flex items-center justify-between gap-2 mb-1">
              Repository
              {!repoListUnusable && (
                <button
                  type="button"
                  className="text-[11px] text-fg-subtle underline hover:text-brand"
                  onClick={() => setManualRepo((v) => !v)}
                >
                  {manualRepo ? "Pick from list" : "Enter manually"}
                </button>
              )}
            </span>
            {typingRepo ? (
              <Input
                value={draft.repo}
                onChange={(e) => setDraft({ ...draft, repo: e.target.value })}
                placeholder="owner/repo"
                data-testid="gh-board-repo-input"
              />
            ) : (
              <Select
                value={draft.repo}
                onValueChange={(v) => setDraft({ ...draft, repo: v })}
                placeholder={reposQuery.isLoading ? "Loading repos…" : "Select repository…"}
                disabled={!draft.installationId || reposQuery.isLoading}
              >
                {repos.map((r) => (
                  <SelectOption key={r.full_name} value={r.full_name}>
                    {r.full_name}
                  </SelectOption>
                ))}
              </Select>
            )}
            {repoListUnusable && (
              <span className="mt-1 flex items-center gap-2 text-[11px] text-fg-subtle">
                <span>
                  {reposQuery.isError
                    ? `Couldn't load repositories: ${
                        reposQuery.error instanceof Error
                          ? reposQuery.error.message
                          : "the GitHub request failed"
                      }`
                    : "This installation exposes no repositories — type a slug instead."}
                </span>
                <button
                  type="button"
                  className="shrink-0 underline hover:text-brand"
                  onClick={() => void reposQuery.refetch()}
                >
                  Retry
                </button>
              </span>
            )}
          </label>

          <label className="block">
            <span className="text-xs text-fg-muted block mb-1">State</span>
            <Select
              value={draft.state}
              onValueChange={(v) => setDraft({ ...draft, state: v as "open" | "closed" })}
            >
              <SelectOption value="open">Open</SelectOption>
              <SelectOption value="closed">Closed</SelectOption>
            </Select>
          </label>

          <label className="block">
            <span className="text-xs text-fg-muted block mb-1">Labels</span>
            <Input
              value={draft.labels}
              onChange={(e) => setDraft({ ...draft, labels: e.target.value })}
              placeholder="comma,separated"
            />
          </label>

          <label className="block">
            <span className="text-xs text-fg-muted block mb-1">Assignee</span>
            {/* Combobox, not a select: the fetched list is a convenience, but
                a login that isn't assignable (or a repo whose assignee list
                failed to load) must still be filterable — the browser filters
                the datalist as you type and accepts anything you type. */}
            <Input
              value={draft.assignee}
              onChange={(e) => setDraft({ ...draft, assignee: e.target.value })}
              placeholder="login or 'none'"
              list={assignees.length > 0 ? ASSIGNEE_LIST_ID : undefined}
              data-testid="gh-board-assignee-input"
            />
            {assignees.length > 0 && (
              <datalist id={ASSIGNEE_LIST_ID} data-testid="gh-board-assignee-options">
                {assignees.map((a) => (
                  <option key={a.login} value={a.login} />
                ))}
                <option value="none" />
              </datalist>
            )}
          </label>

          <label className="block sm:col-span-2 lg:col-span-1">
            <span className="text-xs text-fg-muted block mb-1">Keywords</span>
            <Input
              value={draft.q}
              onChange={(e) => setDraft({ ...draft, q: e.target.value })}
              placeholder="free-text search"
            />
          </label>
        </div>

        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-fg-subtle">
            Config is saved in this browser. Issues are read through your GitHub installation —
            no tokens ever reach the page.
          </p>
          <Button onClick={() => setConfig(draft)} disabled={applyDisabled}>
            Apply
          </Button>
        </div>
      </div>

      {/* ── Issues list ──────────────────────────────────────────────── */}
      {!canFetchIssues(config) ? (
        <EmptyState
          title="Pick a repository to load issues"
          body="Choose an installation and repository above, then press Apply."
          size="md"
        />
      ) : issuesQuery.isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-28 w-full" />
          ))}
        </div>
      ) : issuesQuery.isError ? (
        <EmptyState
          title="Couldn't load issues"
          body={
            issuesQuery.error instanceof Error
              ? issuesQuery.error.message
              : "The GitHub request failed. Check the installation still has access to this repo."
          }
          size="md"
        />
      ) : issues.length === 0 ? (
        <EmptyState
          title="No matching issues"
          body="No issues match the current filters in this repository."
          size="md"
        />
      ) : (
        <div>
          <div className="flex items-center justify-between px-1 mb-2">
            <h2 className="text-sm font-medium text-fg">
              {config.boardName?.trim() || config.repo}
            </h2>
            <span className="text-xs text-fg-subtle tabular-nums">{issues.length}</span>
          </div>
          <div
            className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3"
            data-testid="github-issues-board"
          >
            {issues.map((issue) => (
              <IssueCard key={issue.number} issue={issue} onAssign={setAssignIssue} />
            ))}
          </div>
        </div>
      )}

      <AssignIssueDialog
        open={!!assignIssue}
        onClose={() => setAssignIssue(null)}
        issue={assignIssue}
        repo={config.repo}
        onCreated={(sessionId) => {
          setAssignIssue(null);
          nav(`/sessions/${sessionId}`);
        }}
      />
    </div>
  );
}

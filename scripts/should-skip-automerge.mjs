/**
 * Skip rules for `.github/workflows/automerge.yml`.
 * Release PRs are merged by `release.yml` / `release-please.yml` after their
 * own inline verify. Automerge must not squash-merge them when CI goes green.
 */

const SKIP_RULES = [
  {
    name: "release-please branch",
    match: ({ headBranch }) => /^release-please--/.test(headBranch),
  },
  {
    name: "changeset version branch",
    match: ({ headBranch }) => /^changeset-release\//.test(headBranch),
  },
  {
    name: "release title",
    match: ({ title }) =>
      /^chore\(release\)/.test(title) ||
      /^chore(\(.*\))?:\s*release/.test(title),
  },
  {
    name: "changeset version title",
    match: ({ title }) =>
      /^(Version Packages|chore:\s*version packages)$/i.test(title),
  },
];

export function releasePrSkipReason(pr) {
  const headBranch = pr.headBranch ?? "";
  const title = pr.title ?? "";
  for (const rule of SKIP_RULES) {
    if (rule.match({ headBranch, title })) {
      return rule.name;
    }
  }
  return null;
}

import { describe, expect, it } from "vitest";

import { releasePrSkipReason } from "./should-skip-automerge.mjs";

describe("releasePrSkipReason", () => {
  it.each([
    {
      name: "release-please default branch",
      pr: {
        headBranch: "release-please--branches--main",
        title: "chore(release): 0.8.0",
      },
      reason: "release-please branch",
    },
    {
      name: "release-please component branch",
      pr: {
        headBranch: "release-please--branches--main--components--web",
        title: "chore(web): release 0.2.0",
      },
      reason: "release-please branch",
    },
    {
      name: "chore(release) title on a feature branch",
      pr: {
        headBranch: "cursor/something-123",
        title: "chore(release): 0.8.0",
      },
      reason: "release title",
    },
    {
      name: "chore: release title (historical #421 shape)",
      pr: { headBranch: "main-release", title: "chore: release main (#421)" },
      reason: "release title",
    },
    {
      name: "release-please component title",
      pr: { headBranch: "feat/unrelated", title: "chore(web): release 0.2.0" },
      reason: "release title",
    },
    {
      name: "changeset-release/main branch",
      pr: {
        headBranch: "changeset-release/main",
        title: "chore: version packages",
      },
      reason: "changeset version branch",
    },
    {
      name: "default changesets Version Packages title",
      pr: { headBranch: "bot/version", title: "Version Packages" },
      reason: "changeset version title",
    },
    {
      name: "repo changeset title on a non-default branch",
      pr: { headBranch: "bot/version", title: "chore: version packages" },
      reason: "changeset version title",
    },
  ])("skips $name", ({ pr, reason }) => {
    expect(releasePrSkipReason(pr)).toBe(reason);
  });

  it.each([
    {
      name: "ordinary feature PR",
      pr: {
        headBranch: "cursor/skip-automerge-release-prs-6841",
        title: "ci: skip automerge for release-please PRs",
      },
    },
    {
      name: "chore that is not a release",
      pr: { headBranch: "chore/deps", title: "chore: bump vitest" },
    },
    {
      name: "release mentioned after another type",
      pr: { headBranch: "fix/automerge", title: "fix: do not auto-release" },
    },
    {
      name: "human branch that only starts with release-please",
      pr: {
        headBranch: "release-please-docs",
        title: "docs: explain release-please",
      },
    },
    {
      name: "empty title and branch",
      pr: { headBranch: "", title: "" },
    },
  ])("allows $name", ({ pr }) => {
    expect(releasePrSkipReason(pr)).toBeNull();
  });
});

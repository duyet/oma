# Examples

Two kinds of examples live here:

## Harness demos (`examples/claude-agent-sdk/`, `examples/coding-agent/`, `examples/self-improvement-agent/`)

Each is a small, self-contained Docker image (`agent.json` + `README.md` +
`run.sh`) that registers an agent, creates a session, and sends one message
against a running Open Managed Agents instance. They demonstrate specific
harness choices (`default`, `claude-agent-sdk`) and session-resource
patterns (attaching a GitHub repo). Build one with:

```bash
docker build -t oma-example-<name> examples/<name>
docker run --rm -e OMA_BASE_URL=... -e OMA_API_KEY=... -e OMA_ENV_ID=... oma-example-<name>
```

Pre-built images are published to GHCR by
[`.github/workflows/build-example-images.yml`](../.github/workflows/build-example-images.yml)
on every push to `main` that touches `examples/**` — one independent, parallel
matrix job per example:

```
ghcr.io/duyet/oma-example-claude-agent-sdk
ghcr.io/duyet/oma-example-coding-agent
ghcr.io/duyet/oma-example-self-improvement-agent
```

`examples/self-improvement-agent/` scans this repo's own health (typecheck,
tests, CI run history) and files a GitHub issue for each new failure class —
a read-only, issue-filing-only agent using the default harness and a
narrowly-scoped `gh` credential (`cap_cli`).

### Build-it-yourself (not in the GHCR matrix)

`examples/grok-coding-agent/` is a full Dockerfile/README/run.sh example —
same shape as the demos above — but isn't part of the CI build matrix, so
no `ghcr.io/duyet/oma-example-grok-coding-agent` image is published. It
demonstrates routing the same generic coding agent as `examples/coding-agent`
to xAI's Grok through an OpenAI-compatible Model Card (`provider:
"oai-compatible"`) instead of Anthropic — provider swap via config, no
harness or sandbox-image change. Build it locally the same way:
`docker build -t oma-example-grok-coding-agent examples/grok-coding-agent`.

`examples/claude-agent-sdk-server/` is a different shape from every example
above: instead of a *client* that talks to a running instance, it's a
**server-side** template — a Dockerfile layered on the repo's self-host image
(`apps/main-node/Dockerfile`) plus a compose file that boots an instance
preconfigured for the `claude-agent-sdk` harness (`DEFAULT_HARNESS`, Claude
Code CLI auth, sandbox provider). Use it to *get* a server that can run
`examples/claude-agent-sdk/`. Run from the repo root:
`docker compose -f examples/claude-agent-sdk-server/docker-compose.yml up --build`.

## Config templates (`examples/agents/`, `examples/environments/`)

Plain, copy-paste-ready `agent.json` / `environment.json` bodies for common
personas — no Docker image, no harness demo, just `POST` the file as-is
(they follow the "Full Configuration" shape documented in
[`AGENTS.md`](../AGENTS.md#agent-configuration)):

| File | Persona |
|---|---|
| `examples/agents/coding-assistant.json` | General-purpose coding agent, default harness, full file/bash toolset, no web tools. See `examples/coding-agent/` for the fuller GitHub-repo-resource walkthrough of the same idea. |
| `examples/agents/data-analyst.json` | Data analysis agent (pandas/numpy/matplotlib/scikit-learn). Pair with `examples/environments/data-analyst.json` for the matching sandbox packages. |
| `examples/agents/research-agent.json` | Web research agent with `web_search` + `web_fetch` enabled and `aux_model` set so long fetched pages get summarized instead of dumped raw into context. |
| `examples/environments/data-analyst.json` | Environment config mirroring the `data-science` example in `AGENTS.md` — adds `matplotlib`/`scikit-learn` + `ffmpeg` on top of the default sandbox. |

```bash
# Register the agent
curl -s $BASE/v1/agents \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d @examples/agents/data-analyst.json

# Register the matching environment
curl -s $BASE/v1/environments \
  -H "x-api-key: $KEY" -H "content-type: application/json" \
  -d @examples/environments/data-analyst.json
```

These don't get a Docker image: they run against the platform's default
sandbox base image (`apps/agent/Dockerfile`) plus whichever
`environment.config.packages` you attach at session time — there's no
separate build step to publish.

## Built-in skills (`examples/skills/`)

Ready-to-seed skill folders — each a SKILL.md (`name` + `description`
frontmatter + an actionable body) plus supporting files where useful. They're
the default set uploaded by [`scripts/seed-skills.sh`](../scripts/seed-skills.sh),
so a fresh deployment exposes them under `GET /v1/skills` without any extra
downloads. Attach one to an agent with `{ "skill_id": "<id>", "type": "custom" }`.

| Folder | Skill | What it gives an agent |
|---|---|---|
| `examples/skills/data-viz/` | `data-viz` | Chart-type heuristics, colorblind-safe palette, self-contained HTML output |
| `examples/skills/generate-html/` | `generate-html` | Self-contained HTML reports/artifacts — inline CSS/JS, dark/light theme, responsive; ships a `template.html` |
| `examples/skills/query-sql/` | `query-sql` | Schema discovery first, `LIMIT` while exploring, reading query plans, dialect gotchas |
| `examples/skills/github/` | `github` | Using the `gh` CLI for issues/PRs/reviews/checks; never force-pushes or bypasses required checks |
| `examples/skills/git-commit/` | `git-commit` | Conventional Commits, small atomic commits, no push/amend unless asked |
| `examples/skills/spreadsheet-xlsx/` | `spreadsheet-xlsx` | Real `.xlsx` workbooks via openpyxl — typed cells, number formats, a `snippets.py` helper |
| `examples/skills/code-review/` | `code-review` | Read-before-judge review loop, severity-ranked findings, a security checklist; points, never rewrites |
| `examples/skills/web-research/` | `web-research` | Search-then-verify loop with `web_search`/`web_fetch`, primary-vs-hearsay sourcing, dated cross-checks, inline citations |
| `examples/skills/api-design/` | `api-design` | REST conventions — resource modeling, status codes, one error envelope, cursor pagination, backward-compatible change |
| `examples/skills/dockerfile/` | `dockerfile` | Cache-friendly layer order, multi-stage builds, non-root runtime, no baked-in secrets; ships an annotated `Dockerfile.example` |
| `examples/skills/brand-design/` | `brand-design` | Design tokens for color/type/spacing, WCAG-AA contrast, a modular type scale; ships a portable `tokens.json` |
| `examples/skills/debugging/` | `debugging` | Reproduce → isolate → hypothesize → fix at the root → regression test; bisection and single-hypothesis discipline |
| `examples/skills/test-writing/` | `test-writing` | Tests that verify intent not implementation, edge-case checklist, the testing pyramid, determinism rules |
| `examples/skills/security-review/` | `security-review` | OWASP-style checklist — injection classes, authN/authZ, secrets exposure, dependency risk; exploit-scenario reporting |
| `examples/skills/technical-writing/` | `technical-writing` | README/ADR anatomy, lead-with-the-answer structure, runnable examples over prose |
| `examples/skills/data-analysis/` | `data-analysis` | Profile-before-clean workflow, sample-size and bias sanity checks, honest uncertainty reporting |
| `examples/skills/refactoring/` | `refactoring` | Behavior-preserving moves backed by tests, small reversible steps, rule-of-three on duplication |

```bash
# Seed the built-in skills into a running instance
BASE=$BASE KEY=$KEY ./scripts/seed-skills.sh

# Also pull in Anthropic's public skills catalog
SEED_ANTHROPIC=1 BASE=$BASE KEY=$KEY ./scripts/seed-skills.sh

# Fetch named skills from the skills.sh registry (comma-separated).
# skills.sh is a discovery frontend for the `skills` CLI ecosystem — every
# source resolves to a GitHub repo, so the script downloads the repo tarball
# and seeds the SKILL.md dirs it contains. Entries are registry ids / GitHub
# sources, either a whole repo or one skill inside it:
SEED_SKILLS_SH="vercel-labs/agent-skills/web-design-guidelines,anthropics/skills" \
  BASE=$BASE KEY=$KEY ./scripts/seed-skills.sh

# Or fetch from any git repo (GitHub, GitLab, self-hosted; comma-separated):
SEED_FROM_REPO="https://github.com/anthropics/skills" \
  BASE=$BASE KEY=$KEY ./scripts/seed-skills.sh
```

`SEED_SKILLS_SH` / `SEED_FROM_REPO` fail loudly **per entry** — a download,
clone, or "no SKILL.md found" error for one entry prints a `!!` warning and is
skipped; the remaining entries still seed.

Editing a folder here and re-running the script uploads a new custom skill;
these are prompt-fragment skills (the SKILL.md body is inlined into the agent's
system prompt and the files mounted at `/home/user/.skills/<name>/`), distinct
from the no-upload Anthropic catalog skills (`xlsx`, `pdf`, `docx`, `pptx`).

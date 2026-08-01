# Skills

A skill is a `SKILL.md` plus reference files (templates, schemas, examples). At session start the platform mounts everything under `/home/user/.skills/{name}/` in the sandbox **and inlines the SKILL.md body directly into the system prompt** — no lazy read, no follow-up `read` tool call. Format is compatible with Anthropic's [Claude Code skills](https://github.com/anthropics/skills).

Create a skill (JSON; files inlined):

```http
POST /v1/skills
{
  "files": [
    { "filename": "SKILL.md", "content": "---\nname: invoice-parser\ndescription: Parse supplier invoices.\n---\n\n# Steps\n1. ..." },
    { "filename": "schema.json", "content": "{...}" }
  ]
}
```

For large skills with binaries: `POST /v1/skills/upload` multipart with `file=<my-skill.zip>`.

Attach to an agent with the **object form** — a bare string array silently does not bind:

```json
{ "skills": [{ "skill_id": "skill_abc123", "type": "custom" }] }
```

The agent's system prompt then receives, at session start:

```text
<source name="skill:skill_abc123">
<skill name="invoice-parser">
{full SKILL.md body}
</skill>
</source>
```

and the files appear at `/home/user/.skills/invoice-parser/SKILL.md` etc.

Four built-in skills ship ready to attach (no upload): `xlsx`, `pdf`, `docx`, `pptx`. Reference them with `{"skill_id":"builtin_pdf","type":"anthropic"}`.

Six more prompt-fragment skills ship as ready-to-seed folders in [`examples/skills/`](../examples/skills/) — `data-viz`, `generate-html`, `query-sql`, `github`, `git-commit`, `spreadsheet-xlsx`. Load them into a deployment with `./scripts/seed-skills.sh` (add `SEED_ANTHROPIC=1` to also import Anthropic's public catalog), then attach with `{"skill_id":"<id>","type":"custom"}`.

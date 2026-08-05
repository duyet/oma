# Built-in Tools

The `agent_toolset_20260401` provides:

| Tool | Description |
|---|---|
| `bash` | Execute commands in the sandbox |
| `read` | Read files from sandbox filesystem |
| `write` | Write/create files (auto-creates directories) |
| `output_file` | Write a persistent session output artifact under `/mnt/session/outputs/<filename>` — survives session end, downloadable via the Files panel and `GET /v1/sessions/:id/outputs`. Use for final artifacts; scratch work belongs in `/workspace/`. |
| `edit` | Surgical string replacement in files |
| `glob` | Find files matching a pattern |
| `grep` | Search file contents with regex |
| `web_fetch` | URL → markdown via Workers AI; auto-summarized when `agent.aux_model` is set, raw saved to `/workspace/.web/` |
| `web_search` | Web search. Defaults to DuckDuckGo (free, no key). Optional backends via tool `type`: `web_search_20250305` (Anthropic server-side, Claude models only), `web_search_tavily` (requires `TAVILY_API_KEY`) |
| `schedule` / `cancel_schedule` / `list_schedules` | Cron-style self-wakeup for long-running agents |
| `browser` (opt-in) | Headless browser session — navigate, click, screenshot. Opt-in via `tools: [{ name: "browser", enabled: true }]` so the default-tool list nudges agents toward cheaper `web_fetch` |

Derived tools are auto-generated based on session config:

| Tool | Source |
|---|---|
| `call_agent_*` | Callable Agents (multi-agent delegation) |
| `mcp__<server>__<tool>` | MCP Servers (double underscore is the actual separator) |

(Memory Stores do **not** add bespoke tools — agents access them as filesystem
mounts at `/mnt/memory/<store_name>/` via the standard file tools above.)

See also: [MCP servers](mcp-servers.md), [Skills](skills.md), the full
tool catalog in [`AGENTS.md`](../AGENTS.md#tools).

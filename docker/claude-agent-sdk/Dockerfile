# oma-runtime-claude-agent-sdk — SANDBOX tool image only.
#
# Not the server harness image. For the self-host server with
# DEFAULT_HARNESS=claude-agent-sdk see:
#   examples/oma-server-claude-agent-sdk/  →  oma-server-claude-agent-sdk:dev
#
# Naming: oma-runtime-* = sandbox filesystem; oma-server-* = harness host.
#
# Byte-for-byte the base toolset image. The Claude Agent SDK's `query()`
# spawns Claude Code's CLI on the platform host (apps/main-node), NOT
# inside the sandbox. Tool calls are bridged into this sandbox via an
# in-process MCP server. Named separately so environments can pin it.
FROM oma-runtime-base:latest

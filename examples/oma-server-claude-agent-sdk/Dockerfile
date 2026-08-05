# Image name: oma-server-claude-agent-sdk
#
# Self-host OMA *server* preconfigured for harness: claude-agent-sdk.
# This is NOT a sandbox image — do not confuse with
#   oma-runtime-claude-agent-sdk  (sandbox toolset alias under docker/)
#   ghcr.io/duyet/oma-runtime-*   (where bash/read/write execute)
#
# Naming rule:
#   oma-server-*   → control plane + harness host (CLI subprocess lives here)
#   oma-runtime-*  → sandbox filesystem for tool execution
#
# Layers harness defaults on top of apps/main-node. That base already has:
#   - Claude Code CLI via @anthropic-ai/claude-agent-sdk optionalDependencies
#   - child_process + real FS (why this harness is self-host-only)
#   - git / curl / python3 for the sandbox bridge
#
# Build:
#   docker compose -f examples/oma-server-claude-agent-sdk/docker-compose.yml up --build
# Tags as: oma-server-claude-agent-sdk:dev

ARG OMA_BASE_IMAGE=oma/main-node:dev
FROM ${OMA_BASE_IMAGE}

# agent.metadata.harness > DEFAULT_HARNESS > "default"
# (apps/main-node/src/lib/harness-select.ts). Explicit "default" still gets
# the OMA Standard loop on this image.
ENV DEFAULT_HARNESS=claude-agent-sdk
ENV TMPDIR=/tmp

# Secrets — supply at run time, never bake in:
#   ANTHROPIC_API_KEY | CLAUDE_CODE_OAUTH_TOKEN
#   ANTHROPIC_BASE_URL   (AnyRouter Anthropic-compatible route, etc.)
#   BETTER_AUTH_SECRET / PLATFORM_ROOT_SECRET

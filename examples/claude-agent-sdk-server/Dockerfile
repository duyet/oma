# Self-host OMA server image preconfigured for the `claude-agent-sdk` harness.
#
# This does NOT rebuild the server — it layers harness defaults on top of the
# repo's own self-host image (apps/main-node/Dockerfile). That base already
# contains everything the harness needs:
#
#   - Claude Code's CLI. `@anthropic-ai/claude-agent-sdk` is a dependency of
#     apps/agent and ships the per-platform CLI binary via optionalDependencies;
#     the base image's `pnpm install --frozen-lockfile` therefore already
#     placed it in /app/node_modules. There is nothing extra to `npm i -g`.
#   - A real filesystem + child_process, which is the whole reason this
#     harness is self-host-Node-only (see claude-agent-sdk-loop.ts).
#   - git / curl / python3, which the harness's sandbox bridge shells out to.
#
# Build (two steps — the base is not published to a registry):
#   docker build -f apps/main-node/Dockerfile -t oma/main-node:dev .
#   docker build -t oma-claude-agent-sdk-server examples/claude-agent-sdk-server
#
# Or skip both and use the compose file in this directory, which builds the
# base from the repo root for you:
#   docker compose -f examples/claude-agent-sdk-server/docker-compose.yml up --build

ARG OMA_BASE_IMAGE=oma/main-node:dev
FROM ${OMA_BASE_IMAGE}

# Make every agent on this instance default to the Claude Agent SDK harness
# unless its own config says otherwise. Precedence is:
#   agent.metadata.harness  >  DEFAULT_HARNESS  >  "default"
# (see apps/main-node/src/lib/harness-select.ts). So an agent that explicitly
# sets `"harness": "default"` still gets the in-process loop here.
ENV DEFAULT_HARNESS=claude-agent-sdk

# The harness spawns the CLI from a scratch dir under $TMPDIR. The base image
# runs as the unprivileged `node` user, which already owns /tmp — declared
# here only to make the dependency explicit for anyone re-basing this image.
ENV TMPDIR=/tmp

# Inherited from the base image and intentionally NOT set here (they are
# secrets — supply at run time via --env / env_file / your orchestrator):
#   ANTHROPIC_API_KEY        auth for the CLI subprocess
#   CLAUDE_CODE_OAUTH_TOKEN  alternative to the above (`claude setup-token`)
#   ANTHROPIC_BASE_URL       point at an Anthropic-compatible gateway
#   BETTER_AUTH_SECRET / PLATFORM_ROOT_SECRET

# syntax=docker/dockerfile:1.7
#
# Self-host OMA — Node-side single-process image.
#
# Build:
#   docker build -f apps/main-node/Dockerfile -t oma/main-node:dev .
# Run (standalone):
#   docker run --rm -p 8787:8787 \
#     -v $(pwd)/data:/app/data \
#     -e ANTHROPIC_API_KEY=sk-... \
#     oma/main-node:dev
# Run (compose): see docker-compose.yml at repo root.
#
# What's intentionally NOT here yet (Phase G+ work):
#   - Compiled JS bundle. We run via tsx in the container too — same toolchain
#     as `pnpm --filter main-node start`. Adds ~30MB tsx + slows cold start
#     by ~150ms vs a pre-bundled dist; trivial relative to LLM round-trips.
#   - Distroless / scratch base. node:22-slim is ~150MB, fine for a self-host
#     audience. Switch to distroless when packaging matters.

# ─── Stage 1: console-builder (architecture-independent SPA build) ────────
#
# The console is a static Vite SPA: its build output (plain JS/CSS/HTML) is
# identical regardless of the *target* platform's architecture. Building it
# under qemu emulation (e.g. `--platform linux/amd64` from an arm64 host) is
# not just slow — vite's native build tooling (esbuild's compiled binary,
# rollup's and lightningcss's platform-specific napi addons) spawns/dlopens
# real machine code, and that can fail nondeterministically under user-mode
# emulation with `MODULE_NOT_FOUND` even though the right optional package
# was installed. Building on $BUILDPLATFORM runs that toolchain natively on
# the build host instead, sidestepping qemu entirely, and produces the same
# dist/ output for any TARGETPLATFORM. This is what let us drop
# `--build-arg SKIP_CONSOLE=1` as the default escape hatch.
FROM --platform=$BUILDPLATFORM node:22-slim AS console-builder

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpm-approve-builds.json ./
COPY apps/main-node/package.json apps/main-node/
COPY apps/main/package.json apps/main/
COPY apps/agent/package.json apps/agent/
COPY apps/integrations/package.json apps/integrations/
COPY apps/console/package.json apps/console/
COPY apps/docs/package.json apps/docs/
COPY packages packages

RUN corepack enable \
  && pnpm install --frozen-lockfile

COPY apps/console apps/console
COPY tsconfig.json ./

# Build console SPA. Vite produces /app/apps/console/dist; the runtime
# stage sets CONSOLE_DIR to that path and main-node's serveStatic
# middleware picks it up. Skip with --build-arg SKIP_CONSOLE=1 if you
# want a smaller API-only image (e.g. for SDK-only deploys).
ARG SKIP_CONSOLE=0
RUN if [ "$SKIP_CONSOLE" != "1" ]; then \
      pnpm --filter managed-agents-console build; \
    else \
      mkdir -p apps/console/dist; \
    fi

# ─── Stage 2: deps (and native compile, for the target platform) ──────────
FROM node:22-slim AS deps

# better-sqlite3 ships a prebuilt binary for common targets but on
# arm64-glibc-Linux it falls back to compiling from source. python3 +
# build-essential cover both.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Workspace metadata. Copy first so a code-only change doesn't bust the
# pnpm install cache.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .pnpm-approve-builds.json ./
COPY apps/main-node/package.json apps/main-node/
COPY apps/main/package.json apps/main/
COPY apps/agent/package.json apps/agent/
COPY apps/integrations/package.json apps/integrations/
COPY apps/console/package.json apps/console/
COPY apps/docs/package.json apps/docs/
COPY packages packages

# Install workspace deps. --frozen-lockfile fails fast on lockfile drift.
# Build approval list at .pnpm-approve-builds.json covers better-sqlite3 +
# esbuild + workerd + the anthropic tokeniser.
RUN corepack enable \
  && pnpm install --frozen-lockfile

# Now bring in the source code (cache-busts only on src changes, not deps).
COPY apps/main-node apps/main-node
COPY apps/main apps/main
COPY apps/agent apps/agent
COPY tsconfig.json ./

# Console dist was built natively on $BUILDPLATFORM in the console-builder
# stage above — nothing to build here, just place it where main-node's
# serveStatic middleware (CONSOLE_DIR) expects it.
COPY --from=console-builder /app/apps/console/dist apps/console/dist

# ─── Stage 3: runtime ──────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# Tools the agent's bash subprocess relies on. node:22-slim ships almost
# nothing — `curl`, `git`, `ca-certificates` are the bare minimum for the
# harness's bash + read/write/web_fetch tools to do anything useful.
# `python3` is here so build-tooling that shells out to `python` (mostly
# memory store demos + agent-written scripts) doesn't immediately die.
# tsx + better-sqlite3 native module also need basic runtime libs only.
# corepack is needed at runtime so `pnpm start` resolves; alternatively we
# could invoke tsx directly via node_modules/.bin but corepack matches the
# dev workflow exactly.
#
# `corepack prepare` bakes pnpm@<version> into the image at BUILD time under a
# shared COREPACK_HOME. Without it, corepack downloads pnpm from
# registry.npmjs.org on the FIRST `pnpm start` — a transient DNS/network blip
# (EAI_AGAIN registry.npmjs.org) then crashes the container (exit 1) and
# restarts it, orphaning in-flight session sandboxes. COREPACK_HOME lives
# outside /app so the later `COPY --from=deps /app /app` can't clobber it, and
# is world-readable so the unprivileged `node` user resolves the cached pnpm.
ENV COREPACK_HOME=/opt/corepack
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       curl ca-certificates git python3 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@11.0.8 --activate \
  && chmod -R a+rX /opt/corepack
WORKDIR /app

# Copy the whole monorepo from deps (includes node_modules, source, schemas
# and the apps/console/dist copied in from console-builder).
# An optimisation pass would `pnpm deploy --prod` to a slim subtree; for the
# PoC this is the simplest correct copy.
COPY --from=deps /app /app

# pnpm 11's `pnpm start` runs a dependency-status check that can write a temp
# file directly under /app (e.g. `_tmp_19_<hash>`) to verify node_modules
# matches the lockfile before invoking the "start" script. /app is root-owned
# from the COPY above, but the process runs as the unprivileged `node` user
# (below) — without this chown that check fails with EACCES and crash-loops
# the container. Chown the whole tree, not just /app/data.
RUN chown -R node:node /app

# /app/data holds the sqlite db + per-session sandbox workdirs. Mount a
# volume here in production so state survives container restarts.
RUN mkdir -p /app/data && chown -R node:node /app/data

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/app/data/oma.db
ENV SANDBOX_WORKDIR=/app/data/sandboxes
# Console SPA is at /app/apps/console/dist (built natively on $BUILDPLATFORM
# in the console-builder stage, see top of file). main-node only mounts
# serveStatic when that directory contains index.html. SKIP_CONSOLE=1 leaves
# an empty dist, so the image stays API-only without unsetting CONSOLE_DIR.
ENV CONSOLE_DIR=/app/apps/console/dist

EXPOSE 8787
USER node
WORKDIR /app/apps/main-node

# tsx is the entry. SIGTERM is handled by main-node/src/index.ts for
# graceful shutdown.
CMD ["pnpm", "start"]

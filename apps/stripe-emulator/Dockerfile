# syntax=docker/dockerfile:1
# Image for @udemy/stripe-emulator (Phase 4 D12): a TEST-ONLY Stripe API subset, hosted pay page
# and signed webhook delivery. Never deploy it next to production. Build from the REPO ROOT:
#   docker build -f apps/stripe-emulator/Dockerfile -t udemy-stripe-emulator .
# or through compose (profile `emulator`, infra/docker/docker-compose.dev.yml).
ARG NODE_VERSION=22
ARG PNPM_VERSION=10.7.1
ARG TURBO_VERSION=2.11.7

# ---- 1. prune: copy only what @udemy/stripe-emulator (and its workspace deps) need ----
FROM node:${NODE_VERSION}-alpine AS pruner
ARG TURBO_VERSION
WORKDIR /app
RUN npm install -g turbo@${TURBO_VERSION}
COPY . .
# --docker splits output into out/json (package.json files + lockfile, cache-friendly)
# and out/full (sources).
RUN turbo prune @udemy/stripe-emulator --docker

# ---- 2. build: install deps, compile, create a prod-only deployable folder ----
FROM node:${NODE_VERSION}-alpine AS builder
ARG PNPM_VERSION
ARG TURBO_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && npm install -g turbo@${TURBO_VERSION}
WORKDIR /app
# Dependency layer: only re-runs when package.json files / lockfile change.
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
# Source layer.
COPY --from=pruner /app/out/full/ .
RUN turbo run build --filter=@udemy/stripe-emulator
# Self-contained folder with prod deps only. --legacy is needed because pnpm 10 otherwise requires
# inject-workspace-packages=true. Workspace packages (@udemy/payments and its deps) are copied in
# with their built dist/.
RUN pnpm --filter=@udemy/stripe-emulator --prod deploy --legacy /out

# ---- 3. runtime: small, non-root, read-only-rootfs friendly ----
FROM node:${NODE_VERSION}-alpine AS runtime
# All state is in memory; nothing is written to disk. TMPDIR points at the tmpfs compose mounts,
# so the container runs with read_only: true.
ENV NODE_ENV=production \
    PORT=12111 \
    HOST=0.0.0.0 \
    TMPDIR=/tmp
WORKDIR /app
# Owned by root and not writable by the runtime user.
COPY --from=builder /out/ .
USER node
EXPOSE 12111
# busybox wget is in the base image.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${PORT}/health" || exit 1
# node handles SIGTERM/SIGINT itself (graceful close, then exit).
CMD ["node", "dist/main.js"]

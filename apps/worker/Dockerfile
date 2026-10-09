# syntax=docker/dockerfile:1
# Production image for @udemy/worker. Build from the REPO ROOT:
#   docker build -f apps/worker/Dockerfile -t udemy-worker .
ARG NODE_VERSION=22
ARG PNPM_VERSION=10.7.1
ARG TURBO_VERSION=2.11.7

# ---- 1. prune: copy only what @udemy/worker (and its workspace deps) need ----
FROM node:${NODE_VERSION}-alpine AS pruner
ARG TURBO_VERSION
WORKDIR /app
RUN npm install -g turbo@${TURBO_VERSION}
COPY . .
# --docker splits output into out/json (package.json files + lockfile, cache-friendly)
# and out/full (sources).
RUN turbo prune @udemy/worker --docker

# ---- 2. build: install deps, compile, create a prod-only deployable folder ----
FROM node:${NODE_VERSION}-alpine AS builder
ARG PNPM_VERSION
ARG TURBO_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && npm install -g turbo@${TURBO_VERSION}
WORKDIR /app
# Dependency layer: only re-runs when package.json files / lockfile change.
COPY --from=pruner /app/out/json/ .
# (no BuildKit cache mount: Kaniko in GitLab CI does not support them)
RUN pnpm install --frozen-lockfile
# Source layer.
COPY --from=pruner /app/out/full/ .
RUN turbo run build --filter=@udemy/worker
# Self-contained folder with prod deps only. --legacy is needed because pnpm 10
# otherwise requires inject-workspace-packages=true. Workspace packages
# (@udemy/db, @udemy/contracts) are copied in with their built dist/.
RUN pnpm --filter=@udemy/worker --prod deploy --legacy /out

# ---- 3. runtime: small, non-root ----
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /out/ .
USER node
CMD ["node", "dist/main.js"]

# syntax=docker/dockerfile:1
# Production image for @udemy/api. Build from the REPO ROOT:
#   docker build -f apps/api/Dockerfile -t udemy-api .
ARG NODE_VERSION=22
ARG PNPM_VERSION=10.7.1
ARG TURBO_VERSION=2.11.7

# ---- 1. prune: copy only what @udemy/api (and its workspace deps) need ----
FROM node:${NODE_VERSION}-alpine AS pruner
ARG TURBO_VERSION
WORKDIR /app
RUN npm install -g turbo@${TURBO_VERSION}
COPY . .
# --docker splits output into out/json (package.json files + lockfile, cache-friendly)
# and out/full (sources).
RUN turbo prune @udemy/api --docker

# ---- 2. build: install deps, compile, create a prod-only deployable folder ----
FROM node:${NODE_VERSION}-alpine AS builder
ARG PNPM_VERSION
ARG TURBO_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && npm install -g turbo@${TURBO_VERSION}
WORKDIR /app
# Dependency layer: only re-runs when package.json files / lockfile change.
COPY --from=pruner /app/out/json/ .
# (no BuildKit cache mounts yet; Buildx in GitHub Actions supports them if install time matters)
RUN pnpm install --frozen-lockfile
# Source layer.
COPY --from=pruner /app/out/full/ .
RUN turbo run build --filter=@udemy/api
# Self-contained folder with prod deps only. --legacy is needed because pnpm 10
# otherwise requires inject-workspace-packages=true. Workspace packages
# (@udemy/db, @udemy/contracts) are copied in with their built dist/.
RUN pnpm --filter=@udemy/api --prod deploy --legacy /out

# ---- 3. runtime: small, non-root ----
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder --chown=node:node /out/ .
USER node
EXPOSE 4000
CMD ["node", "dist/main.js"]

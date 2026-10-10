# syntax=docker/dockerfile:1
# Image for @udemy/stripe-emulator (Phase 4 D12): a TEST-ONLY Stripe API subset, hosted pay page
# and signed webhook delivery. Never deploy it next to production. Build from the REPO ROOT:
#   docker build -f apps/stripe-emulator/Dockerfile -t udemy-stripe-emulator .
# or through compose (profile `emulator`, infra/docker/docker-compose.dev.yml).
#
# Why a bundle instead of `pnpm deploy --prod` (P4-T19): the emulator needs only @udemy/payments,
# which at runtime loads `stripe` (no dependencies) and the pure error classes of
# @udemy/nest-common/errors. But a deploy installs the whole package graph: nest-common's
# dependencies (@udemy/db with pg + kysely, pino, nodemailer, zod), its Nest peers
# (@nestjs/common/core/config/platform-express, rxjs) and payments' optional `vitest` peer
# (vite, rolldown, esbuild, msw, jsdom, typescript): about 200 MB of node_modules, none of it
# loaded. esbuild follows the real require graph of dist/main.js instead, so the runtime gets
# one file. The runtime base is plain Alpine plus the node binary of the pinned Node image
# (no npm, yarn or corepack in the final image).
ARG NODE_VERSION=22.23.3
ARG ALPINE_VERSION=3.24
ARG PNPM_VERSION=10.7.1
ARG TURBO_VERSION=2.11.7
# The version pnpm-lock.yaml already resolves (vite / vitest); only used at build time.
ARG ESBUILD_VERSION=0.28.2

# ---- 1. prune: copy only what @udemy/stripe-emulator (and its workspace deps) need ----
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS pruner
ARG TURBO_VERSION
WORKDIR /app
RUN npm install -g turbo@${TURBO_VERSION}
COPY . .
# --docker splits output into out/json (package.json files + lockfile, cache-friendly)
# and out/full (sources).
RUN turbo prune @udemy/stripe-emulator --docker

# ---- 2. build: install deps, compile with tsc, bundle the entry point ----
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS builder
ARG PNPM_VERSION
ARG TURBO_VERSION
ARG ESBUILD_VERSION
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
 && npm install -g turbo@${TURBO_VERSION} esbuild@${ESBUILD_VERSION}
WORKDIR /app
# Dependency layer: only re-runs when package.json files / lockfile change.
COPY --from=pruner /app/out/json/ .
RUN pnpm install --frozen-lockfile
# Source layer.
COPY --from=pruner /app/out/full/ .
RUN turbo run build --filter=@udemy/stripe-emulator
# One CommonJS file with stripe, @udemy/payments and nest-common/errors inlined (node built-ins
# stay external). Third-party license comments go to main.js.LEGAL.txt next to it.
RUN esbuild apps/stripe-emulator/dist/main.js --bundle --platform=node --target=node22 \
      --format=cjs --legal-comments=external --outfile=/out/dist/main.js \
 && node -e "require('node:fs').statSync('/out/dist/main.js')"

# ---- 3. node binary from the pinned image (musl build, needs libstdc++ + libgcc) ----
FROM node:${NODE_VERSION}-alpine${ALPINE_VERSION} AS node

# ---- 4. runtime: Alpine + node, non-root, read-only-rootfs friendly ----
FROM alpine:${ALPINE_VERSION} AS runtime
RUN apk add --no-cache libstdc++ \
 && addgroup -g 1000 node \
 && adduser -u 1000 -G node -s /sbin/nologin -D -H node
COPY --from=node /usr/local/bin/node /usr/local/bin/node
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

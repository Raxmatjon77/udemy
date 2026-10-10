# syntax=docker/dockerfile:1
# Production image for @udemy/transcoder (design docs/phase-2-catalog-media-design.md D5, §9).
# Build from the REPO ROOT:
#   docker build -f apps/transcoder/Dockerfile -t udemy-transcoder .
#
# Unlike the api/worker images, the base is pinned to an exact Node + Alpine release (and digest):
# the ffmpeg package version below only exists in one Alpine branch, and the transcoder's output
# (ladder, segment timing, encoder defaults) must not change under us on a rebuild.
#
# Bumping: pick a new node:<ver>-alpine<rel> tag + digest, then look up the ffmpeg/tini versions of
# that Alpine branch (https://pkgs.alpinelinux.org/packages?name=ffmpeg&branch=v<rel>). An exact apk
# pin also FAILS the build once Alpine ships a rebuild (-r1, usually a security fix) and drops the
# old one from the mirror: that is intended, it forces a deliberate bump instead of a silent one.
ARG NODE_IMAGE=node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ARG PNPM_VERSION=10.7.1
ARG TURBO_VERSION=2.11.7
# Alpine 3.24 community, x86_64 and aarch64. The package ships both ffmpeg and ffprobe.
ARG FFMPEG_APK_VERSION=8.1.2-r0
ARG TINI_APK_VERSION=0.19.0-r3

# ---- 1. prune: copy only what @udemy/transcoder (and its workspace deps) need ----
FROM ${NODE_IMAGE} AS pruner
ARG TURBO_VERSION
WORKDIR /app
RUN npm install -g turbo@${TURBO_VERSION}
COPY . .
# --docker splits output into out/json (package.json files + lockfile, cache-friendly)
# and out/full (sources).
RUN turbo prune @udemy/transcoder --docker

# ---- 2. build: install deps, compile, create a prod-only deployable folder ----
FROM ${NODE_IMAGE} AS builder
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
RUN turbo run build --filter=@udemy/transcoder
# Self-contained folder with prod deps only. --legacy is needed because pnpm 10 otherwise requires
# inject-workspace-packages=true. Workspace packages (@udemy/db, @udemy/storage, @udemy/contracts)
# are copied in with their built dist/.
RUN pnpm --filter=@udemy/transcoder --prod deploy --legacy /out

# ---- 3. runtime: non-root, read-only-rootfs-ready, ffmpeg pinned ----
FROM ${NODE_IMAGE} AS runtime
ARG FFMPEG_APK_VERSION
ARG TINI_APK_VERSION
# ffmpeg + ffprobe on PATH (/usr/bin); the app asserts the version at boot (P2-T12).
# tini as PID 1: forwards SIGTERM to node and reaps any orphaned ffmpeg child after a SIGKILL.
# The -version calls fail the build if a binary is missing or cannot load its libraries.
# /tmp/transcoder is the only writable path at runtime (k8s: emptyDir with a sizeLimit; compose: a
# named volume, which inherits this owner on first mount). Source download + outputs live there.
RUN apk add --no-cache "ffmpeg=${FFMPEG_APK_VERSION}" "tini=${TINI_APK_VERSION}" \
 && ffmpeg -hide_banner -version > /dev/null \
 && ffprobe -hide_banner -version > /dev/null \
 && mkdir -p /tmp/transcoder \
 && chown node:node /tmp/transcoder \
 && chmod 0700 /tmp/transcoder

# TMPDIR: os.tmpdir() for any library that writes temp files stays on the writable mount, so the
# container also runs with a read-only root filesystem.
ENV NODE_ENV=production \
    TRANSCODER_FFMPEG_PATH=/usr/bin/ffmpeg \
    TRANSCODER_FFPROBE_PATH=/usr/bin/ffprobe \
    TRANSCODER_TMP_DIR=/tmp/transcoder \
    TRANSCODER_HEALTH_PORT=4002 \
    TMPDIR=/tmp/transcoder

WORKDIR /app
# Owned by root and not writable by the runtime user: the code cannot be modified even when the
# root filesystem is not mounted read-only.
COPY --from=builder /out/ .
USER node
EXPOSE 4002
# busybox wget is in the base image; probes the liveness endpoint of the health port.
HEALTHCHECK --interval=15s --timeout=5s --start-period=30s --retries=3 \
  CMD wget -q -O /dev/null "http://127.0.0.1:${TRANSCODER_HEALTH_PORT}/health/live" || exit 1
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]

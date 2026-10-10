#!/usr/bin/env bash
# Reproduces the GitHub Actions `E2E` workflow (.github/workflows/e2e.yml) against the docker dev stack.
#
#   infra/ci/e2e-local.sh [playwright args...]      e.g. infra/ci/e2e-local.sh tests/sessions.spec.ts
#
# Prerequisites: `nvm use`, `pnpm install`, the root .env, and the dev stack up and healthy
# (docker compose --env-file .env -f infra/docker/docker-compose.dev.yml up -d).
#
# Differences from CI: CI starts a fresh copy of the same compose stack; here the services are the
# long-running dev containers (host ports from .env), and the connector is registered by the compose
# `debezium-init`, so it is only checked here. The transcoder runs on the host like in CI when ffmpeg
# is on PATH; otherwise (E2E_TRANSCODER=compose) Playwright runs the compose `transcoder` service,
# whose image this script rebuilds from the current sources first (the media fixtures are then
# generated with that image's ffmpeg). Override with E2E_TRANSCODER=host|compose|external.
# Like CI, the api/worker secrets, the BFF client secrets and the Stripe key + webhook secret are
# random for this run (exported variables win over .env); the dev data and the dev processes are
# not touched. The suite runs its own stripe-emulator (in memory) on E2E_STRIPE_EMULATOR_PORT.
set -euo pipefail
cd "$(dirname "$0")/../.."

compose=(docker compose --env-file .env -f infra/docker/docker-compose.dev.yml)
step() { printf '\n==> %s\n' "$*"; }
rand() { head -c 32 /dev/urandom | base64 | tr -d '\n'; }
sha256() { printf '%s' "$1" | openssl dgst -sha256 -r | cut -d' ' -f1; }

step "ephemeral secrets"
for name in REFRESH_TOKEN_PEPPER LOGIN_EMAIL_HMAC_KEY EMAIL_TOKEN_SECRET; do
  value="$(rand)"
  export "$name=$value"
done
for app in STUDENT INSTRUCTOR ADMIN; do
  secret="$(rand)"
  hash="$(sha256 "$secret")"
  export "E2E_${app}_CLIENT_SECRET=$secret" "CLIENT_${app}_SECRET_HASH=$hash"
done
# Stripe: a throwaway key and webhook signing secret shared by the api and the suite's own
# stripe-emulator (apps/e2e/src/env.ts), as in CI. The dev .env values are not used.
stripe_key_hex="$(openssl rand -hex 24)"
stripe_whsec_hex="$(openssl rand -hex 32)"
export E2E_STRIPE_SECRET_KEY="sk_test_emulator_local${stripe_key_hex}"
export E2E_STRIPE_WEBHOOK_SECRET="whsec_${stripe_whsec_hex}"

step "JWT signing key"
ls apps/api/.secrets/jwt/*.pem > /dev/null 2>&1 || pnpm --filter @udemy/api keys:generate

step "migrations"
pnpm --filter @udemy/db migrate:latest

step "minio buckets (one-off minio-init container)"
"${compose[@]}" run --rm --no-deps minio-init

step "kafka topics (one-off kafka-init container)"
"${compose[@]}" run --rm --no-deps kafka-init

step "debezium connector"
node infra/ci/register-connector.mjs --url "${E2E_KAFKA_CONNECT_URL:-http://localhost:8083}" \
  --name "${E2E_DEBEZIUM_CONNECTOR:-udemy-outbox}" --wait-only --timeout 60 || {
  echo "Not RUNNING. If it failed before the migrations existed, restart it (infra/docker/README.md)." >&2
  exit 1
}

step "build api, worker, transcoder, stripe-emulator, web-*"
pnpm turbo run build --filter=@udemy/api --filter=@udemy/worker --filter=@udemy/transcoder \
  --filter=@udemy/stripe-emulator --filter='@udemy/web-*'

step "stripe emulator"
# The suite starts its own emulator (E2E_STRIPE_EMULATOR=host) on E2E_STRIPE_EMULATOR_PORT. A dev
# emulator (compose --profile emulator, or `pnpm dev`) on that port would make Playwright refuse
# to start: move the suite's one instead of stopping yours.
if [ "${E2E_STRIPE_EMULATOR:-host}" = host ]; then
  emulator_port="${E2E_STRIPE_EMULATOR_PORT:-12111}"
  if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:${emulator_port}/health" 2>/dev/null; then
    echo "Port ${emulator_port} already serves a stripe emulator. Re-run with E2E_STRIPE_EMULATOR_PORT=<free port>." >&2
    exit 1
  fi
  echo "E2E_STRIPE_EMULATOR=host on 127.0.0.1:${emulator_port}"
fi

step "transcoder"
if [ -z "${E2E_TRANSCODER:-}" ]; then
  if "${TRANSCODER_FFMPEG_PATH:-ffmpeg}" -hide_banner -version > /dev/null 2>&1; then
    export E2E_TRANSCODER=host
  else
    export E2E_TRANSCODER=compose
  fi
fi
echo "E2E_TRANSCODER=${E2E_TRANSCODER}"
if [ "$E2E_TRANSCODER" = compose ]; then
  # The image the suite runs (and generates the fixtures with), built from the current sources.
  "${compose[@]}" --profile transcoder build transcoder
  # Playwright stops the container at the end (SIGTERM); remove it so no stopped copy lingers.
  trap '"${compose[@]}" --profile transcoder rm -f -s transcoder > /dev/null 2>&1 || true' EXIT
fi

step "chromium + Google Chrome"
pnpm --filter @udemy/e2e browsers:install
# The course journey runs in branded Chrome (H.264/AAC playback); Playwright does not download it.
case "$(uname -s)" in
  Darwin) chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ;;
  *) chrome=/opt/google/chrome/chrome ;;
esac
[ -x "$chrome" ] || {
  echo "Google Chrome not found at $chrome. Install it (or: pnpm --filter @udemy/e2e exec playwright install chrome)." >&2
  exit 1
}

step "playwright"
pnpm --filter @udemy/e2e e2e "$@"

# Local dev stack

Only the dependencies run in Docker. The apps run on the host with `pnpm dev`.

## Start / stop

```bash
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml up -d
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml ps      # all should be healthy
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml down    # stop, keep data
```

`minio-init`, `kafka-init` and `debezium-init` are one-shot containers; they exit with code 0 when done.

## Ports and UIs

| Service                | URL / port                             | Notes                                                                    |
| ---------------------- | -------------------------------------- | ------------------------------------------------------------------------ |
| PostgreSQL 18          | localhost:5432                         | db/user/password `udemy`, `wal_level=logical`                            |
| Kafka (KRaft)          | localhost:9092                         | host listener; containers use `kafka:19092`                              |
| Kafka Connect          | http://localhost:8083                  | Debezium REST API                                                        |
| Kafka UI               | http://localhost:8080                  | topics, messages, connectors                                             |
| Redis                  | localhost:6379                         |                                                                          |
| MinIO S3 API / console | localhost:9000 / http://localhost:9001 | `minio` / `minio12345`; buckets `udemy-uploads`, `udemy-media` (private) |
| Mailpit SMTP / UI      | localhost:1025 / http://localhost:8025 |                                                                          |
| Stripe emulator        | http://127.0.0.1:12111                 | profile `emulator` (below); loopback only                                |

Port `12211` is reserved for `stripe/stripe-mock` (the CI `test` job service, container port
12111), so stripe-mock and the emulator never collide.

## MinIO CORS

Browsers talk to MinIO directly through presigned URLs (upload part PUTs, HLS segments, images), so
`minio` sets `MINIO_API_CORS_ALLOW_ORIGIN` to the three web origins (`http://localhost:3000-3002`;
override with `MINIO_CORS_ALLOW_ORIGIN` in `.env`). MinIO has no per-bucket CORS; this is
server-wide, and without it MinIO answers every origin. Apply a change by recreating only minio
(the buckets live on the `minio-data` volume):

```bash
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml up -d --no-deps --force-recreate minio

# allowed origin: 204 with Access-Control-Allow-Origin; any other origin: 204 without it
curl -sS -o /dev/null -D - -X OPTIONS 'http://127.0.0.1:9000/udemy-uploads/x?partNumber=1&uploadId=x' \
  -H 'Origin: http://localhost:3001' -H 'Access-Control-Request-Method: PUT'
```

Apps sign browser URLs with `S3_PUBLIC_ENDPOINT=http://127.0.0.1:9000`: a different site from
`localhost`, so the apps' cookies are never sent to MinIO.

## Transcoder (optional profile)

`apps/transcoder` normally runs on the host (`pnpm dev`, needs `ffmpeg`/`ffprobe` >= 6 on PATH). The
`transcoder` service runs the production image instead (`apps/transcoder/Dockerfile`, ffmpeg 8.1.2
pinned, non-root, read-only root fs, scratch on the `transcoder-tmp` volume), capped at 768 MB,
1 CPU, 1 encoder thread and a 720p ladder ceiling for the 2 GB Docker VM. It is not started by a
plain `up`:

```bash
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml --profile transcoder up -d --build transcoder
```

Stop the host-run transcoder first; both would lease jobs from the same table.

## Stripe (Phase 4)

The API talks to Stripe through the real `StripePaymentProvider` (`@udemy/payments`). In dev that
provider points at **`apps/stripe-emulator`** (`STRIPE_API_BASE_URL=http://127.0.0.1:12111` in
`.env`): Checkout Sessions, Refunds, a hosted pay page (Pay / Decline / Cancel) and **signed**
webhook deliveries to `http://host.docker.internal:4000/api/v1/webhooks/stripe`, i.e. the host-run
API. The emulator and the API share the throwaway `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`
from `.env`. web-student only redirects to origins in `CHECKOUT_ALLOWED_ORIGINS`
(`http://127.0.0.1:12111` in dev).

### Emulator (profile `emulator`)

The `stripe-emulator` service builds `apps/stripe-emulator/Dockerfile`. It sits behind the
`emulator` profile, so a plain `up` never tries to build it (until task P4-T5 adds the app, a
build would fail with `apps/stripe-emulator: no such file or directory`). Either:

```bash
# in Docker
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml --profile emulator up -d --build stripe-emulator

# or on the host
pnpm --filter @udemy/stripe-emulator dev
```

Environment the service passes (the app must read these names): `PORT=12111`, `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `EMULATOR_WEBHOOK_URL` (webhook target) and `EMULATOR_PUBLIC_URL`
(origin of the pay page in `session.url`). `extra_hosts: host.docker.internal:host-gateway` makes
the host-run API reachable on Linux as well. The port is published on 127.0.0.1 only, because
the emulator accepts any test key.

### Real Stripe test mode (profile `stripe`)

For runs against `api.stripe.com`, remove `STRIPE_API_BASE_URL` from `.env`, set
`STRIPE_SECRET_KEY` to your own `sk_test_`/`rk_test_` key, and set `STRIPE_API_KEY` (read by the
CLI) to a test key. **Real keys live only in the untracked `.env`.** The API refuses live keys.

The `stripe-cli` service (`stripe/stripe-cli:v1.53.1`) forwards the events the API handles
(`checkout.session.completed`, `checkout.session.expired`, `charge.refunded`, `refund.updated`,
`refund.failed`, `charge.dispute.created`) to the host-run API. Stripe signs forwarded events with
a per-account CLI secret, not the dev one, so copy it into `STRIPE_WEBHOOK_SECRET` first:

```bash
# 1. print the signing secret (whsec_...), then put it in .env as STRIPE_WEBHOOK_SECRET
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml --profile stripe \
  run --rm stripe-cli listen --api-key "$STRIPE_API_KEY" --print-secret

# 2. restart the API (it reads the secret at boot), then start forwarding
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml --profile stripe up -d stripe-cli
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml logs -f stripe-cli
```

Step 1 needs `STRIPE_API_KEY` in your shell (`set -a; . ./.env; set +a`). The secret stays the same
for the account and device, so this is a one-time step.

**Host-tool alternative** (Stripe CLI installed locally, e.g. `brew install stripe/stripe-cli/stripe`;
it can use `stripe login` instead of an API key):

```bash
stripe listen --print-secret                                          # -> STRIPE_WEBHOOK_SECRET
stripe listen --forward-to localhost:4000/api/v1/webhooks/stripe \
  --events checkout.session.completed,checkout.session.expired,charge.refunded,refund.updated,refund.failed,charge.dispute.created
```

Run only one forwarder (container or host tool) at a time, or each event is delivered twice
(harmless, the webhook dedupes by event id, but noisy).

## Outbox connector

`infra/debezium/outbox-connector.json` is registered by `debezium-init` as connector `udemy-outbox`.

**Order matters.** The connector needs the `outbox.events` table and the `dbz_outbox` publication
(`publication.autocreate.mode=disabled`), both created by a migration. If the connector starts before the
migration has run, its task fails. Run the migration, then restart the task (see below).

```bash
# status (expect connector and tasks[0] state RUNNING)
curl -s http://localhost:8083/connectors/udemy-outbox/status | jq

# restart after a failure (e.g. after running migrations)
curl -s -X POST 'http://localhost:8083/connectors/udemy-outbox/restart?includeTasks=true&onlyFailed=true'

# re-apply config after editing the JSON
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml up debezium-init

# replication slot should exist and be active
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml exec postgres \
  psql -U udemy -c "select slot_name, active from pg_replication_slots"
```

### How the config works

- **Capture:** `pgoutput` plugin, slot `udemy_outbox`, publication `dbz_outbox` on `outbox.events` only.
  `snapshot.mode=no_data` skips an initial snapshot; only changes made after the slot exists are streamed.
  `tombstones.on.delete=false`: no null-value records on deletes.
- **Outbox Event Router SMT:** turns a row of `outbox.events` into the business event.
  - `id` becomes the `eventId` header, `aggregate_id` the Kafka message key, `payload` the message value.
  - `aggregate_type` picks the topic (`route.topic.replacement=${routedByValue}`), so `catalog.course` goes to topic `catalog.course`.
  - `type` / `id` / `aggregate_type` are also added as headers `eventType`, `eventId`, `aggregateType`.
  - Only inserts are routed; the SMT ignores updates, and deletes of outbox rows (cleanup) are dropped.
- **Converters (JSON payload):** key = `StringConverter` (plain id string); value = `JsonConverter` with
  `schemas.enable=false`. The `payload` column is jsonb, which Debezium hands over as a JSON string;
  `table.expand.json.payload=true` makes the router parse it, so the message value is the plain JSON object
  (not an escaped string and not wrapped in a schema/payload envelope).
- Business topics are pre-created by `kafka-init` (below); any other topic is auto-created by the broker
  (3 partitions). The Kafka consumers in `apps/worker` should use the same names.

## Kafka topics (`kafka-init`)

`kafka-init` runs `infra/kafka/create-topics.sh`, which holds **the topic list** (one place, commented).

| Topic                                                                                                            | Partitions | Config                                            |
| ---------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------- |
| `identity.user`, `users.instructor_application`, `access.user_role` and their `.dlq`                             | 3          | `retention.ms=604800000` (7 days: PII, design §7) |
| `catalog.course`, `media.asset` and their `.dlq` (Phase 2)                                                       | 3          | broker defaults (no PII, design §7)               |
| `commerce.order`, `commerce.course_price`, `commerce.coupon`, `enrollment.enrollment` and their `.dlq` (Phase 4) | 3          | broker defaults (no PII, design §7)               |
| `system.ping`                                                                                                    | 3          | broker defaults                                   |

- Idempotent: `kafka-topics.sh --create --if-not-exists`, then `kafka-configs.sh --alter --add-config`.
  If the worker (which creates its handler topics and `.dlq` at startup with broker defaults) or Debezium
  created a topic first, the next `kafka-init` run still applies the retention.
- Partition counts are never changed for an existing topic (that would remap keys); a mismatch is
  only reported as `WARN`.
- To add a topic, add a line to the list and re-run:

```bash
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml up --no-deps kafka-init

# check
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml exec kafka \
  /opt/kafka/bin/kafka-topics.sh --bootstrap-server localhost:19092 --describe --topic identity.user
```

The Kafka CLI prints `WARNING: Due to limitations in metric names, topics with a period ('.') or
underscore ('_') could collide` for names like `users.instructor_application`. It is harmless here,
because no two topic names differ only in `.` vs `_`.

## CI

The GitHub Actions `E2E` workflow (`.github/workflows/e2e.yml`, see `apps/e2e/README.md`) starts
**this compose file** on the runner (`postgres redis mailpit kafka kafka-connect minio`, same host
ports, buckets via `minio-init`),
creates the topics with `docker compose run --rm -T kafka-init`, and registers
`outbox-connector.json` with `infra/ci/register-connector.mjs` instead of `debezium-init`, because
the script also waits until the connector is RUNNING (after the migrations). It can check this
stack's connector too:

```bash
node infra/ci/register-connector.mjs --url http://localhost:8083 --name udemy-outbox --wait-only
```

Image tags, Kafka/Connect settings and the topic list are therefore shared with CI automatically.
The `test` job of `.github/workflows/ci.yml` runs Postgres, Redis, Mailpit and MinIO as service
containers instead (no Debezium there), so keep its image tags equal to the ones here. It also
runs `stripe/stripe-mock:v0.206.0` on host port 12211 (`IT_STRIPE_MOCK_URL`) for the
`@udemy/payments` contract tests; that one is CI-only (locally the tests use Testcontainers).
`infra/ci/e2e-local.sh` replays the e2e job against this stack.

## Prod database roles

Dev uses the single superuser `udemy`. For staging/prod see `infra/postgres/README.md` (`roles.sql`).

## Reset

```bash
# wipe ALL data (postgres, kafka, redis, minio, mailpit) and start fresh
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml down -v
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml up -d
```

Resetting only Postgres but not Kafka (or the reverse) leaves a stale replication slot or Connect offsets;
use `down -v` to keep them consistent. Then re-run migrations and restart the connector task.

## Image note

Upstream `minio/minio` images are no longer published, so the stack uses the frozen `bitnamilegacy/minio` and
`bitnamilegacy/minio-client` images. Acceptable for local dev only, never for production.

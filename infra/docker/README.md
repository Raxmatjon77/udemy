# Local dev stack

Only the dependencies run in Docker. The apps run on the host with `pnpm dev`.

## Start / stop

```bash
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml up -d
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml ps      # all should be healthy
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml down    # stop, keep data
```

`minio-init` and `debezium-init` are one-shot containers; they exit with code 0 when done.

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
- Topics are auto-created by the broker (3 partitions). The Kafka consumers in `apps/worker` should use the same names.

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

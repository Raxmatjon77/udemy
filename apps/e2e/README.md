# @udemy/e2e

Playwright journeys across the three Next apps against the **real** stack: the built api and
worker, the three BFFs (`next start`), Postgres, Redis, Kafka + Debezium and Mailpit. Nothing is
mocked; emails are read back from Mailpit.

| Spec                           | Journey                                                                                             |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| `tests/onboarding.spec.ts`     | signup → verify-pending → mail link (`#token`) → login → apply → admin approves → instructor app    |
| `tests/password-reset.spec.ts` | forgot-password → mail → reset page → new password works, old fails, old session ends               |
| `tests/sessions.spec.ts`       | two browsers → `/account/sessions` lists 2 → "sign out everywhere" ends the other one               |
| `tests/refresh-reuse.spec.ts`  | rotate the refresh token, replay the old one after the 10 s grace → whole session ends + alert mail |
| `tests/access-control.spec.ts` | a student cannot reach web-admin; a protected student page → `/login?next=` → back to `next`        |
| `tests/admin-ban.spec.ts`      | admin bans from `/users/[id]` → session ends, banned login message, mail → unban → login works      |

## Prerequisites

1. Node 22 (`nvm use` in the repo root), `pnpm install`, and Chromium for Playwright:
   `pnpm --filter @udemy/e2e browsers:install`.
2. The docker dev stack, healthy, with the migrations applied (root README /
   `infra/docker/README.md`):
   ```bash
   docker compose --env-file .env -f infra/docker/docker-compose.dev.yml up -d
   pnpm --filter @udemy/db migrate:latest
   ```
3. JWT keys (`pnpm --filter @udemy/api keys:generate`), the root `.env` and the apps'
   `apps/web-*/.env.local` (copied from the `.env.example` files).
4. Production builds of everything the suite starts:
   ```bash
   pnpm turbo run build --filter=@udemy/api --filter=@udemy/worker --filter='@udemy/web-*'
   ```
   `pnpm turbo run e2e` does this for you (the `e2e` task depends on those builds).

## Run

```bash
pnpm --filter @udemy/e2e e2e        # headless, all journeys
pnpm --filter @udemy/e2e e2e:ui     # Playwright UI mode
pnpm turbo run e2e                  # builds api/worker/apps first, then runs the suite
E2E_SKIP_SLOW=1 pnpm --filter @udemy/e2e e2e   # skip the reuse journey (waits ~11 s)
```

`e2e` is deliberately **not** part of `pnpm test`: it needs the docker stack.

What a run does:

1. Playwright starts five servers (`webServer` in `playwright.config.ts`) and waits for their
   health checks: api `node dist/main.js` (`/api/health/ready`), worker `node dist/main.js`
   (`/health/ready`), and `next start` for web-student / web-instructor / web-admin
   (`/api/health`). `reuseExistingServer` is off: a taken port fails the run instead of testing
   someone else's process. All five are stopped (SIGTERM) when the run ends.
2. Global setup (`src/global-setup.ts`) checks that Postgres (with migrations), Redis, Kafka, the
   Debezium connector and Mailpit answer; removes leftovers of an aborted run (`e2e-…@example.test`
   users and mail only); and bootstraps a **fresh e2e admin** with
   `api cli admin:bootstrap --password-stdin` and a random password. The password is passed to the
   test workers in memory (`process.env`) and never written to disk. The dev admin
   (`admin@udemy.local`) is not used.
3. Each test creates its own users (`e2e-<random>@example.test`) and deletes them afterwards with
   SQL (`src/db.ts`, the same statements as the api's `deleteTestUsers`), plus their Mailpit
   messages. Global teardown deletes the e2e admin and any e2e leftovers.

Output (all gitignored, under `.output/`): `logs/<server>.log` (server stdout/stderr of the last
run), `test-results/` (trace, screenshot and video of failed tests), `report/` (HTML report:
`pnpm --filter @udemy/e2e e2e:report`). Open a trace with `npx playwright show-trace <trace.zip>`.

## Ports and env

Defaults: student 3000, instructor 3001, admin 3002, api 4000, worker health 4001. If one is taken
by a process you did not start, move the suite instead of killing it:

```bash
E2E_STUDENT_PORT=3100 E2E_INSTRUCTOR_PORT=3101 E2E_ADMIN_PORT=3102 \
E2E_API_PORT=4100 E2E_WORKER_PORT=4101 pnpm --filter @udemy/e2e e2e
```

Everything that depends on a port is derived from these in `src/env.ts`, because the cookie, Origin
and CSRF checks need every origin to match the URL the browser uses:

| Process       | Env set by the suite                                                                                                                                                                                                   |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| api           | `PORT`, `API_PUBLIC_URL` (= the JWT `iss`); the rest from the root `.env`                                                                                                                                              |
| worker        | `WORKER_HEALTH_PORT`, `STUDENT_/INSTRUCTOR_/ADMIN_APP_ORIGIN` (links in emails); the rest from root `.env`                                                                                                             |
| web-\* (BFFs) | `PORT`, `APP_ORIGIN`, `API_INTERNAL_URL`, `JWT_ISSUER`, `JWKS_URL`, `JWT_AUDIENCE`, `COOKIE_SECURE=true`, the client id/secret from the app's `.env.local` (else `.env.example`); instructor also `STUDENT_APP_ORIGIN` |

Other knobs: `E2E_DATABASE_URL`, `E2E_REDIS_URL`, `E2E_KAFKA_BROKERS` (default: the root `.env`),
`E2E_MAILPIT_URL` (`http://localhost:8025`), `E2E_KAFKA_CONNECT_URL` (`http://localhost:8083`),
`E2E_DEBEZIUM_CONNECTOR` (`udemy-outbox`), `E2E_SERVER_LOG_LEVEL` (`info`), `E2E_SKIP_SLOW=1`, and
`E2E_STUDENT_/INSTRUCTOR_/ADMIN_CLIENT_SECRET` (a BFF's client secret instead of the one in its
`.env.local`; the api then needs the matching `CLIENT_<APP>_SECRET_HASH`, as in CI).

The api and the worker inherit the suite's own environment (Playwright passes `process.env` to the
servers), and exported variables win over the root `.env`. That is how CI configures them without
any `.env` file.

The worker joins the consumer group of the root `.env` (`KAFKA_GROUP_ID`, `udemy-worker`). Stop any
other worker of that group first, or the partitions (and so the emails) are split between them.

Every test sends a random `X-Real-IP` (198.18.0.0/15). The BFFs forward it as the end-user IP,
which keys the API's per-IP rate limits (signup 10/h, login 30/10 min), so repeated runs behave
like different visitors instead of tripping the limits.

The apps run with `COOKIE_SECURE=true` on `http://localhost` (Chromium accepts `Secure` and
`__Host-` cookies there). Use `localhost`, never `127.0.0.1`.

## CI (GitHub Actions, `.github/workflows/e2e.yml`)

The `E2E` workflow runs the suite on every push to `main` (the Docker images in `images.yml` are
only pushed after it passed on that commit), on demand via **Run workflow** (`workflow_dispatch`),
and on pull requests that carry the **`run-e2e`** label (re-runs on every push while the label
stays). Timeout 30 min; it runs separately from `ci.yml` (lint/typecheck/test/build).

- **Runner:** `ubuntu-latest` (4 vCPU / 16 GB for public repos). Node from `.nvmrc`, pnpm from
  `packageManager`, Chromium installed with `playwright install --with-deps chromium` and cached in
  `~/.cache/ms-playwright` by Playwright version.
- **Stack:** the dev compose file itself (`COMPOSE_FILE=infra/docker/docker-compose.dev.yml`),
  started with `up -d` for postgres, redis, mailpit, kafka and kafka-connect: the same images, settings
  (`wal_level=logical`, KRaft, 512 MB heap caps, `CONNECT_PLUGIN_DISCOVERY=service_load`) and host
  ports as in dev, so the `E2E_*` defaults apply. Service containers are not used because they
  cannot pass `-c wal_level=logical` to Postgres.
- **Before the suite:** random `REFRESH_TOKEN_PEPPER` / `LOGIN_EMAIL_HMAC_KEY` /
  `EMAIL_TOKEN_SECRET`, random BFF secrets (`E2E_<APP>_CLIENT_SECRET`) with their SHA-256 in
  `CLIENT_<APP>_SECRET_HASH` (all masked), an ephemeral JWT key, the builds, the migrations, the
  topics via the one-shot `kafka-init` container (`infra/kafka/create-topics.sh`), and
  `infra/ci/register-connector.mjs` (PUTs `infra/debezium/outbox-connector.json` and waits for
  RUNNING). Nothing secret is committed or stored.
- **On failure** the run uploads `apps/e2e/.output/` as the artifact `e2e-output-<run>-<attempt>`
  (7 days): `report/`, `test-results/` (traces), `logs/` (the five servers) and `ci/` (connector
  status, `docker compose ps` and the container logs).

Reproduce it locally against the docker dev stack (same steps, random secrets, the dev
containers are not restarted):

```bash
infra/ci/e2e-local.sh                       # all journeys
infra/ci/e2e-local.sh tests/sessions.spec.ts
```

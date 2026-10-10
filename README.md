# Udemy

[![CI](https://github.com/Raxmatjon77/udemy/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/Raxmatjon77/udemy/actions/workflows/ci.yml)
[![E2E](https://github.com/Raxmatjon77/udemy/actions/workflows/e2e.yml/badge.svg?branch=main)](https://github.com/Raxmatjon77/udemy/actions/workflows/e2e.yml)

A production-grade Udemy clone built for learning: one NestJS modular-monolith backend, three Next.js frontends, PostgreSQL with Debezium-based outbox events on Kafka, deployed to Kubernetes.

See [`docs/architecture-plan.md`](docs/architecture-plan.md) for the full architecture and phased roadmap. [`docs/legacy-task.md`](docs/legacy-task.md) is the original spec of the first version.

## Layout

| Path                                          | What                                                             |
| --------------------------------------------- | ---------------------------------------------------------------- |
| `apps/api`                                    | NestJS 12 HTTP + WebSocket API (`:4000`, Swagger at `/api/docs`) |
| `apps/worker`                                 | Kafka consumers, transcoding, emails                             |
| `apps/web-student`                            | Student app (`:3000`)                                            |
| `apps/web-instructor`                         | Instructor app (`:3001`)                                         |
| `apps/web-admin`                              | Admin app (`:3002`)                                              |
| `packages/db`                                 | Kysely database, migrations, generated types                     |
| `packages/contracts`                          | Shared zod schemas and event contracts                           |
| `packages/ui`                                 | Shared design system (Tailwind v4 + shadcn/ui)                   |
| `packages/tsconfig`, `packages/eslint-config` | Shared tooling config                                            |
| `infra/`                                      | Docker Compose dev stack, Debezium connector, (later) Kubernetes |

## Getting started

```bash
corepack enable
pnpm install
cp .env.example .env
docker compose --env-file .env -f infra/docker/docker-compose.dev.yml up -d
pnpm --filter @udemy/db migrate:latest
pnpm dev
```

## Common tasks

```bash
pnpm lint | pnpm typecheck | pnpm test | pnpm build   # all via Turborepo
pnpm --filter @udemy/db migrate:make <name>           # new migration
pnpm --filter @udemy/db codegen                       # regenerate DB types from live schema
```

## CI (GitHub Actions)

| Workflow                                     | When                                               | What                                                                                                                                                                       |
| -------------------------------------------- | -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`ci.yml`](.github/workflows/ci.yml)         | push to `main`, every PR, manual                   | `lint`, `typecheck`, `test` (Postgres, Redis, Mailpit service containers; integration tests fail instead of skipping) and `build` in parallel                              |
| [`e2e.yml`](.github/workflows/e2e.yml)       | push to `main`, manual, PRs labelled `run-e2e`     | Playwright journeys against the full stack (`infra/docker/docker-compose.dev.yml`), see [`apps/e2e/README.md`](apps/e2e/README.md#ci-github-actions-githubworkflowse2eyml) |
| [`images.yml`](.github/workflows/images.yml) | every PR (build only), `main` after E2E, tags `v*` | api and worker images to `ghcr.io/raxmatjon77/udemy-{api,worker}` (`:<sha>` + `:main`, or `:<tag>`), only once CI and E2E are green                                        |

Secrets are never stored: every run generates its own JWT key and HMAC/client secrets.

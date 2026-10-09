# Udemy

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

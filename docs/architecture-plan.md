# Udemy Clone v2: Production-Grade Rewrite Plan

## Context

`learnigProjects/udemy` was a learning project: NestJS 10, Prisma, a partial domain, and serious defects. The password check is commented out, anyone can sign up as ADMIN, the dashboard and video routes have no auth, routes clash, the role enum doesn't match the DB, prices are stored as Float, queue packages are mixed, and there are no payments or frontend. The goal is to rewrite it as a **production-grade learning project**:

- one NestJS 12 backend (a modular monolith)
- three Next.js frontends (admin, instructor, student)
- PostgreSQL with an outbox table, Debezium and Kafka
- Kubernetes later

Decisions you made: **Next.js**, **modular monolith**, **Kysely**, **Stripe + S3/MinIO + HLS**.

The old repo is a requirements reference only (see `udemy/task.md` and `prisma/schema.prisma`). No code is carried over except ideas: S3 multipart upload, range streaming, and the chat gateway.

---

## 1. Monorepo layout (pnpm workspaces + Turborepo)

```
udemy-v2/
├─ apps/
│  ├─ api/                # NestJS 12 modular monolith (HTTP + WS)
│  ├─ worker/             # same codebase, different entrypoint: Kafka consumers, transcoding, emails
│  ├─ web-student/        # Next.js (App Router, SSR/ISR for catalog & SEO)
│  ├─ web-instructor/     # Next.js (course builder, uploads, analytics)
│  └─ web-admin/          # Next.js (moderation, users, payouts, reports)
├─ packages/
│  ├─ contracts/          # zod schemas + TS types shared FE/BE (DTOs, event payloads)
│  ├─ api-client/         # generated from OpenAPI (orval) + TanStack Query hooks
│  ├─ ui/                 # shadcn/ui + Tailwind design system shared by 3 fronts
│  ├─ db/                 # Kysely instance, generated DB types (kysely-codegen), migrations
│  ├─ eslint-config/ tsconfig/
├─ infra/
│  ├─ docker/             # docker-compose.dev.yml: postgres, kafka (KRaft), kafka-connect+debezium, redis, minio, mailpit, stripe-cli
│  ├─ debezium/           # connector JSON (outbox event router)
│  └─ k8s/                # (phase 7) helm/kustomize
└─ turbo.json, pnpm-workspace.yaml, .github|.gitlab-ci
```

## 2. Backend architecture (apps/api)

**Style:** modular monolith with bounded contexts. Each module uses a clean/hexagonal layout:

```
modules/<context>/
  domain/         # entities, value objects (Money, Slug, Email), domain errors, domain events. No Nest imports.
  application/    # use cases (commands/queries), ports (repository interfaces)
  infrastructure/ # Kysely repositories, external adapters (Stripe, S3), Kafka publishers
  presentation/   # controllers, DTOs (zod schemas via Nest 12's built-in StandardSchemaValidationPipe), guards
  <context>.module.ts
```

**Rules:**

- A module never imports another module's repositories. It calls the other module's exported **application facade**, or it reacts to **Kafka events**.
- Lint enforces this with `eslint-plugin-boundaries`.

**Cross-cutting (`apps/api/src/shared`)**

- **Config:** `@nestjs/config` with zod env validation.
- **Logging:** pino (`nestjs-pino`) with a correlation ID.
- **Errors:** a global exception filter that returns RFC 7807 problem+json.
- **Docs:** OpenAPI (Swagger), which also feeds the `api-client` package.
- **Throttling:** `@nestjs/throttler` backed by Redis.
- **Health:** `@nestjs/terminus` health checks.
- **Observability:** OpenTelemetry traces, Prometheus metrics.
- **Transactions:** a `UnitOfWork`/transaction helper over Kysely, so domain writes and outbox inserts commit in **one transaction**.

**Bounded contexts (modules)**

| Context       | Responsibility                                                                                                                                                                                                                                            |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| identity      | signup/login, Argon2id hashing, JWT access (15 min) + rotating refresh tokens (per device, hashed, reuse detection), email verification, password reset, OAuth (Google) later                                                                             |
| access        | RBAC: roles STUDENT / INSTRUCTOR / ADMIN (users can hold several; STUDENT is implicit), code-defined permission catalog in `@udemy/contracts` (see docs/phase-1-identity-access-design.md), `PoliciesGuard` + ownership policies (instructor owns course) |
| users         | profiles, instructor application/approval flow                                                                                                                                                                                                            |
| catalog       | categories (tree), topics, course, section, lecture (video/article/resource), course versions, publish workflow (DRAFT → IN_REVIEW → PUBLISHED / REJECTED → ARCHIVED)                                                                                     |
| media         | presigned multipart upload to S3/MinIO, asset records, transcoding jobs (FFmpeg → HLS 360/720/1080), signed playback URLs                                                                                                                                 |
| commerce      | cart, coupons, pricing (`numeric(12,2)` + currency), orders, Stripe Checkout + webhooks (idempotent), refunds                                                                                                                                             |
| enrollment    | enrollments (created from `OrderPaid` event), access checks for lectures                                                                                                                                                                                  |
| learning      | lecture progress, course completion %, notes, quizzes/assignments, certificates (PDF)                                                                                                                                                                     |
| engagement    | reviews/ratings (one per user per course, rating aggregates), Q&A threads per lecture, wishlist, announcements                                                                                                                                            |
| payouts       | instructor revenue share ledger (double-entry), monthly payout reports                                                                                                                                                                                    |
| notifications | email (Mailpit in dev), in-app notifications, WebSocket push                                                                                                                                                                                              |
| messaging     | student↔instructor / support chat (socket.io + Redis adapter)                                                                                                                                                                                             |
| search        | Postgres full-text search (tsvector + pg_trgm) first; OpenSearch fed by Debezium CDC as a later stretch goal                                                                                                                                              |
| admin/audit   | moderation queues, user bans, audit log of all admin actions (from events)                                                                                                                                                                                |
| analytics     | instructor dashboards (sales, enrollments, watch time), built from events into read models                                                                                                                                                                |

## 3. Data layer: PostgreSQL + Kysely

- **Migrations:** Kysely `Migrator` with migration files in `packages/db/migrations`. Types are generated by `kysely-codegen` from the live DB, which is the single source of truth.
- **Schema per context:** `identity.*`, `catalog.*`, `commerce.*`, and so on. This makes the boundaries visible in SQL.
- **Table conventions:**
  - 3NF
  - `uuid` PKs (uuidv7)
  - `created_at`, `updated_at`
  - `deleted_at` only where soft delete is truly needed
  - money as `numeric` + `currency`
  - unique constraints the old project lacked: review (user, course), progress (user, lecture), wishlist (user, course), enrollment (user, course)
- **Outbox table:** `outbox.events(id, aggregate_type, aggregate_id, type, payload jsonb, created_at)`. Business code writes to it in the same transaction as its domain write.
- **Debezium Postgres connector:** reads the outbox through the **Outbox Event Router SMT** and publishes Kafka topics (`catalog.course`, `commerce.order`, ...). Publication and replication slot are created by a migration; `wal_level=logical`.
- **Read side:** `pagination` with keyset cursors for the feeds; materialized views or projection tables for course rating, student count and instructor stats.

## 4. Event flow (Kafka)

- **Client:** KafkaJS or `@confluentinc/kafka-javascript` inside `apps/worker`.
- **Idempotent consumers:** each consumer records `processed_events(event_id, consumer)` so duplicates are skipped.
- **Retries:** retry topics plus a DLQ.
- **Event contracts:** defined once in `packages/contracts` (zod), with a version field.

**Key events**

- `UserRegistered` → send welcome email
- `CoursePublished` → reindex search, notify followers
- `OrderPaid` → create enrollment, write payout ledger entries, send receipt email
- `LectureVideoUploaded` → run transcoding job → `LectureVideoReady`
- `LectureCompleted` → recompute progress; when the course is complete → `CourseCompleted` → generate certificate
- `ReviewSubmitted` → update rating aggregate

## 5. Frontends (Next.js App Router, TypeScript)

**Shared across all three**

- `packages/ui` (shadcn/ui + Tailwind)
- `packages/api-client` (OpenAPI → TanStack Query hooks)
- Auth: httpOnly refresh cookie, with the access token kept in memory and refreshed via a BFF route handler
- Forms: react-hook-form + zod schemas from `contracts`
- Playwright for end-to-end tests

**The three apps**

- **web-student:**
  - **Public pages:** home, catalog/search with filters, course landing page (SSR/ISR for SEO)
  - **Purchase:** cart, Stripe checkout
  - **Learning:** "My learning" and the course player (hls.js, resume position, progress), Q&A, notes, quizzes, reviews, certificates
- **web-instructor:**
  - **Onboarding:** become-instructor application
  - **Course builder:** drag-and-drop curriculum, resumable chunked video upload with transcoding status, pricing and coupons, submit for review
  - **Running courses:** answer Q&A, announcements, revenue and analytics dashboards
- **web-admin:**
  - **Users and instructors:** management, instructor approval, bans
  - **Content:** course review/moderation queue, categories
  - **Money:** orders/refunds, payouts, coupons
  - **Oversight:** audit log viewer, system health links

## 6. Testing & quality

- **Unit tests:** Vitest for domain and application layers (pure, no DB).
- **Integration tests:** Testcontainers (Postgres, Kafka, MinIO) for repositories and consumers.
- **API end-to-end:** supertest.
- **Frontend end-to-end:** Playwright for the critical journeys (signup → buy → watch → certificate).
- **Repo hygiene:**
  - Husky + lint-staged + commitlint
  - CI on every PR: lint, type-check, test, build (Turborepo cache)

## 7. Phased roadmap (each phase = shippable vertical slice)

| Phase                        | Deliverable                                                                                                                                                                   |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0. Foundation                | monorepo, tooling, docker-compose dev stack, `packages/db` + first migration, Nest skeleton (config, logging, errors, health, Swagger), CI                                    |
| 1. Identity & Access         | auth (access/refresh rotation, email verify, reset), RBAC + policies, instructor application; minimal login pages in all 3 apps                                               |
| 2. Catalog & Media           | categories, course/section/lecture CRUD with ownership, MinIO multipart upload, FFmpeg → HLS worker, publish/review workflow; instructor course builder + admin moderation UI |
| 3. Outbox + Debezium + Kafka | outbox table, Debezium connector, worker consumers with idempotency/DLQ; move side effects (emails, search index, aggregates) onto events                                     |
| 4. Commerce & Enrollment     | cart, coupons, Stripe Checkout + webhooks, orders, refunds, enrollment from `OrderPaid`; student catalog/landing/cart/checkout                                                |
| 5. Learning experience       | player, progress, notes, Q&A, reviews, quizzes, certificates, notifications + WebSocket                                                                                       |
| 6. Instructor & admin ops    | payouts ledger, analytics read models, audit log, admin reports, search improvements                                                                                          |
| 7. Production & K8s          | Helm charts, Strimzi (Kafka) + CloudNativePG + Debezium on K8s, ingress + cert-manager, HPA, secrets (sealed-secrets/ESO), OTel/Prometheus/Grafana/Loki, GitOps (Argo CD)     |

## 8. Critical files to create first (Phase 0)

- `pnpm-workspace.yaml`, `turbo.json`, `packages/tsconfig`, `packages/eslint-config`
- `infra/docker/docker-compose.dev.yml`. Postgres runs with `wal_level=logical`, Kafka in KRaft mode, Kafka Connect uses the Debezium image, plus Redis, MinIO, Mailpit.
- `packages/db/src/{database.ts,migrator.ts}`, `packages/db/migrations/0001_init.ts`
- `apps/api/src/main.ts`, `app.module.ts`, `shared/{config,logger,errors,database,outbox}`
- `apps/worker/src/main.ts` (Kafka consumer bootstrap)

Execution follows your CLAUDE.md routing:

- **system-architect:** detailed per-context design
- **db-architect:** schema per phase
- **sql-ops:** Kysely migrations
- **nestjs-coder:** modules
- **devops-config:** compose / CI / K8s

## 9. Verification (per phase)

- `docker compose -f infra/docker/docker-compose.dev.yml up` → every service is healthy, and `GET /health` returns ok.
- `pnpm turbo lint typecheck test build` passes.
- **Phase 3:** insert a domain change, then confirm the outbox row → Debezium → Kafka topic (check in Kafka UI) → the worker consumer runs once, even when the event is redelivered.
- **Phase 4:** `stripe listen --forward-to` the webhook, pay with a test card → order is PAID → enrollment exists → the lecture stream URL is authorized.
- **Every phase:** the Playwright journey for that phase's slice passes against the compose stack.

## Open notes

- Confirm the NestJS 12 release status and its Node version requirement during Phase 0, then pin all versions.
- Deployment details (cloud vs local k3d/kind) are deferred to Phase 7, as you asked.

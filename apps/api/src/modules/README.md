# Bounded-context modules

Each folder here is one bounded context from `docs/architecture-plan.md` (identity, catalog,
commerce, ...). Phase 0 has none yet; this file is the template.

## Layout

```
modules/<context>/
  domain/            # entities, value objects (Money, Slug), domain events, invariants.
                     # Pure TypeScript: no Nest, no Kysely, no HTTP.
  application/       # use cases (one class per command/query) + ports (interfaces) such as
                     # `CourseRepository`. Orchestrates domain objects inside a transaction.
  infrastructure/    # adapters that implement the ports: Kysely repositories, Stripe, S3, ...
  presentation/      # controllers, request/response schemas (zod), guards.
  <context>.module.ts  # Nest wiring: binds ports to adapters, registers controllers.
  index.ts           # PUBLIC FACADE: the only file other modules may import.
```

Example `index.ts`:

```ts
export { CatalogModule } from './catalog.module';
export { CatalogFacade } from './application/catalog.facade'; // what other contexts may call
export type { CourseSummary } from './application/dto/course-summary';
```

## Boundary rules (enforced by ESLint, `@udemy/eslint-config/nest`)

| From \ may import | own domain | own application | own infrastructure | own presentation | other module's `index.ts` | `src/shared` |
| ----------------- | ---------- | --------------- | ------------------ | ---------------- | ------------------------- | ------------ |
| domain            | yes        | no              | no                 | no               | no                        | yes          |
| application       | yes        | yes             | no                 | no               | yes                       | yes          |
| infrastructure    | yes        | yes             | yes                | no               | no                        | yes          |
| presentation      | yes        | yes             | no                 | yes              | no                        | yes          |
| `index.ts` facade | yes        | yes             | yes                | yes              | no                        | no           |

- A module never touches another module's tables or repositories. It either calls that module's
  facade (synchronous, same process) or reacts to its Kafka events (asynchronous, via the worker).
- `src/shared` is infrastructure for everyone and imports nothing from `modules/`.
- Domain code uses `@udemy/nest-common/errors` (Nest-free) for `NotFoundError`, `ConflictError`,
  `ValidationError`, `ForbiddenError`, `UnauthorizedError`. The global filter maps them to
  problem+json (404/409/422/403/401).

## Conventions

- **Transactions:** a use case opens one transaction (`withTransaction` from `@udemy/db`) and passes
  the `trx` to every repository call and to `OutboxPublisher.publish(trx, Event, aggregateId, payload)`.
  The domain write and its event commit together or not at all.
- **Events:** define them in `packages/contracts` with
  `defineEvent('CoursePublished', 1, schema, { aggregateType: 'catalog.course' })`.
  The aggregateType is also the Kafka topic.
- **Validation:** request schemas are zod; attach them on the parameter:
  `@Body({ schema: CreateCourseSchema }) body: CreateCourseInput`. Invalid input becomes 400.
- **Routes** are versioned: `/api/v1/...` by default (`@Controller({ path: 'courses', version: '2' })`
  for a new version).
- **Database access:** `@InjectDatabase() private readonly db: Database` in infrastructure only.
- **Tests:** domain and application layers get plain unit tests (no Nest, no DB); repositories get
  integration tests against Postgres (Testcontainers, later phase).

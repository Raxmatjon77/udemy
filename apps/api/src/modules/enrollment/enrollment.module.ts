import { Module } from '@nestjs/common';
import { CatalogModule } from '../catalog';
import { IdentityModule } from '../identity';
import { UsersModule } from '../users';
import { AdminEnrollmentAssembler } from './application/admin-enrollment.assembler';
import { EnrollmentEntitlements } from './application/enrollment-entitlements';
import { EnrollmentWriter } from './application/enrollment-writer';
import { EnrollmentFacade } from './application/enrollment.facade';
import { CoursePriceReader } from './application/ports/course-price.reader';
import { EnrollmentEventPublisher } from './application/ports/enrollment-event.publisher';
import { EnrollmentRepository } from './application/ports/enrollment.repository';
import { FreeEnrollmentRateLimiter } from './application/ports/free-enrollment-rate-limiter';
import { TransactionRunner } from './application/ports/transaction-runner';
import { AdminGrantEnrollmentCommand } from './application/use-cases/admin-grant-enrollment.command';
import { AdminListUserEnrollmentsQuery } from './application/use-cases/admin-list-user-enrollments.query';
import { AdminRevokeEnrollmentCommand } from './application/use-cases/admin-revoke-enrollment.command';
import { EnrollFreeCommand } from './application/use-cases/enroll-free.command';
import { ListMyLearningQuery } from './application/use-cases/list-my-learning.query';
import { KyselyCoursePriceReader } from './infrastructure/kysely-course-price.reader';
import { KyselyEnrollmentRepository } from './infrastructure/kysely-enrollment.repository';
import { KyselyTransactionRunner } from './infrastructure/kysely-transaction-runner';
import { OutboxEnrollmentEventPublisher } from './infrastructure/outbox-enrollment-event.publisher';
import { RedisFreeEnrollmentRateLimiter } from './infrastructure/redis-free-enrollment-rate-limiter';
import { AdminEnrollmentsController } from './presentation/admin-enrollments.controller';
import { MyEnrollmentsController } from './presentation/my-enrollments.controller';

/**
 * enrollment (commerce & enrollment design §3–§8, P4-T12): enrollments and their transition
 * log, the `EnrollmentFacade` (grant / revoke in the caller's transaction, D8), the
 * `EnrollmentEntitlements` adapter of the global `COURSE_ENTITLEMENTS` port, free enrollment
 * (D14), "My learning" and the admin grant / revoke.
 *
 * Depends on catalog through `CatalogFacade` (course summaries, live courses), on identity
 * through `IdentityFacade` (user existence for admin routes) and on users through
 * `UsersFacade` (instructor names on learning cards), plus the global DatabaseModule,
 * OutboxModule, RedisModule and AuthSupportModule. Catalog does NOT depend on enrollment: it
 * only injects `COURSE_ENTITLEMENTS`, which AppModule binds to `EnrollmentEntitlements`.
 *
 * Exports `EnrollmentFacade` (commerce) and `EnrollmentEntitlements` (AppModule only).
 */
@Module({
  imports: [CatalogModule, IdentityModule, UsersModule],
  controllers: [MyEnrollmentsController, AdminEnrollmentsController],
  providers: [
    // Persistence, events, limits
    { provide: TransactionRunner, useClass: KyselyTransactionRunner },
    { provide: EnrollmentRepository, useClass: KyselyEnrollmentRepository },
    { provide: EnrollmentEventPublisher, useClass: OutboxEnrollmentEventPublisher },
    { provide: FreeEnrollmentRateLimiter, useClass: RedisFreeEnrollmentRateLimiter },
    { provide: CoursePriceReader, useClass: KyselyCoursePriceReader },

    // Application services and the public seams
    EnrollmentWriter,
    AdminEnrollmentAssembler,
    EnrollmentFacade,
    EnrollmentEntitlements,

    // Use cases
    EnrollFreeCommand,
    ListMyLearningQuery,
    AdminListUserEnrollmentsQuery,
    AdminGrantEnrollmentCommand,
    AdminRevokeEnrollmentCommand,
  ],
  exports: [EnrollmentFacade, EnrollmentEntitlements],
})
export class EnrollmentModule {}

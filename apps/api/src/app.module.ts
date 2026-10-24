import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { createConfigModule, DatabaseModule } from '@udemy/nest-common';
import { AccessModule, PoliciesGuard } from './modules/access';
import { CatalogModule } from './modules/catalog';
import { CommerceModule } from './modules/commerce';
import { EnrollmentEntitlements, EnrollmentModule } from './modules/enrollment';
import {
  ClientAuthGuard,
  IdentityModule,
  JwtAuthGuard,
  SessionRevocationStore,
} from './modules/identity';
import { MediaModule } from './modules/media';
import { UsersModule } from './modules/users';
import { AuthSupportModule } from './shared/auth';
import { apiEnvSchema, AppConfigModule, ObjectStorageModule } from './shared/config';
import { CourseEntitlementsModule } from './shared/entitlements';
import { ErrorsModule } from './shared/errors';
import { HealthModule } from './shared/health';
import { CourseProgressModule, NoCourseProgress } from './shared/learning-progress';
import { createApiLoggerModule } from './shared/logging';
import { OutboxModule } from './shared/outbox';
import { RealtimeModule } from './shared/realtime';
import { RedisModule } from './shared/redis';
import { RealtimeAwareThrottlerGuard, ThrottlingModule } from './shared/throttler';
import { ValidationModule } from './shared/validation';

@Module({
  imports: [
    // Infrastructure (order: config first, everything else reads from it).
    createConfigModule(apiEnvSchema),
    AppConfigModule,
    // nest-common's pino logger + the payment redactions (Stripe signature, checkout URLs).
    createApiLoggerModule(),
    DatabaseModule.forRoot({ applicationName: 'udemy-api' }),
    RedisModule,
    // The single ObjectStorage (S3/MinIO) client: media + the readiness probe (design §14).
    ObjectStorageModule,
    // Cross-cutting HTTP concerns.
    ErrorsModule,
    ValidationModule,
    ThrottlingModule,
    OutboxModule,
    // Timers for in-process jobs (Phase 4: the CommerceJobs refund dispatcher and reconciler,
    // which call Stripe and therefore live in the API, design D9). Jobs guard themselves with
    // advisory locks, so running on every replica is safe.
    ScheduleModule.forRoot(),
    AuthSupportModule,
    HealthModule,
    // COURSE_ENTITLEMENTS (catalog asks "may this user watch this course?"): an ACTIVE
    // enrollment (Phase 4). Catalog injects only the global token, so EnrollmentModule may
    // import CatalogModule without a cycle (EnrollmentEntitlements needs only its repository).
    CourseEntitlementsModule.forRoot({
      imports: [EnrollmentModule],
      useExisting: EnrollmentEntitlements,
    }),
    // COURSE_PROGRESS (enrollment asks "how far is this user?" for the my-learning cards, Phase 5
    // D21): unknown (null) until learning binds LearningProgressReader (P5-T10).
    CourseProgressModule.forRoot({ useClass: NoCourseProgress }),
    // WS tickets, handshake authentication, the socket.io Redis adapter and emitter (Phase 5
    // D15-D17). The handshake checks session revocation through identity's store.
    RealtimeModule.forRoot({
      imports: [IdentityModule],
      sessionRevocations: SessionRevocationStore,
    }),
    // Bounded contexts (src/modules/*), one import per module facade.
    AccessModule,
    IdentityModule,
    UsersModule,
    MediaModule,
    CatalogModule,
    EnrollmentModule,
    CommerceModule,
  ],
  providers: [
    // Global guards, in this exact order (design §1). Nest runs APP_GUARDs in registration
    // order, so they are all registered here and nowhere else:
    // 1. which BFF is calling (sets the trusted end-user IP/UA),
    // 2. per-client-IP rate limit (needs 1 for the trusted IP),
    // 3. which user (Bearer token bound to the BFF's app),
    // 4. what that user may do (route markers; RouteSecurityAuditor checks them at boot).
    // Each also runs for socket.io handlers: allowed only inside a @RealtimeGateway on a socket
    // the handshake authenticated (Phase 5 design §9); every other non-HTTP context is denied.
    { provide: APP_GUARD, useExisting: ClientAuthGuard },
    { provide: APP_GUARD, useExisting: RealtimeAwareThrottlerGuard },
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: PoliciesGuard },
  ],
})
export class AppModule {}

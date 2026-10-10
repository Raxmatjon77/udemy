import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard } from '@nestjs/throttler';
import { createConfigModule, createLoggerModule, DatabaseModule } from '@udemy/nest-common';
import { AccessModule, PoliciesGuard } from './modules/access';
import { ClientAuthGuard, IdentityModule, JwtAuthGuard } from './modules/identity';
import { UsersModule } from './modules/users';
import { AuthSupportModule } from './shared/auth';
import { apiEnvSchema, AppConfigModule } from './shared/config';
import { CourseEntitlementsModule, DenyAllCourseEntitlements } from './shared/entitlements';
import { ErrorsModule } from './shared/errors';
import { HealthModule } from './shared/health';
import { OutboxModule } from './shared/outbox';
import { RedisModule } from './shared/redis';
import { ThrottlingModule } from './shared/throttler';
import { ValidationModule } from './shared/validation';

@Module({
  imports: [
    // Infrastructure (order: config first, everything else reads from it).
    createConfigModule(apiEnvSchema),
    AppConfigModule,
    createLoggerModule({ serviceName: 'udemy-api' }),
    DatabaseModule.forRoot({ applicationName: 'udemy-api' }),
    RedisModule,
    // Cross-cutting HTTP concerns.
    ErrorsModule,
    ValidationModule,
    ThrottlingModule,
    OutboxModule,
    AuthSupportModule,
    HealthModule,
    // COURSE_ENTITLEMENTS (catalog asks "may this user watch this course?"). Phase 2 has no
    // enrollments, so nobody is entitled; Phase 4 rebinds it here to the enrollment module:
    // forRoot({ imports: [EnrollmentModule], useExisting: EnrollmentEntitlements }).
    CourseEntitlementsModule.forRoot({ useClass: DenyAllCourseEntitlements }),
    // Bounded contexts (src/modules/*), one import per module facade.
    AccessModule,
    IdentityModule,
    UsersModule,
  ],
  providers: [
    // Global guards, in this exact order (design §1). Nest runs APP_GUARDs in registration
    // order, so they are all registered here and nowhere else:
    // 1. which BFF is calling (sets the trusted end-user IP/UA),
    // 2. per-client-IP rate limit (needs 1 for the trusted IP),
    // 3. which user (Bearer token bound to the BFF's app),
    // 4. what that user may do (route markers; RouteSecurityAuditor checks them at boot).
    { provide: APP_GUARD, useExisting: ClientAuthGuard },
    { provide: APP_GUARD, useExisting: ThrottlerGuard },
    { provide: APP_GUARD, useExisting: JwtAuthGuard },
    { provide: APP_GUARD, useExisting: PoliciesGuard },
  ],
})
export class AppModule {}

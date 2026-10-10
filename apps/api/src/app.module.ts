import { Module } from '@nestjs/common';
import { createConfigModule, createLoggerModule, DatabaseModule } from '@udemy/nest-common';
import { AuthSupportModule } from './shared/auth';
import { apiEnvSchema, AppConfigModule } from './shared/config';
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
    // Bounded contexts (src/modules/*) are added here, one import per module facade.
  ],
})
export class AppModule {}

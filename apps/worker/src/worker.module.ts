import { Module } from '@nestjs/common';
import { createConfigModule, createLoggerModule, DatabaseModule } from '@udemy/nest-common';
import { MailModule } from '@udemy/nest-common/mail';
import { CatalogMailModule } from './catalog/catalog-mail.module';
import { CommerceMailModule } from './commerce/commerce-mail.module';
import { EngagementModule } from './engagement/engagement.module';
import { EnrollmentMailModule } from './enrollment/enrollment-mail.module';
import { HandlersModule } from './handlers/handlers.module';
import { HealthModule } from './health/health.module';
import { IdentityMailModule } from './identity/identity-mail.module';
import { LearningModule } from './learning/learning.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { MediaEventsModule } from './media/media-events.module';
import { MessagingModule } from './messaging';
import { NotificationsModule } from './notifications/notifications.module';
import { PayoutsModule } from './payouts/payouts.module';
import { WorkerConfigModule, workerEnvSchema } from './shared/config';
import { RealtimeModule } from './shared/realtime';
import { RedisModule } from './shared/redis';
import { StorageModule } from './shared/storage/storage.module';
import { UsersMailModule } from './users/users-mail.module';

@Module({
  imports: [
    createConfigModule(workerEnvSchema),
    WorkerConfigModule,
    createLoggerModule({ serviceName: 'udemy-worker' }),
    DatabaseModule.forRoot({ applicationName: 'udemy-worker' }),
    // SMTP_HOST / SMTP_PORT / MAIL_FROM (validated by workerEnvSchema).
    MailModule.forRoot(),
    // S3_* (validated by workerEnvSchema); ObjectStorage is destroyed on shutdown.
    StorageModule,
    // REDIS_URL (the api's instance): realtime pushes through @socket.io/redis-emitter.
    RedisModule,
    RealtimeModule,
    MessagingModule,
    HandlersModule,
    IdentityMailModule,
    UsersMailModule,
    CatalogMailModule,
    MediaEventsModule,
    CommerceMailModule,
    EnrollmentMailModule,
    PayoutsModule,
    // Phase 5 (P5-T15): certificates, ratings, notifiers, fan-out and their jobs.
    LearningModule,
    EngagementModule,
    NotificationsModule,
    MaintenanceModule,
    HealthModule,
  ],
})
export class WorkerModule {}

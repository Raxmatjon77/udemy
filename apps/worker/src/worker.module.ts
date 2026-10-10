import { Module } from '@nestjs/common';
import { createConfigModule, createLoggerModule, DatabaseModule } from '@udemy/nest-common';
import { MailModule } from '@udemy/nest-common/mail';
import { HandlersModule } from './handlers/handlers.module';
import { HealthModule } from './health/health.module';
import { IdentityMailModule } from './identity/identity-mail.module';
import { MaintenanceModule } from './maintenance/maintenance.module';
import { MessagingModule } from './messaging';
import { WorkerConfigModule, workerEnvSchema } from './shared/config';
import { UsersMailModule } from './users/users-mail.module';

@Module({
  imports: [
    createConfigModule(workerEnvSchema),
    WorkerConfigModule,
    createLoggerModule({ serviceName: 'udemy-worker' }),
    DatabaseModule.forRoot({ applicationName: 'udemy-worker' }),
    // SMTP_HOST / SMTP_PORT / MAIL_FROM (validated by workerEnvSchema).
    MailModule.forRoot(),
    MessagingModule,
    HandlersModule,
    IdentityMailModule,
    UsersMailModule,
    MaintenanceModule,
    HealthModule,
  ],
})
export class WorkerModule {}

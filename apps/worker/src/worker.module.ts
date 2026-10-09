import { Module } from '@nestjs/common';
import { createConfigModule, createLoggerModule, DatabaseModule } from '@udemy/nest-common';
import { HandlersModule } from './handlers/handlers.module';
import { HealthModule } from './health/health.module';
import { MessagingModule } from './messaging';
import { WorkerConfigModule, workerEnvSchema } from './shared/config';

@Module({
  imports: [
    createConfigModule(workerEnvSchema),
    WorkerConfigModule,
    createLoggerModule({ serviceName: 'udemy-worker' }),
    DatabaseModule.forRoot({ applicationName: 'udemy-worker' }),
    MessagingModule,
    HandlersModule,
    HealthModule,
  ],
})
export class WorkerModule {}

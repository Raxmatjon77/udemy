import { Module } from '@nestjs/common';
import { createConfigModule, createLoggerModule, DatabaseModule } from '@udemy/nest-common';
import { HealthModule } from './health/health.module';
import { JobsModule } from './jobs/jobs.module';
import { TranscoderConfigModule, transcoderEnvSchema } from './shared/config';
import { StorageModule } from './shared/storage/storage.module';

@Module({
  imports: [
    createConfigModule(transcoderEnvSchema),
    TranscoderConfigModule,
    createLoggerModule({ serviceName: 'udemy-transcoder' }),
    DatabaseModule.forRoot({ applicationName: 'udemy-transcoder' }),
    StorageModule,
    JobsModule,
    HealthModule,
  ],
})
export class TranscoderModule {}

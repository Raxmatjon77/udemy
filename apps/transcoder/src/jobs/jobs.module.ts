import { Module } from '@nestjs/common';
import { PipelineModule } from '../pipeline/pipeline.module';
import { TranscoderConfigService } from '../shared/config';
import { JobProcessor } from './job-processor';
import { JobRunner } from './job-runner.service';
import { createWorkerId, JOB_SETTINGS, type JobSettings } from './job-settings';
import { LeaseReaper } from './lease-reaper';

@Module({
  imports: [PipelineModule],
  providers: [
    {
      provide: JOB_SETTINGS,
      inject: [TranscoderConfigService],
      useFactory: (config: TranscoderConfigService): JobSettings => {
        const leaseMs = config.get('TRANSCODER_LEASE_MS');
        return {
          workerId: createWorkerId(),
          leaseMs,
          heartbeatIntervalMs: Math.floor(leaseMs / 3),
          tmpDir: config.get('TRANSCODER_TMP_DIR'),
          maxAttempts: config.get('TRANSCODER_MAX_ATTEMPTS'),
          concurrency: config.get('TRANSCODER_CONCURRENCY'),
          pollIntervalMs: config.get('TRANSCODER_POLL_INTERVAL_MS'),
        };
      },
    },
    JobProcessor,
    LeaseReaper,
    JobRunner,
  ],
  exports: [JobRunner],
})
export class JobsModule {}

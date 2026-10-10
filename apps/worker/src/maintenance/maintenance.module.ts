import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { IdentityCleanupJob } from './identity-cleanup.job';
import { MediaCleanupJob } from './media-cleanup.job';
import { OutboxRetentionJob } from './outbox-retention.job';

/** Scheduled maintenance jobs (retention cleanup, media janitor, outbox retention). ObjectStorage is global. */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [IdentityCleanupJob, MediaCleanupJob, OutboxRetentionJob],
})
export class MaintenanceModule {}

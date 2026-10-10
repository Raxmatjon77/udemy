import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { IdentityCleanupJob } from './identity-cleanup.job';
import { MediaCleanupJob } from './media-cleanup.job';

/** Scheduled maintenance jobs (retention cleanup, media janitor). ObjectStorage is global. */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [IdentityCleanupJob, MediaCleanupJob],
})
export class MaintenanceModule {}

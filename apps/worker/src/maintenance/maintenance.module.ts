import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { IdentityCleanupJob } from './identity-cleanup.job';

/** Scheduled maintenance jobs (retention cleanup). */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [IdentityCleanupJob],
})
export class MaintenanceModule {}

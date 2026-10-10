import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { IdentityCleanupJob } from './identity-cleanup.job';
import { LedgerReconciliationJob } from './ledger-reconciliation.job';
import { MediaCleanupJob } from './media-cleanup.job';
import { OutboxRetentionJob } from './outbox-retention.job';

/**
 * Scheduled maintenance jobs (retention cleanup, media janitor, outbox retention, payouts ledger
 * reconciliation). ObjectStorage is global.
 */
@Module({
  imports: [ScheduleModule.forRoot()],
  providers: [IdentityCleanupJob, MediaCleanupJob, OutboxRetentionJob, LedgerReconciliationJob],
})
export class MaintenanceModule {}

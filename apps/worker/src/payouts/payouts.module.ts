import { Module } from '@nestjs/common';
import {
  LedgerRefundWriterHandler,
  LedgerSaleWriterHandler,
} from './handlers/ledger-writer.handlers';
import { LedgerJournal } from './ledger-journal';

/**
 * `payouts.ledger-writer` (Phase 4 design D13): consumers of `commerce.order` that post the
 * double-entry journal. The periodic reconciliation lives with the other scheduled jobs
 * (MaintenanceModule, LedgerReconciliationJob). Nothing is exported.
 */
@Module({
  providers: [LedgerJournal, LedgerSaleWriterHandler, LedgerRefundWriterHandler],
})
export class PayoutsModule {}

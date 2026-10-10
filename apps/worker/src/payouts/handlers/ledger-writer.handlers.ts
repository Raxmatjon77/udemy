import { Logger } from '@nestjs/common';
import {
  COMMERCE_ORDER_AGGREGATE,
  type EventEnvelope,
  OrderPaid,
  RefundSucceeded,
} from '@udemy/contracts';
import { type DB, type PostOutcome, type Transaction } from '@udemy/db';
import { EventHandler, type EventHandlerContract, parseEvent } from '../../messaging';
import { classifyLedgerError, isSaleMissing, LedgerSaleMissingError } from '../ledger-errors';
import { LedgerJournal } from '../ledger-journal';

/*
 * `payouts.ledger-writer` (Phase 4 design D13, §7; schema doc §1.13, §8.7): double-entry journal
 * entries in `payouts.{accounts,journal_entries,postings}` from `OrderPaid` (one SALE per paid
 * line) and `RefundSucceeded` (the exact mirror REFUND). One handler per event type, so the
 * consumer names are pinned as `payouts.ledger-writer.order-paid` / `.refund-succeeded`.
 *
 * Idempotency is two-layered: `outbox.processed_events` (the dispatcher's claim, in this same
 * transaction) skips a redelivered event, and the ledger's own `UNIQUE (kind, order_line_id,
 * refund_id)` makes a replay under a new event id (or a re-emitted OrderPaid) post nothing
 * (ALREADY_POSTED). Accounts are created lazily by `postSaleEntry`. The balance and mirror
 * triggers are checked before the handler returns (LedgerJournal.checkNow), so a violated
 * invariant is dead-lettered at once instead of being retried.
 */

/** `OrderPaid` -> one SALE entry per line with final > 0. */
@EventHandler(COMMERCE_ORDER_AGGREGATE, OrderPaid.type, {
  consumerName: 'payouts.ledger-writer.order-paid',
})
export class LedgerSaleWriterHandler implements EventHandlerContract {
  private readonly logger = new Logger(LedgerSaleWriterHandler.name);

  constructor(private readonly journal: LedgerJournal) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(OrderPaid, envelope);
    const outcomes: Record<PostOutcome, number> = {
      POSTED: 0,
      ALREADY_POSTED: 0,
      ZERO_AMOUNT: 0,
      LINE_ALREADY_REVERSED: 0,
    };
    try {
      for (const line of event.lines) {
        const result = await this.journal.postSale(trx, {
          orderLineId: line.orderLineId,
          sourceEventId: envelope.eventId,
          occurredAt: new Date(event.paidAt),
          currency: event.currency,
          instructorId: line.instructorId,
          finalAmount: line.finalAmount,
          instructorShareAmount: line.instructorShareAmount,
          platformShareAmount: line.platformShareAmount,
        });
        outcomes[result.outcome] += 1;
      }
      await this.journal.checkNow(trx);
    } catch (error) {
      throw classifyLedgerError(error);
    }
    this.logger.log(
      {
        orderId: event.orderId,
        posted: outcomes.POSTED,
        alreadyPosted: outcomes.ALREADY_POSTED,
        zeroAmount: outcomes.ZERO_AMOUNT,
      },
      'SALE entries written',
    );
  }
}

/** `RefundSucceeded` -> the mirror REFUND entry of the line's SALE. */
@EventHandler(COMMERCE_ORDER_AGGREGATE, RefundSucceeded.type, {
  consumerName: 'payouts.ledger-writer.refund-succeeded',
})
export class LedgerRefundWriterHandler implements EventHandlerContract {
  private readonly logger = new Logger(LedgerRefundWriterHandler.name);

  constructor(private readonly journal: LedgerJournal) {}

  async handle(envelope: EventEnvelope, trx: Transaction<DB>): Promise<void> {
    const event = parseEvent(RefundSucceeded, envelope);
    const context = { refundId: event.refundId, orderLineId: event.orderLineId };

    // PAYMENT_REVIEW -> REFUNDED: never PAID, so no OrderPaid and no SALE; waiting would wedge.
    const paid = await this.journal.orderWasPaid(trx, event.orderId);
    if (paid !== true) {
      this.logger.warn(
        { ...context, orderId: event.orderId, orderExists: paid !== null },
        'RefundSucceeded for an order that was never PAID; no ledger entry',
      );
      return;
    }

    let outcome: PostOutcome;
    try {
      outcome = (
        await this.journal.postRefund(trx, {
          orderLineId: event.orderLineId,
          refundId: event.refundId,
          sourceEventId: envelope.eventId,
          occurredAt: new Date(event.succeededAt),
        })
      ).outcome;
    } catch (error) {
      if (isSaleMissing(error)) {
        throw new LedgerSaleMissingError(event.orderLineId, event.refundId, { cause: error });
      }
      throw classifyLedgerError(error);
    }

    switch (outcome) {
      case 'POSTED':
        try {
          await this.journal.checkNow(trx);
        } catch (error) {
          throw classifyLedgerError(error);
        }
        this.logger.log(context, 'REFUND entry written');
        return;
      case 'ALREADY_POSTED':
        this.logger.log(context, 'REFUND entry already posted; nothing to do');
        return;
      case 'LINE_ALREADY_REVERSED':
        // Commerce allows one SUCCEEDED refund per line: a second one is an anomaly for ops,
        // not something a retry can resolve. The reconciliation job reports it as well.
        this.logger.error(
          context,
          'Order line was already reversed by another refund; REFUND entry skipped',
        );
        return;
      case 'ZERO_AMOUNT':
        return;
    }
  }
}

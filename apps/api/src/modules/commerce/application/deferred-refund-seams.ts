import { Injectable, Logger } from '@nestjs/common';
import type { DB, Transaction } from '@udemy/db';
import type { ChargeRefundedData, ProviderEvent, RefundUpdatedData } from '@udemy/payments';
import {
  ProviderRefundEvents,
  type RefundEventResult,
  RefundDispatchTrigger,
} from './ports/provider-refund-events';

/**
 * P4-T15 binding of the refund-webhook seam: the event is claimed (deduped) and recorded as
 * IGNORED with the order it belongs to when the payment intent is known. P4-T16 replaces
 * this provider with the real refund state machine.
 */
@Injectable()
export class DeferredProviderRefundEvents extends ProviderRefundEvents {
  private readonly logger = new Logger(DeferredProviderRefundEvents.name);

  apply(
    _trx: Transaction<DB>,
    event: ProviderEvent,
    data: ChargeRefundedData | RefundUpdatedData,
  ): Promise<RefundEventResult> {
    this.logger.warn(
      `provider event ${event.id} (${data.type}) recorded; refund handling lands with P4-T16`,
    );
    return Promise.resolve({ outcome: 'IGNORED', orderId: null });
  }
}

/** P4-T15 binding of the dispatcher kick: nothing dispatches refunds yet (P4-T16). */
@Injectable()
export class NoRefundDispatch extends RefundDispatchTrigger {
  private readonly logger = new Logger(NoRefundDispatch.name);

  kick(): void {
    this.logger.log('approved refunds are waiting for the P4-T16 dispatcher');
  }
}

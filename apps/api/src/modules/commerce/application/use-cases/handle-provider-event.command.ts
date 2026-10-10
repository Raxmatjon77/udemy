import { Injectable, Logger } from '@nestjs/common';
import type { ProviderEventOutcome } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import type {
  ChargeDisputeCreatedData,
  CheckoutSessionCompletedData,
  CheckoutSessionExpiredData,
  ProviderEvent,
} from '@udemy/payments';
import { orderIdCandidates, receivedDecimal } from '../../domain/checkout';
import { OrderLifecycle } from '../order-lifecycle.service';
import { CartRepository } from '../ports/cart.repository';
import { CommerceClock } from '../ports/commerce-clock';
import { CommerceEventPublisher } from '../ports/commerce-event.publisher';
import { OrderRepository } from '../ports/order.repository';
import { ProviderEventInbox } from '../ports/provider-event.inbox';
import { ProviderRefundEvents, RefundDispatchTrigger } from '../ports/provider-refund-events';
import { TransactionRunner } from '../ports/transaction-runner';

/** Who delivered the event: a signed webhook, or the reconciler's `retrieve()` (synthetic id). */
export type ProviderEventSource = 'WEBHOOK' | 'RECONCILER';

export interface HandleProviderEventResult {
  /** DUPLICATE: the event id was already claimed (a replay); nothing was done. */
  readonly outcome: ProviderEventOutcome | 'DUPLICATE';
  readonly orderId: string | null;
}

interface Applied {
  readonly outcome: ProviderEventOutcome;
  readonly orderId: string | null;
  readonly refundsApproved?: number;
}

const ASYNC_PAYMENT_EVENT = /^checkout\.session\.async_payment_(succeeded|failed)$/;

/**
 * `HandleProviderEvent` (design §5, D10, R2/R6): ONE transaction claims the event in
 * `commerce.provider_events` (a concurrent duplicate blocks on the PK, then sees the conflict:
 * DUPLICATE, 200), applies the state transition, writes the outbox events and records the
 * outcome. Transitions are monotonic and state-guarded, so replayed or reordered events are
 * no-ops; an unexpected error rolls everything back (500, the provider retries).
 *
 * - `checkout.session.completed` (paid): PAID + grants (or PAYMENT_REVIEW on an amount /
 *   currency mismatch, `OrderPaymentMismatch`); already paid: DUPLICATE_EFFECT.
 * - `checkout.session.expired`: a PENDING_PAYMENT order -> EXPIRED; otherwise a no-op.
 * - `charge.dispute.created`: recorded + `PaymentDisputed` (admin alert; no revoke in P4).
 * - refund events: the P4-T16 `ProviderRefundEvents` seam.
 * - everything else, and `livemode: true` (Phase 4 is test mode): IGNORED.
 *
 * `checkout.session.async_payment_*` are IGNORED on purpose: sessions allow cards only
 * (`allowed_payment_method_types: ['card']`, §14), so payment is synchronous and `completed`
 * carries the result; a session completed unpaid is resolved by the reconciler's
 * authoritative `retrieve()` once it is overdue.
 */
@Injectable()
export class HandleProviderEventCommand {
  private readonly logger = new Logger(HandleProviderEventCommand.name);

  constructor(
    private readonly tx: TransactionRunner,
    private readonly inbox: ProviderEventInbox,
    private readonly orders: OrderRepository,
    private readonly carts: CartRepository,
    private readonly lifecycle: OrderLifecycle,
    private readonly events: CommerceEventPublisher,
    private readonly clock: CommerceClock,
    private readonly refundEvents: ProviderRefundEvents,
    private readonly dispatch: RefundDispatchTrigger,
  ) {}

  async execute(
    event: ProviderEvent,
    payloadSha256: Buffer,
    source: ProviderEventSource = 'WEBHOOK',
  ): Promise<HandleProviderEventResult> {
    const result = await this.tx.run(async (trx): Promise<Applied | null> => {
      const claimed = await this.inbox.claim(trx, {
        eventId: event.id,
        type: event.providerType,
        livemode: event.livemode,
        objectId: objectIdOf(event),
        providerCreatedAt: event.createdAt,
        payloadSha256,
      });
      if (!claimed) return null;
      const applied = await this.apply(trx, event, source);
      await this.inbox.finish(trx, event.id, applied.outcome, applied.orderId);
      return applied;
    });
    if (result === null) {
      this.logger.log(`provider event ${event.id} (${event.providerType}) is a duplicate`);
      return { outcome: 'DUPLICATE', orderId: null };
    }
    if ((result.refundsApproved ?? 0) > 0) this.dispatch.kick();
    return { outcome: result.outcome, orderId: result.orderId };
  }

  private async apply(
    trx: Transaction<DB>,
    event: ProviderEvent,
    source: ProviderEventSource,
  ): Promise<Applied> {
    if (event.livemode) {
      this.logger.error(`provider event ${event.id} is livemode; Phase 4 is test mode only`);
      return { outcome: 'IGNORED', orderId: null };
    }
    const data = event.data;
    switch (data.type) {
      case 'checkout.session.completed':
        return this.completed(trx, event, data, source);
      case 'checkout.session.expired':
        return this.expired(trx, event, data, source);
      case 'charge.dispute.created':
        return this.disputed(trx, event, data);
      case 'charge.refunded':
      case 'refund.updated':
      case 'refund.failed':
        return this.refundEvents.apply(trx, event, data);
      case 'unhandled':
        if (ASYNC_PAYMENT_EVENT.test(event.providerType)) {
          this.logger.warn(
            `provider event ${event.id} (${event.providerType}) ignored: card-only sessions are synchronous`,
          );
        }
        return { outcome: 'IGNORED', orderId: null };
    }
  }

  /** `metadata.orderId`, then `client_reference_id`, then the stored session id (§5). */
  private async resolveOrder(
    trx: Transaction<DB>,
    data: CheckoutSessionCompletedData | CheckoutSessionExpiredData,
  ): Promise<string | null> {
    for (const candidate of orderIdCandidates(data.orderId, data.clientReferenceId)) {
      if ((await this.orders.findOwner(candidate, trx)) !== null) return candidate;
    }
    return this.orders.findOrderIdBySession(data.sessionId, trx);
  }

  private async completed(
    trx: Transaction<DB>,
    event: ProviderEvent,
    data: CheckoutSessionCompletedData,
    source: ProviderEventSource,
  ): Promise<Applied> {
    const orderId = await this.resolveOrder(trx, data);
    if (orderId === null) {
      this.logger.error(`provider event ${event.id}: no order for session ${data.sessionId}`);
      return { outcome: 'ORPHAN', orderId: null };
    }
    if (data.paymentStatus !== 'paid') {
      return { outcome: 'IGNORED', orderId };
    }
    const received = data.amountTotalMinor === null ? null : receivedDecimal(data.amountTotalMinor);
    if (
      data.paymentIntentId === null ||
      received === null ||
      data.currency === null ||
      !/^[A-Z]{3}$/.test(data.currency)
    ) {
      this.logger.error(
        `provider event ${event.id}: paid session ${data.sessionId} lacks a payment intent, amount or currency`,
      );
      return { outcome: 'IGNORED', orderId };
    }
    const result = await this.orders.markPaid(trx, {
      orderId,
      cause: source === 'RECONCILER' ? 'RECONCILER' : 'PROVIDER_EVENT',
      providerEventId: event.id,
      checkoutSessionId: data.sessionId,
      paymentIntentId: data.paymentIntentId,
      receivedAmount: received,
      receivedCurrency: data.currency,
    });
    switch (result.outcome) {
      case 'NOT_FOUND':
        return { outcome: 'ORPHAN', orderId: null };
      case 'DUPLICATE_EFFECT':
        return { outcome: 'DUPLICATE_EFFECT', orderId };
      case 'MISMATCH': {
        const header = await this.orders.findHeader(orderId, trx);
        if (header === null) throw new Error(`order ${orderId} vanished inside its transaction`);
        this.logger.error(
          `order ${orderId}: provider charged ${received} ${data.currency}, expected ${header.totalAmount} ${header.currency}; PAYMENT_REVIEW`,
        );
        await this.events.orderPaymentMismatch(trx, {
          orderId,
          expected: { amount: header.totalAmount, currency: header.currency },
          received: { amount: received, currency: data.currency },
          providerEventId: event.id,
          detectedAt: (await this.clock.now(trx)).toISOString(),
        });
        return { outcome: 'MISMATCH', orderId };
      }
      case 'APPLIED': {
        const settled = await this.lifecycle.settlePaid(trx, {
          orderId,
          userId: result.userId,
          provider: 'STRIPE',
          paidAt: result.paidAt,
          lines: result.lines,
        });
        if (result.previousStatus !== 'PENDING_PAYMENT') {
          this.logger.warn(`order ${orderId}: late payment after ${result.previousStatus}`);
        }
        return { outcome: 'APPLIED', orderId, refundsApproved: settled.duplicateRefunds };
      }
    }
  }

  private async expired(
    trx: Transaction<DB>,
    event: ProviderEvent,
    data: CheckoutSessionExpiredData,
    source: ProviderEventSource,
  ): Promise<Applied> {
    const orderId = await this.resolveOrder(trx, data);
    const userId = orderId === null ? null : await this.orders.findOwner(orderId, trx);
    if (orderId === null || userId === null) {
      this.logger.error(`provider event ${event.id}: no order for session ${data.sessionId}`);
      return { outcome: 'ORPHAN', orderId: null };
    }
    await this.carts.lockCart(trx, userId);
    const order = await this.orders.lockOrder(trx, orderId);
    if (order === null) return { outcome: 'ORPHAN', orderId: null };
    if (order.status !== 'PENDING_PAYMENT') {
      // Expired after completed / canceled: a no-op (monotonic transitions).
      const closed = order.status === 'EXPIRED' || order.status === 'CANCELED';
      return { outcome: closed ? 'DUPLICATE_EFFECT' : 'IGNORED', orderId };
    }
    if (order.paymentStatus !== 'OPEN' || order.checkoutSessionId !== data.sessionId) {
      // The session expired before tx B stored it: the reconciler abandons the order.
      this.logger.warn(
        `provider event ${event.id}: order ${orderId} payment is ${order.paymentStatus}; left to the reconciler`,
      );
      return { outcome: 'IGNORED', orderId };
    }
    await this.lifecycle.close(trx, userId, {
      orderId,
      toStatus: 'EXPIRED',
      cause: source === 'RECONCILER' ? 'RECONCILER' : 'PROVIDER_EVENT',
      actorId: null,
      providerEventId: event.id,
    });
    return { outcome: 'APPLIED', orderId };
  }

  private async disputed(
    trx: Transaction<DB>,
    event: ProviderEvent,
    data: ChargeDisputeCreatedData,
  ): Promise<Applied> {
    const orderId =
      data.paymentIntentId === null
        ? null
        : await this.orders.findOrderIdByPaymentIntent(data.paymentIntentId, trx);
    if (orderId === null || data.paymentIntentId === null) {
      this.logger.error(`provider event ${event.id}: dispute ${data.disputeId} has no order`);
      return { outcome: 'ORPHAN', orderId: null };
    }
    this.logger.warn(`order ${orderId}: payment disputed (${data.reason ?? 'no reason'})`);
    await this.events.paymentDisputed(trx, {
      orderId,
      paymentIntentId: data.paymentIntentId,
      openedAt: event.createdAt.toISOString(),
    });
    return { outcome: 'APPLIED', orderId };
  }
}

/** The provider object the event is about (`provider_events.object_id`). */
function objectIdOf(event: ProviderEvent): string | null {
  const data = event.data;
  switch (data.type) {
    case 'checkout.session.completed':
    case 'checkout.session.expired':
      return data.sessionId;
    case 'charge.refunded':
      return data.chargeId;
    case 'refund.updated':
    case 'refund.failed':
      return data.providerRefundId;
    case 'charge.dispute.created':
      return data.disputeId;
    case 'unhandled':
      return null;
  }
}

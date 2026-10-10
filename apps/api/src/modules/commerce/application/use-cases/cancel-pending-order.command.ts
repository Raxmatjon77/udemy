import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OrderDetail } from '@udemy/contracts';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  PaymentProviderError,
  PaymentProviderUnavailableError,
} from '@udemy/payments';
import { OrderNotCancelable, OrderNotFound } from '../../domain/commerce.errors';
import { cancelDecision } from '../../domain/checkout';
import { CreatingPaymentAbandoner } from '../creating-payment-abandoner.service';
import { OrderLifecycle } from '../order-lifecycle.service';
import { OrderViews } from '../order-views.service';
import { CartRepository } from '../ports/cart.repository';
import { OrderRepository } from '../ports/order.repository';
import { TransactionRunner } from '../ports/transaction-runner';

export interface CancelPendingOrderInput {
  readonly userId: string;
  readonly orderId: string;
}

/**
 * `CancelPendingOrder` (design §5, D15): the buyer gives up a PENDING_PAYMENT order (the
 * success/cancel page, or "Cancel and start over" after `checkout_in_progress`).
 *
 * 1. OPEN session: expire it at the provider first. `ALREADY_COMPLETE` is 409
 *    `order_not_cancelable` (the webhook marks it PAID). Expiry is best effort beyond that: if
 *    the provider is unreachable the order is canceled anyway, and a payment that still
 *    completes on the old session is the defensive late-payment path (CANCELED -> PAID).
 *    CREATING payment: the abandon path (replay, then expire; nobody holds its url).
 * 2. One transaction under the cart + order locks: CANCELED, payment EXPIRED / ABANDONED,
 *    redemptions RELEASED, `OrderCanceled`.
 * 3. A repeat (or an order that already EXPIRED) answers 200 with the current state.
 */
@Injectable()
export class CancelPendingOrderCommand {
  private readonly logger = new Logger(CancelPendingOrderCommand.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly orders: OrderRepository,
    private readonly carts: CartRepository,
    private readonly lifecycle: OrderLifecycle,
    private readonly abandoner: CreatingPaymentAbandoner,
    private readonly views: OrderViews,
    private readonly tx: TransactionRunner,
  ) {}

  async execute(input: CancelPendingOrderInput): Promise<OrderDetail> {
    const order = await this.orders.findCheckoutSnapshot(input.orderId);
    if (order?.userId !== input.userId) throw new OrderNotFound();
    const decision = cancelDecision(order.status);
    if (decision === 'not_cancelable') throw new OrderNotCancelable();
    if (decision === 'already_closed') return this.views.detail(input.orderId, input.userId);

    if (order.paymentStatus === 'CREATING') {
      const outcome = await this.abandoner.abandon(
        input.orderId,
        { kind: 'USER_CANCEL', actorId: input.userId },
        { bestEffort: true },
      );
      if (outcome === 'COMPLETED') throw new OrderNotCancelable();
      return this.afterCancel(input);
    }

    if (order.checkoutSessionId !== null) {
      await this.expireAtProvider(input.orderId, order.checkoutSessionId);
    }
    await this.tx.run(async (trx) => {
      await this.carts.lockCart(trx, input.userId);
      const locked = await this.orders.lockOrder(trx, input.orderId);
      if (locked === null) throw new OrderNotFound();
      if (locked.status !== 'PENDING_PAYMENT') return;
      await this.lifecycle.close(trx, input.userId, {
        orderId: input.orderId,
        toStatus: 'CANCELED',
        cause: 'USER_CANCEL',
        actorId: input.userId,
        providerEventId: null,
      });
    });
    return this.afterCancel(input);
  }

  /** The order after the attempt; paid meanwhile (the webhook won) is 409. */
  private async afterCancel(input: CancelPendingOrderInput): Promise<OrderDetail> {
    const detail = await this.views.detail(input.orderId, input.userId);
    if (cancelDecision(detail.status) === 'not_cancelable') throw new OrderNotCancelable();
    return detail;
  }

  private async expireAtProvider(orderId: string, sessionId: string): Promise<void> {
    let result: Awaited<ReturnType<PaymentProvider['expireCheckoutSession']>>;
    try {
      result = await this.provider.expireCheckoutSession(sessionId);
    } catch (error) {
      if (
        error instanceof PaymentProviderUnavailableError ||
        error instanceof PaymentProviderError
      ) {
        this.logger.warn(
          `order ${orderId}: could not expire the checkout session (${error.name}); canceling anyway`,
        );
        return;
      }
      throw error;
    }
    if (result === 'ALREADY_COMPLETE') throw new OrderNotCancelable();
  }
}

import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  PAYMENT_PROVIDER,
  type PaymentProvider,
  PaymentProviderUnavailableError,
} from '@udemy/payments';
import { CheckoutSessions } from './checkout-sessions.service';
import { OrderLifecycle } from './order-lifecycle.service';
import { CartRepository } from './ports/cart.repository';
import { CommerceClock } from './ports/commerce-clock';
import { OrderRepository } from './ports/order.repository';
import { TransactionRunner } from './ports/transaction-runner';
import { syntheticCheckoutEvent } from './synthetic-provider-event';
import { HandleProviderEventCommand } from './use-cases/handle-provider-event.command';

export type AbandonCause =
  { readonly kind: 'RECONCILER' } | { readonly kind: 'USER_CANCEL'; readonly actorId: string };

export type AbandonOutcome =
  /** The order is CANCELED and its payment ABANDONED. */
  | 'CANCELED'
  /** The provider had a COMPLETE session: the payment was applied instead (PAID). */
  | 'COMPLETED'
  /** Nothing to do: the payment already left CREATING (or the order is gone). */
  | 'UNCHANGED';

/**
 * Abandons an order whose payment is stuck in CREATING (design §4 Payment "CREATING ->
 * ABANDONED", schema doc §8.5 (a)): replay the create with the same idempotency key and the
 * stored `expires_at` (the provider returns the session it holds, or makes one nobody holds),
 * expire it, then ABANDONED + CANCELED. Used by the reconciler, by cancel, and by a checkout
 * resume that is past the create window.
 */
@Injectable()
export class CreatingPaymentAbandoner {
  private readonly logger = new Logger(CreatingPaymentAbandoner.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly sessions: CheckoutSessions,
    private readonly orders: OrderRepository,
    private readonly carts: CartRepository,
    private readonly lifecycle: OrderLifecycle,
    private readonly tx: TransactionRunner,
    private readonly clock: CommerceClock,
    private readonly handleEvent: HandleProviderEventCommand,
  ) {}

  /**
   * @param bestEffort cancel even when the provider is unreachable. Safe: a CREATING payment's
   *   url never reached the browser (it is returned only after tx B stores it), so nobody can
   *   pay a session the provider might hold; it expires on its own.
   * @throws PaymentProviderUnavailableError when not `bestEffort` and the provider is down
   */
  async abandon(
    orderId: string,
    cause: AbandonCause,
    options: { readonly bestEffort: boolean },
  ): Promise<AbandonOutcome> {
    const snapshot = await this.orders.findCheckoutSnapshot(orderId);
    if (
      snapshot === null ||
      snapshot.status !== 'PENDING_PAYMENT' ||
      snapshot.paymentStatus !== 'CREATING'
    ) {
      return 'UNCHANGED';
    }
    let replay: { sessionId: string | null; complete: boolean } = {
      sessionId: null,
      complete: false,
    };
    try {
      replay = await this.sessions.replayAndExpire(snapshot);
    } catch (error) {
      if (!(error instanceof PaymentProviderUnavailableError) || !options.bestEffort) throw error;
      this.logger.warn(`order ${orderId}: provider unreachable; abandoning without replay`);
    }

    if (replay.complete && replay.sessionId !== null) {
      // Paid before tx B could store the session: apply it like the webhook would.
      const session = await this.provider.retrieveCheckoutSession(replay.sessionId);
      const now = await this.tx.run((trx) => this.clock.now(trx));
      const { event, payloadSha256 } = syntheticCheckoutEvent(session, 'COMPLETED', now);
      await this.handleEvent.execute(event, payloadSha256, 'RECONCILER');
      return 'COMPLETED';
    }

    return this.tx.run(async (trx) => {
      await this.carts.lockCart(trx, snapshot.userId);
      const order = await this.orders.lockOrder(trx, orderId);
      if (order?.status !== 'PENDING_PAYMENT' || order.paymentStatus !== 'CREATING') {
        return 'UNCHANGED';
      }
      await this.lifecycle.close(trx, snapshot.userId, {
        orderId,
        toStatus: 'CANCELED',
        cause: cause.kind,
        actorId: cause.kind === 'USER_CANCEL' ? cause.actorId : null,
        providerEventId: null,
        abandonedSessionId: replay.sessionId,
      });
      this.logger.log(`order ${orderId}: CREATING payment abandoned (${cause.kind})`);
      return 'CANCELED';
    });
  }
}

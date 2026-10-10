import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type CheckoutSessionCreated,
  checkoutSessionIdempotencyKey,
  PAYMENT_PROVIDER,
  type PaymentProvider,
  PaymentProviderError,
  PaymentUsageError,
} from '@udemy/payments';
import { minorOf } from '../domain/checkout';
import { CommerceSettings } from './commerce-settings';
import { CommerceBuyers } from './ports/context-gateways';
import type { CheckoutSnapshot } from './ports/order.repository';

/** The provider refused to give a usable session (not an outage): see the log. */
export class CheckoutSessionRejected extends Error {
  constructor(
    /** The session the provider did create (expire it). */
    readonly sessionId: string,
    message: string,
    options: { cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = new.target.name;
  }
}

/**
 * The Checkout Session calls (design §5, D9). Never called inside a database transaction.
 * Every create of an order uses the SAME parameters (`checkout-session:{orderId}`, the stored
 * `session_expires_at`, the line snapshot, the derived URLs), so a retry, a resume and the
 * reconciler's replay all get the original session back from the provider (§14, §6 item 6).
 */
@Injectable()
export class CheckoutSessions {
  private readonly logger = new Logger(CheckoutSessions.name);

  constructor(
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly buyers: CommerceBuyers,
    private readonly settings: CommerceSettings,
  ) {}

  /**
   * Creates (or replays) the order's session.
   *
   * @throws PaymentProviderUnavailableError (outage: retry with the same key)
   * @throws PaymentProviderError subclasses (the provider refused the parameters)
   * @throws CheckoutSessionRejected when the returned url is not an allowed checkout origin
   */
  async create(order: CheckoutSnapshot): Promise<CheckoutSessionCreated> {
    if (order.sessionExpiresAt === null) {
      throw new Error(`order ${order.orderId} has no payment to create a session for`);
    }
    const buyer = await this.buyers.findBuyer(order.userId);
    const session = await this.provider.createCheckoutSession(
      {
        orderId: order.orderId,
        currency: order.currency,
        lines: order.lines.map((line) => ({
          name: line.courseTitle,
          unitAmountMinor: minorOf(line.finalAmount, order.currency),
        })),
        customerEmail: buyer?.email ?? null,
        successUrl: this.settings.checkoutSuccessUrl(order.orderId),
        cancelUrl: this.settings.checkoutCancelUrl(order.orderId),
        expiresAt: order.sessionExpiresAt,
      },
      { idempotencyKey: checkoutSessionIdempotencyKey(order.orderId) },
    );
    if (!this.settings.isAllowedCheckoutUrl(session.url)) {
      // Never hand an unexpected origin to the browser (the url itself is not logged, §9).
      throw new CheckoutSessionRejected(
        session.sessionId,
        `order ${order.orderId}: session ${session.sessionId} has a checkout url outside CHECKOUT_ALLOWED_ORIGINS`,
      );
    }
    return session;
  }

  /**
   * Best-effort replay-then-expire for a CREATING payment (reconcile (a), cancel, a resume
   * past the create window). Returns the session the provider holds for the order, or null
   * when it holds none (the replay was refused: a fresh create with a too-near `expires_at`,
   * or an idempotency conflict, so nobody can have that session's url). A session that is
   * already complete is reported so the caller applies the payment instead.
   *
   * @throws PaymentProviderUnavailableError (outage: try again later)
   */
  async replayAndExpire(
    order: CheckoutSnapshot,
  ): Promise<{ sessionId: string | null; complete: boolean }> {
    let sessionId: string;
    try {
      sessionId = (await this.create(order)).sessionId;
    } catch (error) {
      if (error instanceof PaymentProviderError || error instanceof PaymentUsageError) {
        this.logger.warn(
          `order ${order.orderId}: replaying the session create was refused (${describe(error)}); no session exists`,
        );
        return { sessionId: null, complete: false };
      }
      if (!(error instanceof CheckoutSessionRejected)) throw error;
      this.logger.error(error.message);
      sessionId = error.sessionId;
    }
    const expired = await this.provider.expireCheckoutSession(sessionId);
    return { sessionId, complete: expired === 'ALREADY_COMPLETE' };
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

import { Injectable, Logger } from '@nestjs/common';
import { type CartQuote, ErrorCode, type OrderStatus } from '@udemy/contracts';
import type { DB, Transaction } from '@udemy/db';
import { PaymentProviderError, PaymentProviderUnavailableError } from '@udemy/payments';
import {
  AmountBelowMinimum,
  CartChanged,
  CartEmpty,
  CheckoutEmailNotVerified,
  CheckoutInProgress,
  IdempotencyKeyReused,
  InvalidCommerceField,
  PaymentProviderUnavailable,
  PriceChanged,
} from '../../domain/commerce.errors';
import { checkoutBlock, resumeDecision } from '../../domain/checkout';
import { Money } from '../../domain/money';
import type { Quote } from '../../domain/quote';
import { CartQuoteService } from '../cart-quote.service';
import { CheckoutSessionRejected, CheckoutSessions } from '../checkout-sessions.service';
import { CommerceSettings, PROVIDER_MIN_SESSION_LIFETIME_MIN } from '../commerce-settings';
import { violatedConstraint } from '../constraint-violation';
import { CreatingPaymentAbandoner } from '../creating-payment-abandoner.service';
import { OrderLifecycle } from '../order-lifecycle.service';
import { CartRepository } from '../ports/cart.repository';
import { CommerceClock } from '../ports/commerce-clock';
import { CommerceEventPublisher } from '../ports/commerce-event.publisher';
import { CommerceRateLimiter } from '../ports/commerce-rate-limiter';
import { CommerceBuyers } from '../ports/context-gateways';
import { CouponRepository } from '../ports/coupon.repository';
import { OrderRepository } from '../ports/order.repository';
import { TransactionRunner } from '../ports/transaction-runner';

export interface CheckoutInput {
  readonly userId: string;
  /** The `Idempotency-Key` header (a UUID, checked by the controller). */
  readonly idempotencyKey: string;
  /** `CartQuote.totals.totalAmount` the buyer saw (only compared, never charged, §9). */
  readonly expectedTotal: string;
}

export interface CheckoutResult {
  readonly orderId: string;
  readonly status: OrderStatus;
  /** The hosted page (PENDING_PAYMENT with an OPEN session); a bearer capability. */
  readonly checkoutUrl: string | null;
}

/** What tx A decided. */
type TxAOutcome =
  | { readonly kind: 'answer'; readonly result: CheckoutResult }
  | { readonly kind: 'create'; readonly orderId: string }
  | { readonly kind: 'abandon'; readonly orderId: string };

/** Redemption failures that mean "the coupon changed since the quote" (schema doc §9). */
const COUPON_RACE_CONSTRAINTS: ReadonlySet<string> = new Set([
  'coupon_redemptions_limit_ck',
  'coupon_redemptions_coupon_valid_ck',
  'coupon_redemptions_coupon_id_user_id_active_uq',
]);

/**
 * `Checkout` (design §5, D6/D7/D14/D15/D17; schema doc §8.2, R1/R7):
 *
 * 1. rate limit (10 / 10 min), then a verified email (403 `email_not_verified`);
 * 2. **tx A** (READ COMMITTED): lock the cart; an order with this Idempotency-Key resumes
 *    (same `expectedTotal`, else 422 `idempotency_key_reused`); another PENDING_PAYMENT order
 *    is 409 `checkout_in_progress`; lock the cart's coupons (ascending id), re-quote, compare
 *    (`cart_empty` / `cart_changed` / `price_changed` / `amount_below_minimum`); insert the
 *    order, redemptions, lines, CREATING payment, first transition and `OrderPlaced`. A
 *    zero-total order is born PAID in the same transaction: grants, cart cleanup, `OrderPaid`;
 * 3. the provider call, outside any transaction (`checkout-session:{orderId}`, the stored
 *    `expires_at`); a failure is 503 `payment_provider_unavailable` and the order stays
 *    CREATING, so a retry with the same key resumes here;
 * 4. **tx B**: CREATING -> OPEN with the session id and url.
 *
 * Races decided by the database: two keys at once collide on `orders_user_id_pending_uq`
 * (409 `checkout_in_progress`); the same key twice serialises on the cart lock (the second
 * resumes; a key-unique collision retries once and resumes); a coupon that ran out, expired
 * or was used meanwhile fails its reservation (409 `price_changed` with the fresh quote).
 */
@Injectable()
export class CheckoutCommand {
  private readonly logger = new Logger(CheckoutCommand.name);

  constructor(
    private readonly tx: TransactionRunner,
    private readonly carts: CartRepository,
    private readonly coupons: CouponRepository,
    private readonly orders: OrderRepository,
    private readonly quotes: CartQuoteService,
    private readonly lifecycle: OrderLifecycle,
    private readonly sessions: CheckoutSessions,
    private readonly abandoner: CreatingPaymentAbandoner,
    private readonly events: CommerceEventPublisher,
    private readonly buyers: CommerceBuyers,
    private readonly limiter: CommerceRateLimiter,
    private readonly clock: CommerceClock,
    private readonly settings: CommerceSettings,
  ) {}

  async execute(input: CheckoutInput): Promise<CheckoutResult> {
    await this.limiter.hitCheckout(input.userId);
    const buyer = await this.buyers.findBuyer(input.userId);
    if (buyer?.emailVerified !== true) throw new CheckoutEmailNotVerified();
    const expected = this.parseExpected(input.expectedTotal);

    let outcome: TxAOutcome;
    try {
      outcome = await this.txA(input, expected);
    } catch (error) {
      // Same key twice at once: the loser saw no order, then hit the key unique; resume it.
      if (violatedConstraint(error) !== 'orders_user_id_idempotency_key_uq') throw error;
      outcome = await this.txA(input, expected);
    }

    switch (outcome.kind) {
      case 'answer':
        return outcome.result;
      case 'abandon':
        await this.abandoner.abandon(outcome.orderId, { kind: 'RECONCILER' }, { bestEffort: true });
        return this.currentState(outcome.orderId);
      case 'create':
        return this.createSession(outcome.orderId);
    }
  }

  private parseExpected(amount: string): Money {
    try {
      return Money.fromDecimal(amount, this.settings.currency);
    } catch (error) {
      throw new InvalidCommerceField([{ path: 'expectedTotal', message: 'Invalid amount.' }], {
        cause: error,
      });
    }
  }

  /** Tx A, with the checkout-specific constraint mapping (the runner's map is context-free). */
  private async txA(input: CheckoutInput, expected: Money): Promise<TxAOutcome> {
    try {
      return await this.tx.run((trx) => this.placeOrResume(trx, input, expected));
    } catch (error) {
      const constraint = violatedConstraint(error);
      if (constraint === 'orders_user_id_pending_uq') {
        const pending = await this.orders.findPendingCheckout(input.userId);
        if (pending !== null) {
          throw new CheckoutInProgress(pending.orderId, pending.checkoutUrl, { cause: error });
        }
        throw error;
      }
      if (constraint !== undefined && COUPON_RACE_CONSTRAINTS.has(constraint)) {
        throw new PriceChanged(await this.freshQuote(input.userId), { cause: error });
      }
      if (constraint === 'order_lines_order_id_course_id_uq') {
        this.logger.error(`checkout for ${input.userId}: duplicate order line (a bug)`);
        throw new CartChanged(await this.freshQuote(input.userId), { cause: error });
      }
      throw error;
    }
  }

  private async placeOrResume(
    trx: Transaction<DB>,
    input: CheckoutInput,
    expected: Money,
  ): Promise<TxAOutcome> {
    const { couponCode } = await this.carts.lockCart(trx, input.userId);

    const existing = await this.orders.findByIdempotencyKey(
      trx,
      input.userId,
      input.idempotencyKey,
    );
    if (existing !== null) {
      const now = await this.clock.now(trx);
      const decision = resumeDecision(existing, expected, now, PROVIDER_MIN_SESSION_LIFETIME_MIN);
      switch (decision.kind) {
        case 'reused':
          throw new IdempotencyKeyReused();
        case 'answer':
          return {
            kind: 'answer',
            result: {
              orderId: existing.orderId,
              status: decision.status,
              checkoutUrl: decision.checkoutUrl,
            },
          };
        case 'create':
          return { kind: 'create', orderId: existing.orderId };
        case 'abandon':
          return { kind: 'abandon', orderId: existing.orderId };
      }
    }

    const pending = await this.orders.findPendingCheckout(input.userId, trx);
    if (pending !== null) throw new CheckoutInProgress(pending.orderId, pending.checkoutUrl);

    const courseIds = await this.carts.listCourseIds(input.userId, trx);
    if (couponCode !== null && courseIds.length > 0) {
      await this.coupons.lockForCheckout(trx, couponCode, courseIds);
    }
    // READ COMMITTED: a fresh snapshot after the locks (R1).
    const { quote, view } = await this.quotes.price(input.userId, trx);
    this.assertOrderable(quote, view, expected);

    const placed = await this.orders.placeOrder(trx, {
      userId: input.userId,
      idempotencyKey: input.idempotencyKey,
      fingerprint: quote.fingerprint,
      currency: quote.currency,
      totalAmount: quote.totals.total.toDecimal(),
      lines: quote.lines.map((line) => ({
        courseId: line.course.id,
        instructorId: line.course.ownerId,
        courseTitle: line.course.title,
        listAmount: line.list.toDecimal(),
        discountAmount: line.discount.toDecimal(),
        couponId: line.couponId,
      })),
      revenueShareBps: this.settings.instructorShareBps,
      sessionTtlMinutes: this.settings.checkoutSessionTtlMinutes,
    });
    await this.events.orderPlaced(trx, {
      orderId: placed.orderId,
      orderNumber: placed.orderNumber,
      userId: input.userId,
      currency: quote.currency,
      totalAmount: quote.totals.total.toDecimal(),
      lineCount: placed.lines.length,
      placedAt: placed.placedAt.toISOString(),
    });

    if (placed.status === 'PENDING_PAYMENT') return { kind: 'create', orderId: placed.orderId };

    // D14 zero-total: PAID in this transaction (no provider), coupons born CONSUMED.
    if (placed.paidAt === null)
      throw new Error(`zero-total order ${placed.orderId} has no paid_at`);
    const finals = new Map(quote.lines.map((l) => [l.course.id, l.final.toDecimal()]));
    await this.lifecycle.settlePaid(trx, {
      orderId: placed.orderId,
      userId: input.userId,
      provider: 'NONE',
      paidAt: placed.paidAt,
      lines: placed.lines.map((l) => ({
        id: l.id,
        courseId: l.courseId,
        finalAmount: finals.get(l.courseId) ?? '0.00',
      })),
    });
    return {
      kind: 'answer',
      result: { orderId: placed.orderId, status: 'PAID', checkoutUrl: null },
    };
  }

  private assertOrderable(quote: Quote, view: CartQuote, expected: Money): void {
    switch (checkoutBlock(quote, expected)) {
      case null:
        return;
      case ErrorCode.CartEmpty:
        throw new CartEmpty();
      case ErrorCode.CartChanged:
        throw new CartChanged(view);
      case ErrorCode.PriceChanged:
        throw new PriceChanged(view);
      case ErrorCode.AmountBelowMinimum:
        throw new AmountBelowMinimum();
    }
  }

  private async freshQuote(userId: string): Promise<CartQuote> {
    return (await this.tx.run((trx) => this.quotes.price(userId, trx))).view;
  }

  /** Step 3 + tx B. */
  private async createSession(orderId: string): Promise<CheckoutResult> {
    const snapshot = await this.orders.findCheckoutSnapshot(orderId);
    if (
      snapshot === null ||
      snapshot.status !== 'PENDING_PAYMENT' ||
      snapshot.paymentStatus !== 'CREATING'
    ) {
      return this.currentState(orderId);
    }
    let session: { sessionId: string; url: string };
    try {
      session = await this.sessions.create(snapshot);
    } catch (error) {
      if (error instanceof PaymentProviderUnavailableError) {
        this.logger.warn(
          `order ${orderId}: payment provider unavailable; the order stays CREATING`,
        );
        throw new PaymentProviderUnavailable({ cause: error });
      }
      if (error instanceof PaymentProviderError || error instanceof CheckoutSessionRejected) {
        // A provider refusal or a disallowed url is a configuration/integration bug; the
        // reconciler abandons the order. The client sees a retryable outage.
        this.logger.error(
          { err: error },
          `order ${orderId}: the payment provider did not give a usable session`,
        );
        throw new PaymentProviderUnavailable({ cause: error });
      }
      throw error;
    }
    const opened = await this.tx.run((trx) =>
      this.orders.openPayment(trx, orderId, { sessionId: session.sessionId, url: session.url }),
    );
    if (!opened) return this.currentState(orderId);
    return { orderId, status: 'PENDING_PAYMENT', checkoutUrl: session.url };
  }

  private async currentState(orderId: string): Promise<CheckoutResult> {
    const snapshot = await this.orders.findCheckoutSnapshot(orderId);
    if (snapshot === null) throw new Error(`order ${orderId} vanished`);
    const open = snapshot.status === 'PENDING_PAYMENT' && snapshot.paymentStatus === 'OPEN';
    return {
      orderId,
      status: snapshot.status,
      checkoutUrl: open ? snapshot.checkoutUrl : null,
    };
  }
}

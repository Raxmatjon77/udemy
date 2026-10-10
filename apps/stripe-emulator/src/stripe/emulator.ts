import type { FormObject } from '../http/form';
import { invalidRequest, resourceMissing } from '../http/stripe-error';
import type { EventRequestContext, WebhookDispatcher } from '../webhooks/dispatcher';
import { NO_REQUEST } from '../webhooks/dispatcher';
import type { Clock } from './ids';
import { stripeId, unixSeconds } from './ids';
import { ParamReader } from './params';

/**
 * The in-memory Stripe state machine behind the HTTP layer: Checkout Sessions (payment mode,
 * inline `price_data` lines, cards only), their payment intents/charges, and refunds. Every state
 * change emits the webhook event Stripe would send through the `WebhookDispatcher`.
 *
 * Validation mirrors the exact parameters `buildCheckoutSessionParams` / `buildRefundParams` send
 * at API `2026-09-30.endive`; anything else is rejected like Stripe rejects unknown parameters.
 */

export type SessionStatus = 'open' | 'complete' | 'expired';
export type SessionPaymentStatus = 'unpaid' | 'paid' | 'no_payment_required';
export type RefundStatus = 'pending' | 'succeeded' | 'failed';
export type RefundReason = 'duplicate' | 'fraudulent' | 'requested_by_customer';

export interface LineItem {
  readonly name: string;
  readonly unitAmount: number;
  readonly quantity: number;
  readonly amountTotal: number;
}

export interface SessionRecord {
  readonly id: string;
  readonly created: number;
  readonly expiresAt: number;
  status: SessionStatus;
  paymentStatus: SessionPaymentStatus;
  readonly currency: string;
  readonly amountTotal: number;
  readonly lineItems: readonly LineItem[];
  readonly clientReferenceId: string | null;
  readonly customerEmail: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly paymentIntentMetadata: Readonly<Record<string, string>>;
  readonly successUrl: string;
  readonly cancelUrl: string | null;
  paymentIntentId: string | null;
  /** The last "Decline" on the hosted page (the session stays open). */
  lastDeclineMessage: string | null;
}

export interface PaymentIntentRecord {
  readonly id: string;
  readonly chargeId: string;
  readonly sessionId: string;
  readonly amount: number;
  readonly currency: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly created: number;
}

export interface RefundRecord {
  readonly id: string;
  readonly paymentIntentId: string;
  readonly chargeId: string;
  readonly amount: number;
  readonly currency: string;
  status: RefundStatus;
  readonly reason: RefundReason | null;
  readonly metadata: Readonly<Record<string, string>>;
  failureReason: string | null;
  readonly created: number;
}

/**
 * What the next `POST /v1/refunds` does (control API):
 * - `succeeded` (default): succeeds synchronously; `charge.refunded` + `refund.updated`.
 * - `failed`: returned `pending`, then fails right after; `refund.failed` (`failure_reason`).
 * - `pending`: stays `pending` until `/_emulator/refunds/:id/settle`.
 */
export type RefundOutcome = 'succeeded' | 'failed' | 'pending';

export interface RefundPlan {
  readonly outcome: RefundOutcome;
  readonly failureReason: string;
}

export const DEFAULT_REFUND_FAILURE_REASON = 'expired_or_canceled_card';
export const REFUND_FAILURE_REASONS = [
  'charge_for_pending_refund_disputed',
  'declined',
  'expired_or_canceled_card',
  'insufficient_funds',
  'lost_or_stolen_card',
  'merchant_request',
  'unknown',
] as const;

/** A state conflict reported by the hosted page / control API (not a Stripe API error). */
export class EmulatorConflictError extends Error {
  constructor(
    readonly status: 404 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'EmulatorConflictError';
  }
}

const SESSION_MIN_LIFETIME_S = 30 * 60;
const SESSION_MAX_LIFETIME_S = 24 * 60 * 60;
/** Tolerated clock skew between the caller and the emulator for the `expires_at` window. */
const EXPIRES_AT_SKEW_S = 5;
const MIN_CHARGE_MINOR = 50;
const MAX_AMOUNT_MINOR = 99_999_999;
const MAX_LINE_ITEMS = 100;
const REFUND_REASONS: readonly RefundReason[] = [
  'duplicate',
  'fraudulent',
  'requested_by_customer',
];

export interface StripeEmulatorOptions {
  readonly clock: Clock;
  readonly webhooks: WebhookDispatcher;
  /** `${publicUrl}/pay/{id}`; a function because an in-process server learns its port late. */
  readonly payUrl: (sessionId: string) => string;
}

export class StripeEmulator {
  private readonly sessions = new Map<string, SessionRecord>();
  private readonly paymentIntents = new Map<string, PaymentIntentRecord>();
  private readonly refunds = new Map<string, RefundRecord>();
  private readonly refundPlans: RefundPlan[] = [];

  constructor(private readonly options: StripeEmulatorOptions) {}

  private now(): number {
    return unixSeconds(this.options.clock());
  }

  // ------------------------------------------------------------------ Checkout Sessions

  createCheckoutSession(params: FormObject): Record<string, unknown> {
    this.expireDueSessions();
    const created = this.now();
    const p = new ParamReader(params);
    if (p.has('payment_method_types')) {
      throw invalidRequest(
        'Received unknown parameter: payment_method_types. API version 2026-09-30.endive removed ' +
          'it from Checkout Session create; use allowed_payment_method_types.',
        'parameter_unknown',
        'payment_method_types',
      );
    }
    p.enumValue('mode', ['payment'], true);
    const methods = p.stringList('allowed_payment_method_types', true) ?? [];
    if (methods.length === 0) {
      throw invalidRequest(
        'allowed_payment_method_types must not be empty.',
        'parameter_invalid_empty',
        'allowed_payment_method_types',
      );
    }
    methods.forEach((method, index) => {
      if (method !== 'card') {
        throw invalidRequest(
          `The payment method type "${method}" is not supported by the Stripe emulator (card only).`,
          'payment_method_unactivated',
          `allowed_payment_method_types[${index}]`,
        );
      }
    });
    const clientReferenceId = p.string('client_reference_id', { maxLength: 200 }) ?? null;
    const customerEmail = p.string('customer_email', { maxLength: 800 }) ?? null;
    if (customerEmail !== null && !/^[^@\s]+@[^@\s]+$/.test(customerEmail)) {
      throw invalidRequest(
        'Invalid email address: ' + customerEmail,
        'email_invalid',
        'customer_email',
      );
    }
    const metadata = p.metadata('metadata') ?? {};
    const intentData = p.object('payment_intent_data');
    const paymentIntentMetadata = intentData?.metadata('metadata') ?? {};
    intentData?.finish();
    const successUrl = p.url('success_url', true) ?? '';
    const cancelUrl = p.url('cancel_url', false) ?? null;
    const expiresAt = p.integer('expires_at') ?? created + SESSION_MAX_LIFETIME_S;
    if (
      expiresAt < created + SESSION_MIN_LIFETIME_S - EXPIRES_AT_SKEW_S ||
      expiresAt > created + SESSION_MAX_LIFETIME_S + EXPIRES_AT_SKEW_S
    ) {
      throw invalidRequest(
        'The `expires_at` timestamp must be between 30 minutes and 24 hours from Checkout Session ' +
          'creation.',
        undefined,
        'expires_at',
      );
    }

    const lineReaders = p.objectList('line_items', true) ?? [];
    if (lineReaders.length === 0 || lineReaders.length > MAX_LINE_ITEMS) {
      throw invalidRequest(
        `line_items must contain between 1 and ${MAX_LINE_ITEMS} items.`,
        undefined,
        'line_items',
      );
    }
    let currency: string | null = null;
    const lineItems = lineReaders.map((line): LineItem => {
      const quantity = line.integer('quantity', { required: true, min: 1, max: 999_999 });
      const price = line.object('price_data', true);
      const lineCurrency = price.string('currency', { required: true }).toLowerCase();
      if (!/^[a-z]{3}$/.test(lineCurrency)) {
        throw invalidRequest(
          `Invalid currency: ${lineCurrency}`,
          undefined,
          `${price.path}[currency]`,
        );
      }
      if (currency !== null && currency !== lineCurrency) {
        throw invalidRequest(
          'All line_items must use the same currency.',
          undefined,
          `${price.path}[currency]`,
        );
      }
      currency = lineCurrency;
      const unitAmount = price.integer('unit_amount', {
        required: true,
        min: 0,
        max: MAX_AMOUNT_MINOR,
      });
      const product = price.object('product_data', true);
      const name = product.string('name', { required: true, maxLength: 250 });
      product.finish();
      price.finish();
      line.finish();
      return { name, unitAmount, quantity, amountTotal: unitAmount * quantity };
    });
    p.finish();

    const amountTotal = lineItems.reduce((sum, line) => sum + line.amountTotal, 0);
    if (amountTotal > 0 && amountTotal < MIN_CHARGE_MINOR) {
      throw invalidRequest(
        "The Checkout Session's total amount due must add up to at least $0.50 usd",
        'amount_too_small',
        'line_items',
      );
    }
    if (amountTotal > MAX_AMOUNT_MINOR) {
      throw invalidRequest('The total amount is too large.', 'amount_too_large', 'line_items');
    }

    const session: SessionRecord = {
      id: stripeId('cs_test', 58),
      created,
      expiresAt,
      status: 'open',
      paymentStatus: 'unpaid',
      currency: currency ?? 'usd',
      amountTotal,
      lineItems,
      clientReferenceId,
      customerEmail,
      metadata,
      paymentIntentMetadata,
      successUrl,
      cancelUrl,
      paymentIntentId: null,
      lastDeclineMessage: null,
    };
    this.sessions.set(session.id, session);
    return this.sessionJson(session);
  }

  retrieveCheckoutSession(id: string): Record<string, unknown> {
    this.expireDueSessions();
    return this.sessionJson(this.requireSession(id));
  }

  /** `POST /v1/checkout/sessions/:id/expire`: only open sessions (Stripe answers 400 otherwise). */
  expireCheckoutSession(id: string, request: EventRequestContext): Record<string, unknown> {
    this.expireDueSessions();
    const session = this.requireSession(id);
    if (session.status !== 'open') {
      throw invalidRequest(
        `Only Checkout Sessions with a status in ["open"] can be expired. This Checkout Session ` +
          `has a status of "${session.status}".`,
      );
    }
    this.expire(session, request);
    return this.sessionJson(session);
  }

  /** The record behind a hosted page / control call; undefined when unknown. */
  findSession(id: string): SessionRecord | undefined {
    this.expireDueSessions();
    return this.sessions.get(id);
  }

  /** Pay: the session becomes complete + paid with a fake payment intent and charge. */
  completeSession(id: string): SessionRecord {
    this.expireDueSessions();
    const session = this.sessions.get(id);
    if (session === undefined)
      throw new EmulatorConflictError(404, `No such checkout session: ${id}`);
    if (session.status !== 'open') {
      throw new EmulatorConflictError(409, `Checkout Session ${id} is ${session.status}, not open`);
    }
    session.status = 'complete';
    session.lastDeclineMessage = null;
    if (session.amountTotal === 0) {
      session.paymentStatus = 'no_payment_required';
    } else {
      session.paymentStatus = 'paid';
      const intent: PaymentIntentRecord = {
        id: stripeId('pi', 24),
        chargeId: stripeId('ch', 24),
        sessionId: session.id,
        amount: session.amountTotal,
        currency: session.currency,
        metadata: session.paymentIntentMetadata,
        created: this.now(),
      };
      this.paymentIntents.set(intent.id, intent);
      session.paymentIntentId = intent.id;
    }
    this.options.webhooks.emit('checkout.session.completed', this.sessionJson(session), NO_REQUEST);
    return session;
  }

  /** Decline: the card is "declined", the session stays open, no event (as on Stripe). */
  declineSession(id: string): SessionRecord {
    this.expireDueSessions();
    const session = this.sessions.get(id);
    if (session === undefined)
      throw new EmulatorConflictError(404, `No such checkout session: ${id}`);
    if (session.status !== 'open') {
      throw new EmulatorConflictError(409, `Checkout Session ${id} is ${session.status}, not open`);
    }
    session.lastDeclineMessage = 'Your card was declined. Try again or use a different card.';
    return session;
  }

  /** Control API "expire now": like the API call, but a non-open session is a 409. */
  expireSessionNow(id: string): SessionRecord {
    this.expireDueSessions();
    const session = this.sessions.get(id);
    if (session === undefined)
      throw new EmulatorConflictError(404, `No such checkout session: ${id}`);
    if (session.status !== 'open') {
      throw new EmulatorConflictError(409, `Checkout Session ${id} is ${session.status}, not open`);
    }
    this.expire(session, NO_REQUEST);
    return session;
  }

  /** Stripe expires open sessions at `expires_at`; run on every request and on a timer. */
  expireDueSessions(): number {
    const now = this.now();
    let count = 0;
    for (const session of this.sessions.values()) {
      if (session.status === 'open' && session.expiresAt <= now) {
        this.expire(session, NO_REQUEST);
        count += 1;
      }
    }
    return count;
  }

  private expire(session: SessionRecord, request: EventRequestContext): void {
    session.status = 'expired';
    this.options.webhooks.emit('checkout.session.expired', this.sessionJson(session), request);
  }

  private requireSession(id: string): SessionRecord {
    const session = this.sessions.get(id);
    if (session === undefined) throw resourceMissing('checkout.session', id);
    return session;
  }

  sessionJson(session: SessionRecord): Record<string, unknown> {
    return {
      id: session.id,
      object: 'checkout.session',
      allow_promotion_codes: null,
      amount_subtotal: session.amountTotal,
      amount_total: session.amountTotal,
      cancel_url: session.cancelUrl,
      client_reference_id: session.clientReferenceId,
      created: session.created,
      currency: session.currency,
      customer: null,
      customer_details:
        session.status === 'complete'
          ? { email: session.customerEmail ?? 'buyer@example.test', name: null }
          : null,
      customer_email: session.customerEmail,
      expires_at: session.expiresAt,
      livemode: false,
      metadata: { ...session.metadata },
      mode: 'payment',
      payment_intent: session.paymentIntentId,
      payment_status: session.paymentStatus,
      status: session.status,
      success_url: session.successUrl,
      ui_mode: 'hosted',
      // Stripe only returns the hosted URL while the session is open.
      url: session.status === 'open' ? this.options.payUrl(session.id) : null,
    };
  }

  /** The success_url Stripe redirects to, with `{CHECKOUT_SESSION_ID}` substituted. */
  successRedirect(session: SessionRecord): string {
    return session.successUrl.split('{CHECKOUT_SESSION_ID}').join(session.id);
  }

  // ------------------------------------------------------------------ Refunds

  createRefund(params: FormObject, request: EventRequestContext): Record<string, unknown> {
    const p = new ParamReader(params);
    const paymentIntentId = p.string('payment_intent', { required: true });
    const amount = p.integer('amount', { min: 1 });
    const reason = p.enumValue('reason', REFUND_REASONS) ?? null;
    const metadata = p.metadata('metadata') ?? {};
    p.finish();

    const intent = this.paymentIntents.get(paymentIntentId);
    if (intent === undefined)
      throw resourceMissing('payment_intent', paymentIntentId, 'payment_intent');
    const remaining = intent.amount - this.committedRefundAmount(intent.id);
    if (remaining <= 0) {
      throw invalidRequest(
        `Charge ${intent.chargeId} has already been refunded.`,
        'charge_already_refunded',
      );
    }
    const refundAmount = amount ?? remaining;
    if (refundAmount > remaining) {
      throw invalidRequest(
        `Refund amount (${refundAmount}) is greater than unrefunded amount on charge (${remaining})`,
        'amount_too_large',
        'amount',
      );
    }
    const plan = this.refundPlans.shift() ?? {
      outcome: 'succeeded',
      failureReason: DEFAULT_REFUND_FAILURE_REASON,
    };
    const refund: RefundRecord = {
      id: stripeId('re', 24),
      paymentIntentId: intent.id,
      chargeId: intent.chargeId,
      amount: refundAmount,
      currency: intent.currency,
      status: plan.outcome === 'succeeded' ? 'succeeded' : 'pending',
      reason,
      metadata,
      failureReason: null,
      created: this.now(),
    };
    this.refunds.set(refund.id, refund);
    // The response is the state at creation time; a planned failure happens right after.
    const response = this.refundJson(refund);
    if (plan.outcome === 'succeeded') this.emitRefundSucceeded(refund, request);
    if (plan.outcome === 'failed') this.failRefund(refund, plan.failureReason, NO_REQUEST);
    return response;
  }

  retrieveRefund(id: string): Record<string, unknown> {
    const refund = this.refunds.get(id);
    if (refund === undefined) throw resourceMissing('refund', id);
    return this.refundJson(refund);
  }

  /** Queues the behaviour of the next refund(s), FIFO. */
  planRefunds(plan: RefundPlan, count: number): number {
    for (let index = 0; index < count; index += 1) this.refundPlans.push(plan);
    return this.refundPlans.length;
  }

  pendingRefundPlans(): readonly RefundPlan[] {
    return [...this.refundPlans];
  }

  /** Control API: settle a `pending` refund. */
  settleRefund(id: string, outcome: 'succeeded' | 'failed', failureReason: string): RefundRecord {
    const refund = this.refunds.get(id);
    if (refund === undefined) throw new EmulatorConflictError(404, `No such refund: ${id}`);
    if (refund.status !== 'pending') {
      throw new EmulatorConflictError(409, `Refund ${id} is ${refund.status}, not pending`);
    }
    if (outcome === 'succeeded') {
      refund.status = 'succeeded';
      this.emitRefundSucceeded(refund, NO_REQUEST);
    } else {
      this.failRefund(refund, failureReason, NO_REQUEST);
    }
    return refund;
  }

  private failRefund(
    refund: RefundRecord,
    failureReason: string,
    request: EventRequestContext,
  ): void {
    refund.status = 'failed';
    refund.failureReason = failureReason;
    this.options.webhooks.emit('refund.failed', this.refundJson(refund), request);
  }

  private emitRefundSucceeded(refund: RefundRecord, request: EventRequestContext): void {
    const intent = this.paymentIntents.get(refund.paymentIntentId);
    if (intent !== undefined) {
      this.options.webhooks.emit('charge.refunded', this.chargeJson(intent), request);
    }
    this.options.webhooks.emit('refund.updated', this.refundJson(refund), request);
  }

  /** Succeeded + pending refunds hold amount; failed ones release it. */
  private committedRefundAmount(paymentIntentId: string): number {
    let sum = 0;
    for (const refund of this.refunds.values()) {
      if (refund.paymentIntentId === paymentIntentId && refund.status !== 'failed') {
        sum += refund.amount;
      }
    }
    return sum;
  }

  private refundedAmount(paymentIntentId: string): number {
    let sum = 0;
    for (const refund of this.refunds.values()) {
      if (refund.paymentIntentId === paymentIntentId && refund.status === 'succeeded') {
        sum += refund.amount;
      }
    }
    return sum;
  }

  refundJson(refund: RefundRecord): Record<string, unknown> {
    return {
      id: refund.id,
      object: 'refund',
      amount: refund.amount,
      balance_transaction: null,
      charge: refund.chargeId,
      created: refund.created,
      currency: refund.currency,
      ...(refund.status === 'failed' ? { failure_reason: refund.failureReason } : {}),
      metadata: { ...refund.metadata },
      payment_intent: refund.paymentIntentId,
      reason: refund.reason,
      receipt_number: null,
      source_transfer_reversal: null,
      status: refund.status,
      transfer_reversal: null,
    };
  }

  /** `charge.refunded` data: charge-level totals only (no embedded refunds since 2022-11-15). */
  chargeJson(intent: PaymentIntentRecord): Record<string, unknown> {
    const amountRefunded = this.refundedAmount(intent.id);
    return {
      id: intent.chargeId,
      object: 'charge',
      amount: intent.amount,
      amount_captured: intent.amount,
      amount_refunded: amountRefunded,
      captured: true,
      created: intent.created,
      currency: intent.currency,
      livemode: false,
      metadata: { ...intent.metadata },
      paid: true,
      payment_intent: intent.id,
      refunded: amountRefunded >= intent.amount,
      status: 'succeeded',
    };
  }

  // ------------------------------------------------------------------ Disputes (control only)

  /** Opens a dispute on a paid intent: `charge.dispute.created`. */
  createDispute(paymentIntentId: string, reason: string): Record<string, unknown> {
    const intent = this.paymentIntents.get(paymentIntentId);
    if (intent === undefined) {
      throw new EmulatorConflictError(404, `No such payment_intent: ${paymentIntentId}`);
    }
    const dispute = {
      id: stripeId('dp', 24),
      object: 'dispute',
      amount: intent.amount,
      charge: intent.chargeId,
      created: this.now(),
      currency: intent.currency,
      livemode: false,
      payment_intent: intent.id,
      reason,
      status: 'needs_response',
    };
    this.options.webhooks.emit('charge.dispute.created', dispute, NO_REQUEST);
    return dispute;
  }

  // ------------------------------------------------------------------ Introspection

  snapshot(): {
    sessions: Record<string, unknown>[];
    paymentIntents: PaymentIntentRecord[];
    refunds: Record<string, unknown>[];
    refundPlans: RefundPlan[];
  } {
    return {
      sessions: [...this.sessions.values()].map((session) => ({
        ...this.sessionJson(session),
        line_items: session.lineItems,
        last_decline_message: session.lastDeclineMessage,
      })),
      paymentIntents: [...this.paymentIntents.values()],
      refunds: [...this.refunds.values()].map((refund) => this.refundJson(refund)),
      refundPlans: [...this.refundPlans],
    };
  }

  reset(): void {
    this.sessions.clear();
    this.paymentIntents.clear();
    this.refunds.clear();
    this.refundPlans.length = 0;
  }
}

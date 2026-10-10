import { CART_LIMITS, type Currency, DEFAULT_CURRENCY } from '@udemy/contracts';

/** Stripe requires `expires_at` >= 30 min ahead on a fresh create (schema doc §6 item 6). */
export const PROVIDER_MIN_SESSION_LIFETIME_MIN = 30;

export interface CommerceSettingsProps {
  /** `COMMERCE_CURRENCY`: the single platform currency (§13 Q4: USD). */
  readonly currency: Currency;
  /** `COMMERCE_CART_MAX_ITEMS` (D4: 20). */
  readonly cartMaxItems: number;
  /** `COMMERCE_INSTRUCTOR_SHARE_BPS` (Q2: 7000), snapshotted on every order line. */
  readonly instructorShareBps: number;
  /** `COMMERCE_CHECKOUT_SESSION_TTL_MIN` (>= 35). */
  readonly checkoutSessionTtlMinutes: number;
  /** `COMMERCE_REFUND_WINDOW_DAYS` (Q3: 30). */
  readonly refundWindowDays: number;
  /** `STUDENT_APP_ORIGIN`: where Checkout sends the buyer back. */
  readonly studentAppOrigin: string;
  /** Origins a provider Checkout URL may have (`CHECKOUT_ALLOWED_ORIGINS`). */
  readonly allowedCheckoutOrigins: readonly string[];
  /** `STRIPE_WEBHOOK_SECRET` (`whsec_…`). */
  readonly webhookSecret: string;
  /** `STRIPE_WEBHOOK_TOLERANCE_S` (300). */
  readonly webhookToleranceSeconds: number;
  /** `COMMERCE_JOBS_ENABLED`. */
  readonly jobsEnabled: boolean;
  /** `COMMERCE_RECONCILE_INTERVAL_MS` (5 min). */
  readonly reconcileIntervalMs: number;
  /** `COMMERCE_REFUND_DISPATCH_INTERVAL_MS` (P4-T16). */
  readonly refundDispatchIntervalMs: number;
}

/** The env subset `CommerceSettings.fromEnv` reads (already validated by `apiEnvSchema`). */
export interface CommerceEnv {
  readonly COMMERCE_CURRENCY: Currency;
  readonly COMMERCE_CART_MAX_ITEMS: number;
  readonly COMMERCE_INSTRUCTOR_SHARE_BPS: number;
  readonly COMMERCE_CHECKOUT_SESSION_TTL_MIN: number;
  readonly COMMERCE_REFUND_WINDOW_DAYS: number;
  readonly COMMERCE_JOBS_ENABLED: boolean;
  readonly COMMERCE_RECONCILE_INTERVAL_MS: number;
  readonly COMMERCE_REFUND_DISPATCH_INTERVAL_MS: number;
  readonly STUDENT_APP_ORIGIN: string;
  readonly CHECKOUT_ALLOWED_ORIGINS?: readonly string[] | undefined;
  readonly STRIPE_API_BASE_URL?: string | undefined;
  readonly STRIPE_WEBHOOK_SECRET: string;
  readonly STRIPE_WEBHOOK_TOLERANCE_S: number;
}

/** Real Stripe's hosted Checkout origin. */
export const STRIPE_CHECKOUT_ORIGIN = 'https://checkout.stripe.com';

function originOf(value: string): string {
  return new URL(value).origin;
}

/**
 * Commerce configuration, bound from the validated `COMMERCE_*` / `STRIPE_*` env
 * (`CommerceSettings.fromEnv`). `defaults()` is for unit tests.
 */
export class CommerceSettings {
  readonly currency: Currency;
  readonly cartMaxItems: number;
  readonly instructorShareBps: number;
  readonly checkoutSessionTtlMinutes: number;
  readonly refundWindowDays: number;
  readonly studentAppOrigin: string;
  readonly allowedCheckoutOrigins: readonly string[];
  readonly webhookSecret: string;
  readonly webhookToleranceSeconds: number;
  readonly jobsEnabled: boolean;
  readonly reconcileIntervalMs: number;
  readonly refundDispatchIntervalMs: number;

  constructor(props: CommerceSettingsProps) {
    if (!Number.isSafeInteger(props.cartMaxItems) || props.cartMaxItems < 1) {
      throw new RangeError('cartMaxItems must be a positive integer');
    }
    if (props.cartMaxItems > CART_LIMITS.maxItems) {
      // CartQuoteSchema caps lines at CART_LIMITS.maxItems; a bigger cart breaks the contract.
      throw new RangeError(`cartMaxItems must be at most ${CART_LIMITS.maxItems}`);
    }
    if (
      !Number.isSafeInteger(props.instructorShareBps) ||
      props.instructorShareBps < 0 ||
      props.instructorShareBps > 10_000
    ) {
      throw new RangeError('instructorShareBps must be an integer in 0..10000');
    }
    if (
      !Number.isSafeInteger(props.checkoutSessionTtlMinutes) ||
      props.checkoutSessionTtlMinutes < PROVIDER_MIN_SESSION_LIFETIME_MIN + 5 ||
      props.checkoutSessionTtlMinutes > 1440
    ) {
      throw new RangeError('checkoutSessionTtlMinutes must be an integer in 35..1440');
    }
    if (!Number.isSafeInteger(props.refundWindowDays) || props.refundWindowDays < 1) {
      throw new RangeError('refundWindowDays must be a positive integer');
    }
    if (props.allowedCheckoutOrigins.length === 0) {
      throw new RangeError('allowedCheckoutOrigins must not be empty');
    }
    this.currency = props.currency;
    this.cartMaxItems = props.cartMaxItems;
    this.instructorShareBps = props.instructorShareBps;
    this.checkoutSessionTtlMinutes = props.checkoutSessionTtlMinutes;
    this.refundWindowDays = props.refundWindowDays;
    this.studentAppOrigin = originOf(props.studentAppOrigin);
    this.allowedCheckoutOrigins = Object.freeze(props.allowedCheckoutOrigins.map(originOf));
    this.webhookSecret = props.webhookSecret;
    this.webhookToleranceSeconds = props.webhookToleranceSeconds;
    this.jobsEnabled = props.jobsEnabled;
    this.reconcileIntervalMs = props.reconcileIntervalMs;
    this.refundDispatchIntervalMs = props.refundDispatchIntervalMs;
  }

  static fromEnv(env: CommerceEnv): CommerceSettings {
    const allowed =
      env.CHECKOUT_ALLOWED_ORIGINS !== undefined && env.CHECKOUT_ALLOWED_ORIGINS.length > 0
        ? env.CHECKOUT_ALLOWED_ORIGINS
        : [env.STRIPE_API_BASE_URL ?? STRIPE_CHECKOUT_ORIGIN];
    return new CommerceSettings({
      currency: env.COMMERCE_CURRENCY,
      cartMaxItems: env.COMMERCE_CART_MAX_ITEMS,
      instructorShareBps: env.COMMERCE_INSTRUCTOR_SHARE_BPS,
      checkoutSessionTtlMinutes: env.COMMERCE_CHECKOUT_SESSION_TTL_MIN,
      refundWindowDays: env.COMMERCE_REFUND_WINDOW_DAYS,
      studentAppOrigin: env.STUDENT_APP_ORIGIN,
      allowedCheckoutOrigins: allowed,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      webhookToleranceSeconds: env.STRIPE_WEBHOOK_TOLERANCE_S,
      jobsEnabled: env.COMMERCE_JOBS_ENABLED,
      reconcileIntervalMs: env.COMMERCE_RECONCILE_INTERVAL_MS,
      refundDispatchIntervalMs: env.COMMERCE_REFUND_DISPATCH_INTERVAL_MS,
    });
  }

  /** Contract defaults (unit tests). */
  static defaults(overrides: Partial<CommerceSettingsProps> = {}): CommerceSettings {
    return new CommerceSettings({
      currency: DEFAULT_CURRENCY,
      cartMaxItems: CART_LIMITS.maxItems,
      instructorShareBps: 7000,
      checkoutSessionTtlMinutes: 35,
      refundWindowDays: 30,
      studentAppOrigin: 'http://localhost:3000',
      allowedCheckoutOrigins: [STRIPE_CHECKOUT_ORIGIN],
      webhookSecret: 'whsec_unit_tests_only_000000',
      webhookToleranceSeconds: 300,
      jobsEnabled: false,
      reconcileIntervalMs: 300_000,
      refundDispatchIntervalMs: 60_000,
      ...overrides,
    });
  }

  /** Where Stripe sends the buyer after paying (the success page polls the order). */
  checkoutSuccessUrl(orderId: string): string {
    return `${this.studentAppOrigin}/checkout/success?orderId=${encodeURIComponent(orderId)}`;
  }

  /** Where the hosted page's "back" link goes (the cancel page cancels the order). */
  checkoutCancelUrl(orderId: string): string {
    return `${this.studentAppOrigin}/checkout/cancel?orderId=${encodeURIComponent(orderId)}`;
  }

  /** True when a provider Checkout URL may be handed to the browser. */
  isAllowedCheckoutUrl(url: string): boolean {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return false;
    }
    return (
      (parsed.protocol === 'https:' || parsed.protocol === 'http:') &&
      this.allowedCheckoutOrigins.includes(parsed.origin)
    );
  }
}

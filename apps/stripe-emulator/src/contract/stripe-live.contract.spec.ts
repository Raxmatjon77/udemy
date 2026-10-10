import { createStripeClient } from '@udemy/payments';
import { definePaymentProviderContract } from './payment-provider-contract';

/**
 * The shared contract suite against REAL Stripe in TEST mode (design §13 Q6: "optional live
 * workflow when a secret exists"). Run by `.github/workflows/stripe-live.yml` (manual dispatch)
 * with the repository secret STRIPE_TEST_SECRET_KEY as IT_STRIPE_LIVE_SECRET_KEY; skipped
 * everywhere else, so normal CI never needs a Stripe account.
 *
 * Only the stateless cases run (`stateful: false`): the stateful ones need the emulator's
 * control API (pay a session without a browser, plan a refund failure). The two refund cases get
 * a really paid test-mode PaymentIntent (`pm_card_visa`, confirmed server-side).
 *
 * Anything but an `sk_test_` key is refused before a single request is made.
 */
const STRIPE_API_BASE_URL = 'https://api.stripe.com';
const secretKey = process.env.IT_STRIPE_LIVE_SECRET_KEY?.trim() ?? '';

if (secretKey !== '' && !/^sk_test_[A-Za-z0-9_]+$/.test(secretKey)) {
  throw new Error('IT_STRIPE_LIVE_SECRET_KEY must be a Stripe TEST secret key (sk_test_…)');
}

const unavailable: string | undefined =
  secretKey === ''
    ? 'IT_STRIPE_LIVE_SECRET_KEY is not set (the live Stripe contract run is manual and optional)'
    : undefined;

definePaymentProviderContract({
  name: 'stripe (test mode)',
  stateful: false,
  secretKey,
  baseUrl: () => STRIPE_API_BASE_URL,
  skipIfUnavailable: (ctx) => ctx.skip(unavailable !== undefined, unavailable),
  paidPaymentIntent: async (amountMinor) => {
    const stripe = createStripeClient({
      secretKey,
      apiBaseUrl: STRIPE_API_BASE_URL,
      maxNetworkRetries: 1,
    });
    const intent = await stripe.paymentIntents.create({
      amount: amountMinor,
      currency: 'usd',
      payment_method: 'pm_card_visa',
      confirm: true,
      automatic_payment_methods: { enabled: true, allow_redirects: 'never' },
      metadata: { source: 'udemy-stripe-live-contract' },
    });
    if (intent.status !== 'succeeded') {
      throw new Error(`test PaymentIntent ${intent.id} is ${intent.status}, expected succeeded`);
    }
    return intent.id;
  },
});

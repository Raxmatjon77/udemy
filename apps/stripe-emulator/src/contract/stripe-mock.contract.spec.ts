import { beforeAll } from 'vitest';
import { definePaymentProviderContract } from './payment-provider-contract';

/**
 * The same contract suite against stripe-mock (OpenAPI-validated, stateless), so the emulator
 * and Stripe's own spec agree on which request shapes are accepted. Only the stateless cases run.
 *
 * Optional: runs when `IT_STRIPE_MOCK_URL` points at stripe-mock (CI: the service on 12211),
 * skips otherwise. When the variable IS set, an unreachable server or one that is not
 * stripe-mock (no `Stripe-Mock-Version` header, e.g. this emulator) fails instead of skipping.
 */
const STRIPE_MOCK_API_KEY = 'sk_test_123';
const configured = process.env.IT_STRIPE_MOCK_URL?.trim().replace(/\/+$/, '') ?? '';
const unavailable: string | undefined =
  configured === ''
    ? 'IT_STRIPE_MOCK_URL is not set (stripe-mock contract run is optional)'
    : undefined;

beforeAll(async () => {
  if (unavailable !== undefined) return;
  const response = await fetch(`${configured}/v1/refunds/re_probe`, {
    headers: { authorization: `Bearer ${STRIPE_MOCK_API_KEY}` },
    signal: AbortSignal.timeout(5_000),
  });
  await response.body?.cancel();
  if (response.headers.get('stripe-mock-version') === null) {
    throw new Error(`${configured} answered without Stripe-Mock-Version: it is not stripe-mock`);
  }
});

definePaymentProviderContract({
  name: 'stripe-mock',
  stateful: false,
  secretKey: STRIPE_MOCK_API_KEY,
  baseUrl: () => configured,
  skipIfUnavailable: (ctx) => ctx.skip(unavailable !== undefined, unavailable),
  // stripe-mock is stateless: any payment intent id is "refundable".
  paidPaymentIntent: () => Promise.resolve('pi_3PgafyB7WZ01zgkW0000test'),
});

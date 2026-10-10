import { defineConfig } from 'vitest/config';

/**
 * Unit specs (`src/**\/*.spec.ts`) and the shared PaymentProvider contract suite
 * (`src/contract/*.contract.spec.ts`), which starts the emulator in-process on a random port and
 * drives it with the REAL `StripePaymentProvider` from `@udemy/payments`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    env: { NODE_ENV: 'test', STRIPE_SUPPRESS_NOTICES: 'true' },
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

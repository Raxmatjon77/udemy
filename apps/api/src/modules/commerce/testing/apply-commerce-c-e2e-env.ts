import { COMMERCE_E2E_ENV } from './apply-commerce-e2e-env';

/**
 * Side-effect import for commerce-c.e2e.spec.ts: the commerce e2e env (free ports, per-run
 * Stripe test secrets, see apply-commerce-e2e-env.ts) with `COMMERCE_JOBS_ENABLED=true`, so
 * the refund dispatcher's POST-COMMIT KICK runs for real, but both poll intervals at their
 * maximum (1 day): no timer tick ever runs during the suite, so a shared dev database's other
 * refunds and sessions are never touched (a kick dispatches only the refunds it was given).
 * Import FIRST.
 */
const ONE_DAY_MS = '86400000';

Object.assign(process.env, {
  COMMERCE_JOBS_ENABLED: 'true',
  COMMERCE_REFUND_DISPATCH_INTERVAL_MS: ONE_DAY_MS,
  COMMERCE_RECONCILE_INTERVAL_MS: ONE_DAY_MS,
});

export const COMMERCE_C_E2E_ENV = COMMERCE_E2E_ENV;

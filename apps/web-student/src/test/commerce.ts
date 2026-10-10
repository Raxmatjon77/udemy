import {
  createCommerceHandlers,
  createCommerceMockStore,
  type CommerceMockSeed,
  type CommerceMockStore,
} from '@udemy/contracts/testing';
import type { SetupServer } from 'msw/node';

import { PROXY } from './msw';

/**
 * The Phase 4 commerce API, mocked with `@udemy/contracts/testing` behind the BFF proxy path
 * the browser code calls. Every response is parsed with its contracts schema by the handlers.
 *
 * The store's clock is fixed (and movable through `clock.now`), so coupon windows and refund
 * windows never depend on when the suite runs.
 */
export const clock = { now: new Date('2026-10-15T12:00:00.000Z') };

export function mockCommerce(server: SetupServer, seed: CommerceMockSeed = {}): CommerceMockStore {
  const store = createCommerceMockStore({ now: () => clock.now, ...seed });
  server.use(...createCommerceHandlers({ baseUrl: PROXY, store }).handlers);
  return store;
}

export const CHECKOUT_ORIGIN = 'http://127.0.0.1:12111';

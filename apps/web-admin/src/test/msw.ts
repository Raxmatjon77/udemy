import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';
import {
  createCommerceHandlers,
  createCommerceMockStore,
  type CommerceMockSeed,
  type CommerceMockStore,
} from '@udemy/contracts/testing';

/**
 * MSW for the commerce specs: the `@udemy/contracts/testing` handlers answer `/api/proxy/*`
 * (the BFF) exactly like the API would per the contracts (every response is parsed with its
 * schema before it is sent). Unhandled requests fail the test.
 *
 * Older specs use `./api-mock` (a stubbed `fetch`); do not mix both in one file.
 */
export const server = setupServer();

/** The browser base of every handler (jsdom's origin + the BFF proxy). */
export const PROXY_BASE = '*/api/proxy';

/** `*\/api/proxy` + path, for one-off `server.use(http.get(proxy('/x'), …))` overrides. */
export const proxy = (path: string) => `${PROXY_BASE}${path}`;

export function setupMockApi(): void {
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}

/**
 * A fresh commerce store with the signed-in admin as the viewer, its handlers installed.
 * Returns the store so a test can seed orders, refunds and enrollments.
 */
export function installCommerceStore(
  seed: CommerceMockSeed & { viewerId: string },
): CommerceMockStore {
  const store = createCommerceMockStore(seed);
  const { handlers } = createCommerceHandlers({ baseUrl: PROXY_BASE, store });
  server.use(...handlers);
  return store;
}

import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

/**
 * One MSW server per spec file. Unhandled requests fail the test: every API call a spec
 * triggers must be one it expects.
 */
export function setupMswServer() {
  const server = setupServer();
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
  return server;
}

/** The API base the server-side code calls (vitest.config `API_INTERNAL_URL`). */
export const API = 'http://api.test/api/v1';
/** The BFF proxy base the browser code calls (jsdom location is http://localhost:3000). */
export const PROXY = 'http://localhost:3000/api/proxy';

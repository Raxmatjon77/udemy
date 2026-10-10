import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

/**
 * Mock API for component specs: handlers answer `/api/proxy/*` (the BFF) exactly like the API
 * would per `@udemy/contracts`. Fixtures are parsed with the contracts schemas (./fixtures.ts).
 * Unhandled requests fail the test.
 */
export const server = setupServer();

export function setupMockApi(): void {
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
  afterEach(() => server.resetHandlers());
  afterAll(() => server.close());
}

/** `http://localhost:3000/api/proxy` + path: jsdom's default origin. */
export const proxy = (path: string) => `*/api/proxy${path}`;

/** An RFC 7807 problem body like the API sends. */
export function problem(status: number, code: string, extra: Record<string, unknown> = {}) {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: code, status, code, ...extra }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

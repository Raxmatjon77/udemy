import { vi } from 'vitest';
import { PROBLEM_JSON_CONTENT_TYPE, type ErrorCode } from '@udemy/contracts';

/*
 * A tiny in-memory stand-in for the BFF (`/api/proxy/*`): tests register handlers per
 * "METHOD /path" (the API path, without `/api/proxy`) and every browser fetch is answered by them.
 * Fixtures are parsed with the contracts schemas before they get here (see ./fixtures.ts), so a
 * contract change breaks the tests instead of silently drifting.
 */

export interface MockRequest {
  method: string;
  /** The API path without `/api/proxy`, e.g. `/admin/course-reviews`. */
  path: string;
  query: URLSearchParams;
  /** Parsed JSON body, or undefined. */
  body: unknown;
}

export type MockHandler = (request: MockRequest) => Response | Promise<Response>;

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export function problem(status: number, code: ErrorCode | (string & {})): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: code, status, code }), {
    status,
    headers: { 'content-type': PROBLEM_JSON_CONTENT_TYPE },
  });
}

const PROXY = '/api/proxy';

/**
 * Installs the mock `fetch`. Routes are `"GET /admin/categories"`; a route may also be a
 * pattern with `:param` segments (`"POST /admin/courses/:id/takedown"`). Unknown routes fail the
 * request with 501 and are recorded in `unhandled`.
 */
export function mockApi(routes: Record<string, MockHandler>) {
  const calls: MockRequest[] = [];
  const unhandled: string[] = [];
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, pattern] = key.split(' ') as [string, string];
    const regex = new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`);
    return { method, regex, handler };
  });

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://localhost');
    const method = (init.method ?? 'GET').toUpperCase();
    if (!url.pathname.startsWith(PROXY)) {
      unhandled.push(`${method} ${url.pathname}`);
      return problem(501, 'not_mocked');
    }
    const path = url.pathname.slice(PROXY.length);
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    const request: MockRequest = { method, path, query: url.searchParams, body };
    calls.push(request);
    const route = compiled.find((r) => r.method === method && r.regex.test(path));
    if (!route) {
      unhandled.push(`${method} ${path}`);
      return problem(501, 'not_mocked');
    }
    return route.handler(request);
  });
  vi.stubGlobal('fetch', fetchMock);

  return {
    calls,
    unhandled,
    /** Calls to one route, e.g. `callsTo('POST', /approve$/)`. */
    callsTo: (method: string, path: RegExp) =>
      calls.filter((call) => call.method === method && path.test(call.path)),
  };
}

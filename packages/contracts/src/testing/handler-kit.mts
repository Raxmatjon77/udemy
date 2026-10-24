import { http, HttpResponse, type HttpHandler, type JsonBodyType } from 'msw';
import type { z } from 'zod';
import { ErrorCode } from '../errors/error-code.js';
import { PROBLEM_JSON_CONTENT_TYPE } from '../http/problem-details.js';
import { makeProblem } from './fixtures.mjs';
import { MockApiError } from './mock-store.mjs';

/**
 * Shared plumbing of the `@udemy/contracts/testing` MSW handlers: request validation with the
 * contracts schemas (400 `validation_failed`), problem responses, the mock keyset cursor and
 * response parsing (a contract drift throws inside the test).
 */

/** An RFC 7807 response like the api sends (`application/problem+json`). */
export function problemResponse(
  status: number,
  code: string,
  extra: Record<string, unknown> = {},
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(makeProblem(status, code, extra)), {
    status,
    headers: { ...headers, 'content-type': PROBLEM_JSON_CONTENT_TYPE },
  });
}

/** The mock's opaque keyset cursor: the offset of the next item (`o20`), like-shaped to the api's. */
const CURSOR_PATTERN = /^o(\d{1,9})$/;

/**
 * One page of `items` like the api's keyset pages: `limit` items, and a `nextCursor` only when
 * more items follow. A cursor the mock did not issue is 422 `validation_failed` (the api
 * rejects a cursor it cannot decode the same way).
 */
export function paginate<T>(
  items: readonly T[],
  query: { cursor?: string | undefined; limit: number },
): { items: T[]; nextCursor: string | null } {
  let start = 0;
  if (query.cursor !== undefined) {
    const match = CURSOR_PATTERN.exec(query.cursor);
    if (!match) {
      throw new MockApiError(422, ErrorCode.ValidationFailed, {
        errors: [{ path: 'cursor', message: 'Invalid cursor' }],
      });
    }
    start = Number(match[1]);
  }
  const end = start + query.limit;
  return { items: items.slice(start, end), nextCursor: end < items.length ? `o${end}` : null };
}

export class BadRequest extends Error {
  constructor(readonly errors: { path: string; message: string }[]) {
    super('validation_failed');
  }
}

export function check<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
): z.output<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequest(
      result.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.'),
        message: issue.message,
      })),
    );
  }
  return result.data;
}

/** `?a=1&a=2` → `{ a: ['1','2'] }`, `?a=1` → `{ a: '1' }`. */
export function queryOf(request: Request): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [key, value] of new URL(request.url).searchParams) {
    const previous = out[key];
    out[key] =
      previous === undefined
        ? value
        : Array.isArray(previous)
          ? [...previous, value]
          : [previous, value];
  }
  return out;
}

export async function bodyOf(request: Request): Promise<unknown> {
  const text = await request.text();
  if (text === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BadRequest([{ path: '', message: 'Malformed JSON' }]);
  }
}

/** Parses the outgoing body with its contract (a drift throws inside the test). */
export function reply<TSchema extends z.ZodType>(
  schema: TSchema,
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  return HttpResponse.json(schema.parse(body) as JsonBodyType, init);
}

export type Resolver = (args: {
  request: Request;
  params: Record<string, string | readonly string[] | undefined>;
}) => Response | Promise<Response>;

/** Maps store errors and bad input to problem responses. */
export function guarded(resolve: Resolver): Resolver {
  return async (args) => {
    try {
      return await resolve(args);
    } catch (error) {
      if (error instanceof MockApiError) {
        return problemResponse(error.status, error.code, error.extra, error.headers);
      }
      if (error instanceof BadRequest) {
        return problemResponse(400, ErrorCode.ValidationFailed, { errors: error.errors });
      }
      throw error;
    }
  };
}

/** A 204 response. */
export function noContent(): Response {
  return new Response(null, { status: 204 });
}

export type RouteMethod = 'get' | 'put' | 'post' | 'patch' | 'delete';

/** `route('get', '/path/:id', resolver)` bound to a base URL, with `guarded` error mapping. */
export function routeFactory(baseUrl: string) {
  return (method: RouteMethod, path: string, resolve: Resolver): HttpHandler =>
    http[method](`${baseUrl}${path}`, guarded(resolve));
}

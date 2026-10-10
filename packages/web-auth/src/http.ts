import 'server-only';
import {
  ErrorCode,
  PROBLEM_JSON_CONTENT_TYPE,
  type ProblemCode,
  type ProblemDetails,
} from '@udemy/contracts';
import type { WebAuthConfig } from './config';

/** Responses carrying session state must never be cached by anything. */
export const NO_STORE = 'no-store';

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Content Too Large',
  415: 'Unsupported Media Type',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

export function problemBody(status: number, code: ProblemCode, detail?: string): ProblemDetails {
  return {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    code,
    ...(detail ? { detail } : {}),
  };
}

/** An `application/problem+json` response, `Cache-Control: no-store`. */
export function problemResponse(
  status: number,
  code: ProblemCode,
  detail?: string,
  init?: { headers?: HeadersInit },
): Response {
  const headers = new Headers(init?.headers);
  headers.set('content-type', PROBLEM_JSON_CONTENT_TYPE);
  headers.set('cache-control', NO_STORE);
  return new Response(JSON.stringify(problemBody(status, code, detail)), { status, headers });
}

/** Re-serialises a (validated) upstream problem, keeping its status and body. */
export function forwardProblem(problem: ProblemDetails, headers?: HeadersInit): Response {
  const out = new Headers(headers);
  out.set('content-type', PROBLEM_JSON_CONTENT_TYPE);
  out.set('cache-control', NO_STORE);
  return new Response(JSON.stringify(problem), { status: problem.status, headers: out });
}

export const UNSAFE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF rule of design §9 for unsafe methods: `Origin` must equal `APP_ORIGIN`; when it does
 * not, `Sec-Fetch-Site: same-origin` (set by the browser, not forgeable by a page) is
 * accepted as a fallback (e.g. the app reached on 127.0.0.1 instead of localhost). A missing
 * `Origin` is always rejected: every modern browser sends it on unsafe fetches.
 *
 * Returns a 403 problem response when the request is rejected, otherwise `null`.
 */
export function checkOrigin(request: Request, config: WebAuthConfig): Response | null {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) return null;
  const origin = request.headers.get('origin');
  if (!origin) return problemResponse(403, ErrorCode.Forbidden, 'Missing Origin header');
  if (origin === config.appOrigin) return null;
  if (request.headers.get('sec-fetch-site') === 'same-origin') return null;
  return problemResponse(403, ErrorCode.Forbidden, 'Cross-origin request rejected');
}

export function hasRequestBody(request: Request): boolean {
  const length = request.headers.get('content-length');
  if (length !== null) return Number(length) > 0;
  return request.headers.has('transfer-encoding') || request.body !== null;
}

export function isJsonContentType(value: string | null): boolean {
  if (!value) return false;
  return value.split(';')[0]!.trim().toLowerCase() === 'application/json';
}

/** 415 unless a request that has a body declares `Content-Type: application/json`. */
export function checkJsonBody(request: Request): Response | null {
  if (!hasRequestBody(request)) return null;
  if (isJsonContentType(request.headers.get('content-type'))) return null;
  return problemResponse(415, ErrorCode.ValidationFailed, 'Content-Type must be application/json');
}

export class BodyTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Request body exceeds ${limit} bytes`);
    this.name = 'BodyTooLargeError';
  }
}

/** Reads a request body into memory, failing fast past `limit` bytes. */
export async function readBodyBytes(request: Request, limit: number): Promise<Uint8Array> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) throw new BodyTooLargeError(limit);
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new BodyTooLargeError(limit);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** A pass-through stream that errors once more than `limit` bytes have flowed. */
export function limitStream(limit: number): TransformStream<Uint8Array, Uint8Array> {
  let total = 0;
  return new TransformStream({
    transform(chunk, controller) {
      total += chunk.byteLength;
      if (total > limit) controller.error(new BodyTooLargeError(limit));
      else controller.enqueue(chunk);
    },
  });
}

import 'server-only';
import {
  AuthResultSchema,
  ErrorCode,
  ProblemDetailsSchema,
  RefreshResultSchema,
  type AuthResult,
  type LoginRequest,
  type ProblemDetails,
  type RefreshResult,
} from '@udemy/contracts';
import { z } from 'zod';
import type { WebAuthConfig } from './config';

/**
 * Server-side client for the NestJS API (`API_INTERNAL_URL + /api/v1 + path`).
 *
 * Every call carries the BFF client credentials and the end user's IP and user agent
 * (`X-Client-IP` / `X-Client-User-Agent`, which the API trusts only on client-authenticated
 * requests, §9), plus `Authorization: Bearer` when an access token is given.
 */

/** The API answered with an `application/problem+json` error. */
export class ApiProblemError extends Error {
  readonly status: number;
  readonly code: string | undefined;
  constructor(
    readonly problem: ProblemDetails,
    readonly retryAfter: string | null = null,
  ) {
    super(`API ${problem.status} ${problem.code ?? problem.title}`);
    this.name = 'ApiProblemError';
    this.status = problem.status;
    this.code = problem.code;
  }
}

/** The API could not be reached, timed out, or answered with something unparseable. */
export class ApiUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ApiUnavailableError';
  }
}

const IpSchema = z.union([z.ipv4(), z.ipv6()]);
const MAX_USER_AGENT = 512;

/**
 * End-user IP as this BFF saw it. Default: `x-real-ip`, else the LAST `x-forwarded-for` hop
 * (the one appended by our own ingress; earlier hops are client-controlled). Override with
 * `config.resolveClientIp` if the ingress topology differs.
 */
export function resolveClientIp(request: Request, config: WebAuthConfig): string | undefined {
  const candidate = config.resolveClientIp
    ? config.resolveClientIp(request)
    : (request.headers.get('x-real-ip') ??
      request.headers.get('x-forwarded-for')?.split(',').pop());
  const ip = candidate?.trim();
  return ip && IpSchema.safeParse(ip).success ? ip : undefined;
}

export function upstreamHeaders(
  config: WebAuthConfig,
  incoming: Request,
  accessToken?: string,
): Headers {
  const headers = new Headers({
    'x-client-id': config.clientId,
    'x-client-secret': config.clientSecret,
    accept: 'application/json',
  });
  const ip = resolveClientIp(incoming, config);
  if (ip) headers.set('x-client-ip', ip);
  const ua = incoming.headers.get('user-agent');
  if (ua) headers.set('x-client-user-agent', ua.slice(0, MAX_USER_AGENT));
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  return headers;
}

export function apiUrl(config: WebAuthConfig, path: string): string {
  if (!path.startsWith('/')) throw new Error(`API path must start with /: ${path}`);
  return `${config.apiInternalUrl}/api/v1${path}`;
}

/** Combines the per-call timeout with the incoming request's abort signal (client gone). */
export function timeoutSignal(config: WebAuthConfig, incoming?: Request): AbortSignal {
  const timeout = AbortSignal.timeout(config.apiTimeoutMs);
  return incoming?.signal ? AbortSignal.any([timeout, incoming.signal]) : timeout;
}

export interface ApiFetchInit {
  method?: string;
  headers?: Headers;
  body?: BodyInit | null;
  /** Required for streamed request bodies under undici. */
  duplex?: 'half';
}

/** Raw fetch to the API; network errors and timeouts become `ApiUnavailableError`. */
export async function apiFetch(
  config: WebAuthConfig,
  path: string,
  incoming: Request,
  init: ApiFetchInit & { accessToken?: string } = {},
): Promise<Response> {
  const headers = upstreamHeaders(config, incoming, init.accessToken);
  init.headers?.forEach((value, key) => headers.set(key, value));
  try {
    return await globalThis.fetch(apiUrl(config, path), {
      method: init.method ?? 'GET',
      headers,
      body: init.body ?? null,
      signal: timeoutSignal(config, incoming),
      redirect: 'manual',
      cache: 'no-store',
      ...(init.duplex ? { duplex: init.duplex } : {}),
    } as RequestInit);
  } catch (error) {
    throw new ApiUnavailableError(`API request failed: ${(error as Error).name}`, { cause: error });
  }
}

/** Parses a problem+json body (or synthesises one) for a non-2xx response. */
export async function readProblem(response: Response): Promise<ProblemDetails> {
  let raw: unknown;
  try {
    raw = await response.json();
  } catch {
    raw = undefined;
  }
  const parsed = ProblemDetailsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;
  return {
    type: 'about:blank',
    title: response.statusText || 'Error',
    status: response.status >= 400 && response.status <= 599 ? response.status : 502,
    code: response.status >= 500 ? ErrorCode.ServiceUnavailable : undefined,
  };
}

async function expectJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  if (response.status >= 500) {
    throw new ApiUnavailableError(`API answered ${response.status}`);
  }
  if (!response.ok) {
    throw new ApiProblemError(await readProblem(response), response.headers.get('retry-after'));
  }
  const parsed = schema.safeParse(await response.json().catch(() => undefined));
  if (!parsed.success) throw new ApiUnavailableError('API response does not match the contract');
  return parsed.data;
}

async function postJson(
  config: WebAuthConfig,
  path: string,
  incoming: Request,
  body: unknown,
  accessToken?: string,
): Promise<Response> {
  return apiFetch(config, path, incoming, {
    method: 'POST',
    headers: new Headers({ 'content-type': 'application/json' }),
    body: body === undefined ? null : JSON.stringify(body),
    ...(accessToken ? { accessToken } : {}),
  });
}

export async function apiLogin(
  config: WebAuthConfig,
  incoming: Request,
  body: LoginRequest,
): Promise<AuthResult> {
  return expectJson(await postJson(config, '/auth/login', incoming, body), AuthResultSchema);
}

export async function apiRefresh(
  config: WebAuthConfig,
  incoming: Request,
  refreshToken: string,
): Promise<RefreshResult> {
  return expectJson(
    await postJson(config, '/auth/refresh', incoming, { refreshToken }),
    RefreshResultSchema,
  );
}

/** `POST /auth/logout`: the API always answers 204; any failure is reported but harmless. */
export async function apiLogout(
  config: WebAuthConfig,
  incoming: Request,
  refreshToken: string,
): Promise<void> {
  const response = await postJson(config, '/auth/logout', incoming, { refreshToken });
  await response.body?.cancel();
  if (response.status >= 500) throw new ApiUnavailableError(`API answered ${response.status}`);
}

export async function apiLogoutAll(
  config: WebAuthConfig,
  incoming: Request,
  accessToken: string,
): Promise<void> {
  const response = await postJson(config, '/auth/logout-all', incoming, undefined, accessToken);
  if (response.ok) {
    await response.body?.cancel();
    return;
  }
  if (response.status >= 500) throw new ApiUnavailableError(`API answered ${response.status}`);
  throw new ApiProblemError(await readProblem(response), response.headers.get('retry-after'));
}

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { STRIPE_API_VERSION } from '@udemy/payments';
import type { FormObject } from '../http/form';
import { canonicalForm, parseForm } from '../http/form';
import { headerValue, mediaType, readBody } from '../http/io';
import {
  authenticationRequired,
  invalidApiKey,
  invalidRequest,
  unrecognizedUrl,
} from '../http/stripe-error';
import type { EventRequestContext } from '../webhooks/dispatcher';
import type { StripeEmulator } from './emulator';
import { stripeId } from './ids';
import { IdempotencyStore } from './idempotency';
import { ParamReader } from './params';

type ApiHandler = (
  params: FormObject,
  request: EventRequestContext,
  match: RegExpExecArray,
) => Record<string, unknown>;

interface Route {
  readonly method: 'GET' | 'POST';
  readonly pattern: RegExp;
  readonly handler: ApiHandler;
}

const ID = '([A-Za-z0-9_]{1,255})';

function noParams(params: FormObject): void {
  new ParamReader(params).finish();
}

export function apiRoutes(stripe: StripeEmulator): readonly Route[] {
  return [
    {
      method: 'POST',
      pattern: /^\/v1\/checkout\/sessions$/,
      handler: (params) => stripe.createCheckoutSession(params),
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/v1/checkout/sessions/${ID}$`),
      handler: (params, _request, match) => {
        noParams(params);
        return stripe.retrieveCheckoutSession(match[1] ?? '');
      },
    },
    {
      method: 'POST',
      pattern: new RegExp(`^/v1/checkout/sessions/${ID}/expire$`),
      handler: (params, request, match) => {
        noParams(params);
        return stripe.expireCheckoutSession(match[1] ?? '', request);
      },
    },
    {
      method: 'POST',
      pattern: /^\/v1\/refunds$/,
      handler: (params, request) => stripe.createRefund(params, request),
    },
    {
      method: 'GET',
      pattern: new RegExp(`^/v1/refunds/${ID}$`),
      handler: (params, _request, match) => {
        noParams(params);
        return stripe.retrieveRefund(match[1] ?? '');
      },
    },
  ];
}

function sameSecret(candidate: string, secret: string): boolean {
  const a = Buffer.from(candidate, 'utf8');
  const b = Buffer.from(secret, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Bearer (what stripe-node sends) or Basic with the key as the user name (curl -u sk_…:). */
export function authenticate(req: IncomingMessage, secretKey: string): string {
  const header = headerValue(req, 'authorization')?.trim();
  if (header === undefined || header === '') throw authenticationRequired();
  let key: string;
  const [scheme, value = ''] = header.split(/\s+/, 2);
  if (scheme?.toLowerCase() === 'bearer') {
    key = value;
  } else if (scheme?.toLowerCase() === 'basic') {
    key = Buffer.from(value, 'base64').toString('utf8').split(':')[0] ?? '';
  } else {
    throw authenticationRequired();
  }
  if (key === '') throw authenticationRequired();
  if (!sameSecret(key, secretKey)) throw invalidApiKey(key);
  return key;
}

/** The emulator implements exactly one API version: the one `@udemy/payments` pins. */
export function assertApiVersion(req: IncomingMessage): void {
  const version = headerValue(req, 'stripe-version');
  if (version !== undefined && version !== STRIPE_API_VERSION) {
    throw invalidRequest(
      `Invalid Stripe API version: ${version}. The Stripe emulator implements only ${STRIPE_API_VERSION}.`,
      'api_version_invalid',
    );
  }
}

export interface ApiDispatchResult {
  readonly status: number;
  readonly body: string;
  readonly requestId: string;
  readonly replayed: boolean;
  readonly idempotencyKey: string | null;
}

/**
 * Runs one `/v1/*` request: auth, version, body decoding, routing and idempotency. Throws
 * `StripeApiError` for every Stripe-style failure; the caller renders it.
 */
export async function dispatchApi(
  req: IncomingMessage,
  url: URL,
  routes: readonly Route[],
  idempotency: IdempotencyStore,
  secretKey: string,
  requestId: string,
): Promise<ApiDispatchResult> {
  const apiKey = authenticate(req, secretKey);
  assertApiVersion(req);
  const method = req.method ?? 'GET';
  const body = await readBody(req);
  let params: FormObject;
  if (method === 'POST') {
    if (url.search !== '') {
      throw invalidRequest('The Stripe emulator expects POST parameters in the form body.');
    }
    if (body.length > 0 && mediaType(req) !== 'application/x-www-form-urlencoded') {
      throw invalidRequest(
        'Invalid request: the body must be application/x-www-form-urlencoded (Stripe does not ' +
          'accept JSON bodies).',
      );
    }
    params = parseForm(body.toString('utf8'));
  } else {
    if (body.length > 0) throw invalidRequest(`A ${method} request must not have a body.`);
    params = parseForm(url.search.slice(1));
  }

  let route: Route | undefined;
  let match: RegExpExecArray | null = null;
  for (const candidate of routes) {
    if (candidate.method !== method) continue;
    match = candidate.pattern.exec(url.pathname);
    if (match !== null) {
      route = candidate;
      break;
    }
  }
  if (route === undefined || match === null) throw unrecognizedUrl(method, url.pathname);

  const key = method === 'POST' ? (headerValue(req, 'idempotency-key') ?? null) : null;
  const fingerprint = `${method} ${url.pathname} ${canonicalForm(params)}`;
  if (key !== null) {
    IdempotencyStore.validateKey(key);
    const found = idempotency.lookup(apiKey, key, fingerprint);
    if (found.kind === 'replay') {
      return { ...found.response, replayed: true, idempotencyKey: key };
    }
  }
  const result = route.handler(params, { requestId, idempotencyKey: key }, match);
  const response = { status: 200, body: `${JSON.stringify(result, null, 2)}\n`, requestId };
  if (key !== null) idempotency.save(apiKey, key, fingerprint, response);
  return { ...response, replayed: false, idempotencyKey: key };
}

export function sendApiResult(
  res: ServerResponse,
  result: ApiDispatchResult,
  requestId: string,
): void {
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache, no-store',
    'request-id': requestId,
    'stripe-version': STRIPE_API_VERSION,
  };
  if (result.idempotencyKey !== null) headers['idempotency-key'] = result.idempotencyKey;
  if (result.replayed) {
    headers['idempotent-replayed'] = 'true';
    headers['original-request'] = result.requestId;
  }
  const buffer = Buffer.from(result.body, 'utf8');
  res.writeHead(result.status, { ...headers, 'content-length': buffer.length });
  res.end(buffer);
}

export function newRequestId(): string {
  return stripeId('req', 14);
}

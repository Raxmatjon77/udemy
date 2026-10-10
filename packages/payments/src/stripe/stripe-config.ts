import Stripe from 'stripe';
import { PaymentConfigError } from '../errors';
import { DEFAULT_WEBHOOK_TOLERANCE_SECONDS } from '../webhook/signature';

/**
 * The Stripe API version this package is written and contract-tested against. It is the version
 * pinned by the exact `stripe` SDK dependency (23.0.0); bumping either is one reviewed change that
 * re-runs the stripe-mock contract tests.
 */
export const STRIPE_API_VERSION = '2026-09-30.endive' as const;

export type StripeApiVersion = typeof STRIPE_API_VERSION;

export interface StripeApiEndpoint {
  readonly protocol: 'http' | 'https';
  readonly host: string;
  readonly port: number;
}

export interface StripeProviderConfig {
  /** `sk_test_…` or `rk_test_…` (`STRIPE_SECRET_KEY`). Live keys are refused in Phase 4. */
  readonly secretKey: string;
  /**
   * `STRIPE_API_BASE_URL`: points the real adapter at `apps/stripe-emulator` or stripe-mock, e.g.
   * `http://127.0.0.1:12111`. Absent → `https://api.stripe.com`.
   */
  readonly apiBaseUrl?: string;
  /** SDK retries on network errors, 409 lock timeouts and 5xx (same idempotency key). Default 2. */
  readonly maxNetworkRetries?: number;
  /** Per-request timeout. Default 10 000 ms. */
  readonly timeoutMs?: number;
  /** Escape hatch for a future live phase; false refuses `sk_live_` / `rk_live_`. Default false. */
  readonly allowLiveKeys?: boolean;
}

export interface StripeWebhookConfig {
  /** `whsec_…` (`STRIPE_WEBHOOK_SECRET`). */
  readonly secret: string;
  /** `STRIPE_WEBHOOK_TOLERANCE_S`, default 300. */
  readonly toleranceSeconds: number;
}

export type PaymentsEnv = Readonly<Record<string, string | undefined>>;

const KEY_PATTERN = /^(sk|rk)_(test|live)_[A-Za-z0-9_]+$/;

/** Parses `STRIPE_API_BASE_URL` into the SDK's host/port/protocol settings. */
export function parseStripeApiBaseUrl(value: string): StripeApiEndpoint {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PaymentConfigError(`STRIPE_API_BASE_URL "${value}" is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new PaymentConfigError(`STRIPE_API_BASE_URL must be http(s), got ${url.protocol}`);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
    // The SDK always requests /v1/…; a path prefix would be silently dropped.
    throw new PaymentConfigError('STRIPE_API_BASE_URL must not have a path, query or fragment');
  }
  if (url.username !== '' || url.password !== '') {
    throw new PaymentConfigError('STRIPE_API_BASE_URL must not contain credentials');
  }
  const protocol = url.protocol === 'http:' ? 'http' : 'https';
  const port = url.port === '' ? (protocol === 'http' ? 80 : 443) : Number(url.port);
  // URL keeps IPv6 brackets in hostname; Node's http.request wants them stripped.
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
  return { protocol, host, port };
}

export function validateStripeProviderConfig(config: StripeProviderConfig): StripeProviderConfig {
  const key = config.secretKey.trim();
  if (!KEY_PATTERN.test(key)) {
    throw new PaymentConfigError('STRIPE_SECRET_KEY must be an sk_/rk_ test or live key');
  }
  if (key.includes('_live_') && config.allowLiveKeys !== true) {
    throw new PaymentConfigError('STRIPE_SECRET_KEY is a live key; Phase 4 is test-mode only');
  }
  if (config.apiBaseUrl !== undefined) parseStripeApiBaseUrl(config.apiBaseUrl);
  if (
    config.maxNetworkRetries !== undefined &&
    (!Number.isSafeInteger(config.maxNetworkRetries) || config.maxNetworkRetries < 0)
  ) {
    throw new PaymentConfigError('maxNetworkRetries must be a non-negative integer');
  }
  if (
    config.timeoutMs !== undefined &&
    (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0)
  ) {
    throw new PaymentConfigError('timeoutMs must be a positive integer');
  }
  return { ...config, secretKey: key };
}

function optional(env: PaymentsEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function required(env: PaymentsEnv, name: string): string {
  const value = optional(env, name);
  if (value === undefined) throw new PaymentConfigError(`${name} is required`);
  return value;
}

/** Fails fast when `STRIPE_API_VERSION` is set to anything but the pinned version. */
export function assertPinnedApiVersion(value: string | undefined): void {
  if (value !== undefined && value !== STRIPE_API_VERSION) {
    throw new PaymentConfigError(
      `STRIPE_API_VERSION=${value} but @udemy/payments is pinned to ${STRIPE_API_VERSION}`,
    );
  }
}

/**
 * Reads `STRIPE_SECRET_KEY`, `STRIPE_API_BASE_URL` (optional) and `STRIPE_API_VERSION` (optional;
 * must equal the pinned version). Apps with their own zod env schema can build the config
 * themselves and call `validateStripeProviderConfig`.
 */
export function stripeProviderConfigFromEnv(env: PaymentsEnv = process.env): StripeProviderConfig {
  assertPinnedApiVersion(optional(env, 'STRIPE_API_VERSION'));
  const apiBaseUrl = optional(env, 'STRIPE_API_BASE_URL');
  return validateStripeProviderConfig({
    secretKey: required(env, 'STRIPE_SECRET_KEY'),
    ...(apiBaseUrl === undefined ? {} : { apiBaseUrl }),
  });
}

/** Reads `STRIPE_WEBHOOK_SECRET` (must start with `whsec_`) and `STRIPE_WEBHOOK_TOLERANCE_S`. */
export function stripeWebhookConfigFromEnv(env: PaymentsEnv = process.env): StripeWebhookConfig {
  const secret = required(env, 'STRIPE_WEBHOOK_SECRET');
  if (!secret.startsWith('whsec_') || secret.length < 12) {
    throw new PaymentConfigError('STRIPE_WEBHOOK_SECRET must be a whsec_… secret');
  }
  const rawTolerance = optional(env, 'STRIPE_WEBHOOK_TOLERANCE_S');
  const toleranceSeconds =
    rawTolerance === undefined ? DEFAULT_WEBHOOK_TOLERANCE_SECONDS : Number(rawTolerance);
  if (!Number.isSafeInteger(toleranceSeconds) || toleranceSeconds <= 0 || toleranceSeconds > 600) {
    throw new PaymentConfigError('STRIPE_WEBHOOK_TOLERANCE_S must be an integer in 1..600');
  }
  return { secret, toleranceSeconds };
}

/** Builds the SDK client: pinned `apiVersion`, no telemetry, base-URL override. */
export function createStripeClient(config: StripeProviderConfig): Stripe {
  const valid = validateStripeProviderConfig(config);
  const endpoint =
    valid.apiBaseUrl === undefined ? undefined : parseStripeApiBaseUrl(valid.apiBaseUrl);
  return new Stripe(valid.secretKey, {
    apiVersion: STRIPE_API_VERSION,
    maxNetworkRetries: valid.maxNetworkRetries ?? 2,
    timeout: valid.timeoutMs ?? 10_000,
    telemetry: false,
    appInfo: { name: '@udemy/payments' },
    ...(endpoint === undefined
      ? {}
      : { host: endpoint.host, port: endpoint.port, protocol: endpoint.protocol }),
  });
}

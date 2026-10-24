import type { DynamicModule, FactoryProvider, Provider } from '@nestjs/common';
import { createLoggerModule, LOG_REDACT_CENSOR, logRedactCensor } from '@udemy/nest-common';

/*
 * The api's logger: `@udemy/nest-common`'s pino setup plus the payment redactions of the
 * commerce & enrollment design §9 ("Pino redacts req.headers["stripe-signature"],
 * *.checkoutUrl and *.url"). They are api-only (only the api talks to Stripe, D9), and
 * `createLoggerModule` has no option for extra paths yet, so the api extends the params locally.
 *
 * TODO(nest-common): add `extraRedactPaths` / `extraCensor` to `CreateLoggerModuleOptions` and
 * drop `withApiRedaction` (it wraps nestjs-pino's params provider, an internal detail; it
 * throws at startup if that ever changes, so the redactions cannot silently disappear).
 */

/** Extra pino redact paths (fully censored), relative to the logged object. */
export const API_LOG_REDACT_PATHS: readonly string[] = [
  // The Stripe webhook signature header (an HMAC; replayable within the tolerance window).
  'req.headers["stripe-signature"]',
  // Checkout responses (`{ orderId, checkoutUrl }`, `checkout_in_progress` problems).
  ...['', '*.', '*.*.'].map((at) => `${at}checkoutUrl`),
  // WS tickets (Phase 5 design §9): `POST /realtime/tickets` responses, handshake `auth`.
  ...['', '*.', '*.*.'].map((at) => `${at}ticket`),
];

/** A Stripe Checkout Session id, as it appears in hosted-page URLs and API payloads. */
const CHECKOUT_SESSION_ID = /\bcs_(?:test|live)_[A-Za-z0-9]+/;
/** Keys whose value is always censored, wherever it is nested. */
const CENSORED_KEYS: ReadonlySet<string> = new Set(['checkoutUrl', 'ticket']);
const MAX_DEPTH = 8;

function isCheckoutUrl(value: unknown): value is string {
  return typeof value === 'string' && CHECKOUT_SESSION_ID.test(value);
}

/**
 * Censors checkout URLs (any string carrying a Checkout Session id, and every `checkoutUrl`
 * key) inside a value that pino hands over whole (e.g. `responseBody`: pino skips deeper paths
 * once a parent path is redacted). Returns the input when there is nothing to censor.
 */
function censorCheckoutUrls(value: unknown, depth = 0): unknown {
  if (isCheckoutUrl(value)) return LOG_REDACT_CENSOR;
  if (typeof value !== 'object' || value === null) return value;
  if (depth >= MAX_DEPTH) return LOG_REDACT_CENSOR;
  if (Array.isArray(value)) {
    const items = value.map((item: unknown) => censorCheckoutUrls(item, depth + 1));
    return items.some((item, i) => item !== value[i]) ? items : value;
  }
  let changed = false;
  const copy: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    const next = CENSORED_KEYS.has(key) ? LOG_REDACT_CENSOR : censorCheckoutUrls(inner, depth + 1);
    if (next !== inner) changed = true;
    copy[key] = next;
  }
  return changed ? copy : value;
}

/**
 * The api's pino `redact.censor`: checkout URLs are censored wholesale (also under the shared
 * `*.url` / `responseBody` paths, which the shared censor only strips of S3 signing parameters,
 * keeping a Stripe hosted-checkout URL readable); everything else is the shared censor.
 */
export function apiLogRedactCensor(value: unknown, path: readonly string[]): unknown {
  if (value === undefined) return undefined;
  if (CENSORED_KEYS.has(path.at(-1) ?? '')) return LOG_REDACT_CENSOR;
  return logRedactCensor(censorCheckoutUrls(value), path);
}

interface RedactOptions {
  paths: string[];
  censor: (value: unknown, path: string[]) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRedactOptions(value: unknown): value is RedactOptions {
  return (
    isRecord(value) &&
    Array.isArray(value.paths) &&
    value.paths.every((p) => typeof p === 'string') &&
    typeof value.censor === 'function'
  );
}

/** Adds the api's paths and censor to nestjs-pino `Params` (`{ pinoHttp: { redact } }`). */
export function extendApiRedaction<TParams>(params: TParams): TParams {
  const pinoHttp = isRecord(params) ? params.pinoHttp : undefined;
  const redact = isRecord(pinoHttp) ? pinoHttp.redact : undefined;
  if (!isRecord(params) || !isRecord(pinoHttp) || !isRedactOptions(redact)) {
    throw new Error('api logger: unexpected pino params shape; cannot add payment redactions');
  }
  const paths = [...new Set([...redact.paths, ...API_LOG_REDACT_PATHS])];
  const extended = { ...pinoHttp, redact: { paths, censor: apiLogRedactCensor } };
  return { ...params, pinoHttp: extended } as TParams;
}

/** nestjs-pino's params token (`PARAMS_PROVIDER_TOKEN`); not exported by nest-common. */
const PINO_PARAMS_TOKEN = 'pino-params';

function isParamsFactory(provider: Provider): provider is FactoryProvider {
  return (
    isRecord(provider) &&
    provider.provide === PINO_PARAMS_TOKEN &&
    typeof provider.useFactory === 'function'
  );
}

/** Wraps the logger module's params factory with `extendApiRedaction`. */
export function withApiRedaction(module: DynamicModule): DynamicModule {
  let wrapped = 0;
  const providers = (module.providers ?? []).map((provider): Provider => {
    if (!isParamsFactory(provider)) return provider;
    wrapped += 1;
    const factory = provider.useFactory;
    return {
      ...provider,
      useFactory: async (...deps: unknown[]): Promise<unknown> =>
        extendApiRedaction(await (factory(...deps) as unknown)),
    };
  });
  if (wrapped !== 1) {
    throw new Error(
      `api logger: expected one '${PINO_PARAMS_TOKEN}' factory provider, found ${wrapped}; ` +
        'move the payment redactions into @udemy/nest-common',
    );
  }
  return { ...module, providers };
}

/** `createLoggerModule({ serviceName: 'udemy-api' })` plus the payment redactions. */
export function createApiLoggerModule(): DynamicModule {
  return withApiRedaction(createLoggerModule({ serviceName: 'udemy-api' }));
}

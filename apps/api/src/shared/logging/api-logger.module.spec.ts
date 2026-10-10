import type { FactoryProvider } from '@nestjs/common';
import { buildPinoParams, LOG_REDACT_ALL_PATHS, LOG_REDACT_CENSOR } from '@udemy/nest-common';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  API_LOG_REDACT_PATHS,
  apiLogRedactCensor,
  createApiLoggerModule,
  extendApiRedaction,
  withApiRedaction,
} from './api-logger.module';

interface Redact {
  paths: string[];
  censor: (value: unknown, path: string[]) => unknown;
}

const apiParams = (): { pinoHttp: { redact: Redact } } =>
  extendApiRedaction(
    buildPinoParams({ NODE_ENV: 'production', LOG_LEVEL: 'info' }, { serviceName: 'udemy-api' }),
  ) as { pinoHttp: { redact: Redact } };

/** A pino logger with exactly the api's redaction config, writing into an array. */
function captureLogger(): { logger: pino.Logger; line: () => string } {
  const output: string[] = [];
  const logger = pino(
    { redact: apiParams().pinoHttp.redact },
    { write: (l: string) => output.push(l) },
  );
  return { logger, line: () => output.join('') };
}

const CHECKOUT_URL =
  'https://checkout.stripe.com/c/pay/cs_test_a1B2c3D4e5#fidkdWxOYHwnPyd1blpxYHZx';
const EMULATOR_URL = 'http://127.0.0.1:12111/pay/cs_test_9zY8x7W6';
const S3_URL =
  'https://minio.local/b/k.jpg?X-Amz-Signature=deadbeef&X-Amz-Credential=AKIA%2Fx&partNumber=1';

describe('api logger redaction (commerce & enrollment design §9)', () => {
  it('keeps every shared path and adds the payment paths', () => {
    const { paths, censor } = apiParams().pinoHttp.redact;

    expect(paths.slice(0, LOG_REDACT_ALL_PATHS.length)).toEqual([...LOG_REDACT_ALL_PATHS]);
    expect(paths).toEqual(expect.arrayContaining([...API_LOG_REDACT_PATHS]));
    expect(paths).toContain('req.headers["stripe-signature"]');
    expect(censor).toBe(apiLogRedactCensor);
  });

  it('censors the Stripe-Signature header and keeps the other headers', () => {
    const { logger, line } = captureLogger();

    logger.info({
      req: {
        url: '/api/v1/webhooks/stripe',
        headers: { 'stripe-signature': 't=1,v1=abcdef0123', authorization: 'Bearer x.y' },
      },
    });

    expect(line()).not.toContain('v1=abcdef0123');
    expect(line()).not.toContain('Bearer x.y');
    expect(line()).toContain('/api/v1/webhooks/stripe');
  });

  it.each([
    ['checkoutUrl at the top level', { checkoutUrl: CHECKOUT_URL }],
    ['checkoutUrl nested', { res: { body: { orderId: 'o-1', checkoutUrl: EMULATOR_URL } } }],
    ['a checkout URL under url', { url: CHECKOUT_URL }],
    ['a checkout URL inside responseBody', { responseBody: { items: [{ url: EMULATOR_URL }] } }],
    ['checkoutUrl inside responseBody', { responseBody: { checkoutUrl: CHECKOUT_URL } }],
  ])('censors %s', (_where, logged) => {
    const { logger, line } = captureLogger();

    logger.info(logged);

    expect(line()).not.toContain('cs_test_');
    expect(line()).toContain(LOG_REDACT_CENSOR);
  });

  it('still strips S3 signing parameters but keeps ordinary URLs readable', () => {
    const { logger, line } = captureLogger();

    logger.info({ url: S3_URL, req: { url: '/api/v1/me/orders/o-1' }, orderId: 'o-1' });

    expect(line()).not.toContain('deadbeef');
    expect(line()).toContain('https://minio.local/b/k.jpg?partNumber=1');
    expect(line()).toContain('/api/v1/me/orders/o-1');
  });

  it('wraps the params factory of the real logger module exactly once', async () => {
    const module = createApiLoggerModule();
    const params = (module.providers ?? []).find(
      (p): p is FactoryProvider =>
        typeof p === 'object' && 'provide' in p && p.provide === 'pino-params',
    );
    const config = { get: (key: string) => ({ NODE_ENV: 'production', LOG_LEVEL: 'info' })[key] };

    const built = (await params?.useFactory(config)) as { pinoHttp: { redact: Redact } };

    expect(built.pinoHttp.redact.paths).toContain('req.headers["stripe-signature"]');
    expect(built.pinoHttp.redact.censor).toBe(apiLogRedactCensor);
  });

  it('fails loudly when the logger module no longer has the expected shape', () => {
    expect(() => withApiRedaction({ module: class Empty {}, providers: [] })).toThrow(
      /expected one 'pino-params' factory provider/,
    );
    expect(() => extendApiRedaction({ pinoHttp: [{}, {}] })).toThrow(/unexpected pino params/);
  });
});

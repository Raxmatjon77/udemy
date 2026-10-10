import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { STRIPE_API_VERSION } from '@udemy/payments';
import type { EmulatorConfig, ListenConfig } from './config';
import { controlApi } from './control/control-routes';
import { BodyTooLargeError, sendJson } from './http/io';
import { internalError, invalidRequest, StripeApiError } from './http/stripe-error';
import type { Logger } from './logger';
import { errorMessage, jsonLogger } from './logger';
import { handlePay, PAY_PATH } from './pages/pay-routes';
import { apiRoutes, dispatchApi, newRequestId, sendApiResult } from './stripe/api-routes';
import { StripeEmulator } from './stripe/emulator';
import type { Clock } from './stripe/ids';
import { systemClock } from './stripe/ids';
import { IdempotencyStore } from './stripe/idempotency';
import { WebhookDispatcher } from './webhooks/dispatcher';

export interface EmulatorDependencies {
  readonly clock?: Clock;
  readonly logger?: Logger;
}

export interface RunningEmulator {
  /** Where the server listens, e.g. `http://127.0.0.1:54321` (use as STRIPE_API_BASE_URL). */
  readonly url: string;
  /** The pay-page origin put into `session.url`. */
  readonly publicUrl: string;
  readonly config: EmulatorConfig;
  readonly stripe: StripeEmulator;
  readonly webhooks: WebhookDispatcher;
  readonly idempotency: IdempotencyStore;
  readonly server: Server;
  /** Same as `POST /_emulator/reset`. */
  reset(): void;
  /** Stops the sweep timer and pending retries, then closes the server. */
  close(): Promise<void>;
}

function hostForUrl(address: AddressInfo): string {
  const host =
    address.address === '0.0.0.0' || address.address === '::' ? '127.0.0.1' : address.address;
  return host.includes(':') ? `[${host}]` : host;
}

/**
 * Builds and starts the emulator on `listen` (port 0 = random, for in-process tests).
 * Routes: `GET /health`, `/v1/*` (Stripe API subset), `/pay/:id` (hosted page),
 * `/_emulator/*` (control API, when enabled).
 */
export async function startEmulator(
  config: EmulatorConfig,
  listen: ListenConfig,
  dependencies: EmulatorDependencies = {},
): Promise<RunningEmulator> {
  const clock = dependencies.clock ?? systemClock;
  const logger = dependencies.logger ?? jsonLogger();
  let publicUrl = config.publicUrl ?? '';

  const webhooks = new WebhookDispatcher({
    url: config.webhookUrl,
    secret: config.webhookSecret,
    maxAttempts: config.webhookMaxAttempts,
    retryBaseMs: config.webhookRetryBaseMs,
    retryMaxMs: config.webhookRetryMaxMs,
    timeoutMs: config.webhookTimeoutMs,
    clock,
    logger,
  });
  const stripe = new StripeEmulator({
    clock,
    webhooks,
    payUrl: (id) => `${publicUrl}/pay/${id}`,
  });
  const idempotency = new IdempotencyStore();
  const routes = apiRoutes(stripe);
  const reset = (): void => {
    stripe.reset();
    idempotency.reset();
    webhooks.reset();
  };
  const control = controlApi({
    stripe,
    webhooks,
    reset,
    info: () => ({
      emulator: '@udemy/stripe-emulator',
      apiVersion: STRIPE_API_VERSION,
      publicUrl,
      webhookUrl: webhooks.webhookUrl,
    }),
  });

  async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const requestId = newRequestId();
    try {
      const result = await dispatchApi(req, url, routes, idempotency, config.secretKey, requestId);
      sendApiResult(res, result, requestId);
      logger.log('info', 'api request', {
        method: req.method,
        path: url.pathname,
        status: result.status,
        requestId,
        replayed: result.replayed,
      });
    } catch (error) {
      let apiError: StripeApiError;
      if (error instanceof StripeApiError) apiError = error;
      else if (error instanceof BodyTooLargeError) {
        apiError = new StripeApiError(413, { ...invalidRequest('Request body too large.').body });
      } else {
        logger.log('error', 'unexpected api error', { requestId, error: errorMessage(error) });
        apiError = internalError();
      }
      logger.log('info', 'api request', {
        method: req.method,
        path: url.pathname,
        status: apiError.status,
        requestId,
        code: apiError.body.code ?? apiError.body.type,
      });
      sendJson(res, apiError.status, apiError.toJSON(), {
        'request-id': requestId,
        'stripe-version': STRIPE_API_VERSION,
        // Our 4xx are deterministic: tell the SDK not to retry them.
        'stripe-should-retry': apiError.status >= 500 ? 'true' : 'false',
      });
    }
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://emulator.invalid');
    const path = url.pathname;
    if (path === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(res, 200, { status: 'ok' });
      return;
    }
    if (path === '/v1' || path.startsWith('/v1/')) {
      await handleApi(req, res, url);
      return;
    }
    const pay = PAY_PATH.exec(path);
    if (pay !== null) {
      await handlePay(req, res, pay[1] ?? '', stripe);
      return;
    }
    if (config.controlEnabled && (path === '/_emulator' || path.startsWith('/_emulator/'))) {
      if (await control(req, res, url)) return;
    }
    sendJson(res, 404, { error: { message: `Not found: ${req.method ?? 'GET'} ${path}` } });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof BodyTooLargeError) {
        if (!res.headersSent) sendJson(res, 413, { error: { message: error.message } });
        else res.destroy();
        return;
      }
      logger.log('error', 'unhandled request error', { url: req.url, error: errorMessage(error) });
      if (!res.headersSent) sendJson(res, 500, { error: { message: 'internal error' } });
      else res.destroy();
    });
  });
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(listen.port, listen.host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const url = `http://${hostForUrl(address)}:${address.port}`;
  if (publicUrl === '') publicUrl = url;

  const sweep = setInterval(() => stripe.expireDueSessions(), config.expirySweepMs);
  sweep.unref();

  logger.log('info', 'stripe emulator listening', {
    url,
    publicUrl,
    webhookUrl: config.webhookUrl,
    controlEnabled: config.controlEnabled,
    apiVersion: STRIPE_API_VERSION,
  });

  return {
    url,
    publicUrl,
    config,
    stripe,
    webhooks,
    idempotency,
    server,
    reset,
    async close(): Promise<void> {
      clearInterval(sweep);
      webhooks.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
        server.closeIdleConnections();
      });
    },
  };
}

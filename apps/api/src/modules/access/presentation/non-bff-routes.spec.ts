// Must be the first import: sets process.env before app.module validates it.
import '../../../testing/apply-test-env';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { DATABASE, DbHealthIndicator, indicatorResult } from '@udemy/nest-common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../../../app.module';
import { API_APP_OPTIONS, setupApp } from '../../../setup-app';
import { S3HealthIndicator } from '../../../shared/health/s3-health.indicator';
import { REDIS, RedisHealthIndicator } from '../../../shared/redis';
import { type NonBffRoute, RouteSecurityAuditor } from './route-security.auditor';

/*
 * The non-BFF route inventory (commerce & enrollment design §9): every route reachable
 * WITHOUT client credentials, pinned exactly. A new public ingress (a webhook, a probe, a
 * well-known document) must change this file, so it is always a reviewed diff.
 *
 * Two independent views of the real AppModule must agree:
 *   1. what the RouteSecurityAuditor reports (the `@NoClientAuth` routes, also logged at boot),
 *   2. what Express really serves: every registered route is called without credentials, and
 *      everything outside the inventory must answer 401 (ClientAuthGuard runs first). A 404
 *      means no handler matched: Nest mounts middleware (pino, …) as route layers too, e.g.
 *      `/api{/*splat}`, and a real handler can never 404 before its guards ran.
 *
 * No real Postgres/Redis/S3: the clients are replaced and the probes stubbed.
 */
const fakeDatabase = { destroy: vi.fn(async () => undefined) };
const fakeRedis = { status: 'ready', quit: vi.fn(async () => 'OK'), disconnect: vi.fn() };
const up = { check: vi.fn(async (key: string) => indicatorResult(key, 'up')) };

/** Update in the same change that adds or removes a public ingress route. */
const NON_BFF_ROUTES: readonly NonBffRoute[] = [
  { route: 'JwksController.get', method: 'GET', path: '/.well-known/jwks.json', ingress: 'read' },
  { route: 'HealthController.live', method: 'GET', path: '/health/live', ingress: 'read' },
  { route: 'HealthController.ready', method: 'GET', path: '/health/ready', ingress: 'read' },
  // P4-T15: the signed Stripe webhook (400 webhook_signature_invalid without a valid signature).
  {
    route: 'StripeWebhookController.receive',
    method: 'POST',
    path: '/webhooks/stripe',
    ingress: 'webhook:stripe',
  },
];

/** The same routes as Express serves them (global prefix, versioning, prefix exclusions). */
const NON_BFF_URLS: readonly string[] = [
  'GET /.well-known/jwks.json',
  'GET /api/health/live',
  'GET /api/health/ready',
  'POST /api/v1/webhooks/stripe',
];

type Method = 'get' | 'post' | 'put' | 'patch' | 'delete';
const METHODS: readonly Method[] = ['get', 'post', 'put', 'patch', 'delete'];
const SOME_ID = '00000000-0000-4000-8000-000000000000';

/** Every route Express serves, as `[method, concrete path]` (route params filled in). */
function servedRoutes(app: NestExpressApplication): [Method, string][] {
  interface Layer {
    route?: { path: unknown; methods: Record<string, boolean> };
  }
  const router = (app.getHttpAdapter().getInstance() as { router?: { stack?: Layer[] } }).router;
  if (router?.stack === undefined) throw new Error('unexpected Express internals: no app.router');
  return router.stack.flatMap((layer): [Method, string][] => {
    const route = layer.route;
    if (route === undefined || typeof route.path !== 'string') return [];
    const path = route.path.replace(/:[A-Za-z0-9_]+/g, SOME_ID);
    return METHODS.filter((m) => route.methods[m] === true).map((m): [Method, string] => [m, path]);
  });
}

describe('non-BFF route inventory (real AppModule)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(DATABASE)
      .useValue(fakeDatabase)
      .overrideProvider(DbHealthIndicator)
      .useValue(up)
      .overrideProvider(REDIS)
      .useValue(fakeRedis)
      .overrideProvider(RedisHealthIndicator)
      .useValue(up)
      .overrideProvider(S3HealthIndicator)
      .useValue(up)
      .compile();
    app = moduleRef.createNestApplication<NestExpressApplication>({
      ...API_APP_OPTIONS,
      logger: false,
    });
    setupApp(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('the auditor lists exactly the pinned routes without client authentication', () => {
    expect(app.get(RouteSecurityAuditor).nonBffRoutes()).toEqual(NON_BFF_ROUTES);
  });

  it('Express answers 401 without client credentials on every other route', async () => {
    const routes = servedRoutes(app);
    // Sanity: the sweep really sees the API (Phase 1 + 2 have far more than a handful).
    expect(routes.length).toBeGreaterThan(50);

    const reachable = new Set<string>();
    for (const [method, path] of routes) {
      const res = await request(app.getHttpServer())[method](path).set('x-client-ip', '1.2.3.4');
      if (res.status !== 401 && res.status !== 404) {
        reachable.add(`${method.toUpperCase()} ${path}`);
      }
    }

    expect([...reachable].sort()).toEqual([...NON_BFF_URLS].sort());
  });
});

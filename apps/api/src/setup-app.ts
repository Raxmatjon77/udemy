import { type NestApplicationOptions, VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { attachLogger } from '@udemy/nest-common';
import helmet from 'helmet';
import { IDENTITY_PREFIX_EXCLUSIONS } from './modules/identity';
import { AppConfigService } from './shared/config';
import { installRealtimeAdapter } from './shared/realtime';

export const GLOBAL_PREFIX = 'api';

/**
 * Options for creating the HTTP app, shared by `main.ts`, the e2e harness and every HTTP test
 * that creates the app (`NestFactory.create(AppModule, API_APP_OPTIONS)` /
 * `moduleRef.createNestApplication(API_APP_OPTIONS)`). `setupApp` cannot switch these on: they
 * are read when the app is created.
 *
 * `rawBody`: Nest's built-in JSON/urlencoded parsers also keep the exact request bytes in
 * `req.rawBody` (a Buffer). Provider webhooks verify their signature over those bytes
 * (commerce & enrollment design D10, §9), so prod and tests must parse bodies identically, or
 * verification passes in one and fails in the other. Parsing is otherwise unchanged: `req.body`
 * is still the parsed JSON for the zod validation pipe, and the body-parser default limit
 * (100 kB) still applies. No middleware may re-serialize or rewrite the body before the guard.
 */
export const API_APP_OPTIONS = Object.freeze({
  rawBody: true,
} as const satisfies NestApplicationOptions);

/**
 * Everything that configures the HTTP app but is not a module: middleware, prefix,
 * versioning, docs, and the socket.io adapter (Phase 5 realtime, `/realtime/socket.io`).
 * Shared by main.ts, the e2e harness and the HTTP tests so all run the same setup.
 */
export function setupApp(app: NestExpressApplication): void {
  const config = app.get(AppConfigService);

  attachLogger(app);
  // SIGTERM (k8s) -> onApplicationShutdown hooks -> pg pool closed, in-flight requests done.
  app.enableShutdownHooks();
  // Number of proxy hops to trust for X-Forwarded-For (req.ip feeds rate limiting and logs).
  app.set('trust proxy', config.get('TRUST_PROXY_HOPS'));

  app.use(helmet());
  app.enableCors({ origin: config.get('CORS_ORIGINS'), credentials: true });

  // /api/v1/... by default; a controller can opt into other versions or VERSION_NEUTRAL.
  // Exclusions: well-known URIs served at the root (GET /.well-known/jwks.json).
  app.setGlobalPrefix(GLOBAL_PREFIX, { exclude: [...IDENTITY_PREFIX_EXCLUSIONS] });
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

  // socket.io on the same HTTP server, outside the `api` prefix (a socket.io path, not an Express
  // route): RedisIoAdapter with the handshake checks. Must precede app.init()/listen().
  installRealtimeAdapter(app);

  if (config.get('SWAGGER_ENABLED')) {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('Udemy API').setVersion('1').addBearerAuth().build(),
    );
    // UI at /api/docs, JSON at /api/docs-json (input for packages/api-client codegen).
    SwaggerModule.setup(`${GLOBAL_PREFIX}/docs`, app, document, {
      jsonDocumentUrl: `${GLOBAL_PREFIX}/docs-json`,
    });
  }
}

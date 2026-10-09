import { VersioningType } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { attachLogger } from '@udemy/nest-common';
import helmet from 'helmet';
import { AppConfigService } from './shared/config';

export const GLOBAL_PREFIX = 'api';

/**
 * Everything that configures the HTTP app but is not a module: middleware, prefix,
 * versioning, docs. Shared by main.ts and the HTTP tests so both run the same setup.
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
  app.setGlobalPrefix(GLOBAL_PREFIX);
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });

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

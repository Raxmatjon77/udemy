import { IT_APP_ENV } from '../apply-it-app-env';

/**
 * Side-effect import for the endpoint e2e sweep: everything `apply-it-app-env` does (real
 * Postgres/Redis, a throwaway Ed25519 key), plus Swagger ON, so `/api/docs-json` is served
 * exactly as in production. AppModule validates process.env when it is imported, so import this
 * FIRST:
 *
 *   import { E2E_APP_ENV } from './testing/e2e/apply-e2e-app-env';
 *   import { AppModule } from './app.module';
 */
process.env.SWAGGER_ENABLED = 'true';

export const E2E_APP_ENV = IT_APP_ENV;

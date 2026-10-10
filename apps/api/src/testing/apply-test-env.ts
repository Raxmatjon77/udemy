import { TEST_ENV } from './test-env';

/**
 * Side-effect import for HTTP tests that load AppModule: the config module validates
 * process.env when app.module is imported, so import this FIRST (ES modules evaluate in
 * import order):
 *
 *   import '../../testing/apply-test-env';
 *   import { AppModule } from '../../app.module';
 */
Object.assign(process.env, TEST_ENV, { LOG_LEVEL: 'silent', SWAGGER_ENABLED: 'false' });

import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TEST_APP_EXTRAS, TEST_ENV } from './test-env';

/**
 * Side-effect import for HTTP tests that load AppModule: the config module validates
 * process.env when app.module is imported, so import this FIRST (ES modules evaluate in
 * import order):
 *
 *   import '../../testing/apply-test-env';
 *   import { AppModule } from '../../app.module';
 *
 * AppModule loads the active JWT signing key at boot, so a throwaway Ed25519 key is written to a
 * temp dir. Tests must never depend on a developer's `.secrets/jwt` (CI has none).
 */
const keysDir = mkdtempSync(join(tmpdir(), 'udemy-test-app-'));
const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
writeFileSync(join(keysDir, `${TEST_ENV.JWT_ACTIVE_KID}.pem`), pem, { mode: 0o600 });

Object.assign(process.env, TEST_ENV, TEST_APP_EXTRAS, {
  JWT_KEYS_DIR: keysDir,
  LOG_LEVEL: 'silent',
  SWAGGER_ENABLED: 'false',
});

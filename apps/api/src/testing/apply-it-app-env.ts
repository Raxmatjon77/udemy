import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { itDatabaseUrl, itRedisUrl } from './integration';
import { TEST_ENV } from './test-env';

/**
 * Side-effect import for HTTP tests that boot the REAL AppModule against the integration
 * Postgres/Redis (IT_DATABASE_URL / IT_REDIS_URL). AppModule validates process.env when it is
 * imported, so import this FIRST (ES modules evaluate in import order):
 *
 *   import { IT_APP_ENV } from './testing/apply-it-app-env';
 *   import { AppModule } from './app.module';
 *
 * Generates a throwaway Ed25519 signing key in a temp dir (removed by `cleanupItAppEnv`).
 */
const keysDir = mkdtempSync(join(tmpdir(), 'udemy-it-app-'));
const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
writeFileSync(join(keysDir, `${TEST_ENV.JWT_ACTIVE_KID}.pem`), pem, { mode: 0o600 });

const savedEnv = { ...process.env };
Object.assign(process.env, TEST_ENV, {
  DATABASE_URL: itDatabaseUrl(),
  REDIS_URL: itRedisUrl(),
  JWT_KEYS_DIR: keysDir,
  LOG_LEVEL: 'silent',
  SWAGGER_ENABLED: 'false',
});

export const IT_APP_ENV = { keysDir, savedEnv } as const;

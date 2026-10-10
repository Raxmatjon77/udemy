#!/usr/bin/env node
/**
 * Generates an Ed25519 signing key for access tokens (design §9 "Key management").
 *
 *   pnpm --filter @udemy/api keys:generate [--kid ed25519-YYYY-MM[-suffix]]
 *
 * Writes `<JWT_KEYS_DIR>/<kid>.pem` (PKCS8 PEM, mode 0600; the directory is created with 0700),
 * refuses to overwrite an existing file and prints the kid on stdout.
 *
 * - JWT_KEYS_DIR: from the environment, else apps/api/.env, else the repo .env, else
 *   `./.secrets/jwt`. A relative path resolves against apps/api, like the API config.
 * - kid: `--kid`, else JWT_ACTIVE_KID, else `ed25519-<current UTC year-month>`.
 *
 * Plain Node (no build step), so it runs in CI and containers before the API is compiled.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const API_ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Same format as JWT_ACTIVE_KID in apps/api/src/shared/config/api-env.schema.ts. */
const KID_FORMAT = /^ed25519-\d{4}-(?:0[1-9]|1[0-2])(?:-[a-z0-9]+)?$/;

function fail(message) {
  process.stderr.write(`keys:generate: ${message}\n`);
  process.exit(1);
}

function loadEnvFiles() {
  // process.loadEnvFile never overrides variables that are already set.
  for (const file of [join(API_ROOT_DIR, '.env'), join(API_ROOT_DIR, '..', '..', '.env')]) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
}

function currentMonthKid() {
  const now = new Date();
  return `ed25519-${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function main() {
  const { values } = parseArgs({ options: { kid: { type: 'string' } }, strict: true });
  loadEnvFiles();

  const kid = values.kid ?? process.env.JWT_ACTIVE_KID ?? currentMonthKid();
  if (!KID_FORMAT.test(kid)) fail(`invalid kid "${kid}" (expected ed25519-YYYY-MM[-suffix])`);

  const configured = process.env.JWT_KEYS_DIR ?? './.secrets/jwt';
  const dir = isAbsolute(configured) ? configured : resolve(API_ROOT_DIR, configured);
  const file = join(dir, `${kid}.pem`);

  const { privateKey } = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });

  await mkdir(dir, { recursive: true, mode: 0o700 });
  let handle;
  try {
    // 'wx' = O_CREAT | O_EXCL: never overwrites, even under a race.
    handle = await open(file, 'wx', 0o600);
  } catch (error) {
    if (error && error.code === 'EEXIST') fail(`${file} already exists; refusing to overwrite`);
    throw error;
  }
  try {
    await handle.writeFile(privateKey, 'utf8');
    await handle.chmod(0o600); // in case the umask widened the mode
  } finally {
    await handle.close();
  }

  process.stderr.write(`Wrote ${file}\n`);
  process.stdout.write(`${kid}\n`);
}

main().catch((error) =>
  fail(error instanceof Error ? (error.stack ?? error.message) : String(error)),
);

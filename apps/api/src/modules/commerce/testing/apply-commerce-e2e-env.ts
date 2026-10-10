import { CATALOG_PUBLIC_E2E_ENV } from '../../catalog/testing/apply-catalog-public-e2e-env';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

/**
 * Side-effect import for commerce-b.e2e.spec.ts: the catalog-public e2e env (Postgres, Redis,
 * MinIO, Swagger on, 1-lecture readiness) plus a per-run Stripe test setup (design D12): a
 * throwaway `sk_test_…` key and `whsec_…` secret, and two FREE loopback ports chosen now,
 * one for `apps/stripe-emulator` (started in-process by the spec) and one the spec makes the
 * API listen on, so the emulator delivers signed webhooks to the real HTTP stack.
 *
 * Ports are picked synchronously (AppModule validates the env when it is imported, before any
 * hook could await a listen): a child process binds port 0, prints it and exits. Import FIRST.
 */
function freeLoopbackPort(): number {
  const out = execFileSync(
    process.execPath,
    [
      '-e',
      "const s=require('node:net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close();});",
    ],
    { encoding: 'utf8', timeout: 10_000 },
  );
  const port = Number(out.trim());
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error(`no free port (${out})`);
  return port;
}

const apiPort = freeLoopbackPort();
let emulatorPort = freeLoopbackPort();
while (emulatorPort === apiPort) emulatorPort = freeLoopbackPort();

const secretKey = `sk_test_e2e${randomBytes(12).toString('hex')}`;
const webhookSecret = `whsec_${randomBytes(24).toString('base64url')}`;
const emulatorUrl = `http://127.0.0.1:${emulatorPort}`;

Object.assign(process.env, {
  STRIPE_SECRET_KEY: secretKey,
  STRIPE_WEBHOOK_SECRET: webhookSecret,
  STRIPE_API_BASE_URL: emulatorUrl,
  CHECKOUT_ALLOWED_ORIGINS: emulatorUrl,
});

export const COMMERCE_E2E_ENV = {
  ...CATALOG_PUBLIC_E2E_ENV,
  apiPort,
  emulatorPort,
  emulatorUrl,
  secretKey,
  webhookSecret,
  webhookUrl: `http://127.0.0.1:${apiPort}/api/v1/webhooks/stripe`,
} as const;

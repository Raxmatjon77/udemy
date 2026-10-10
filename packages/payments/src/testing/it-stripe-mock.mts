import { execFile } from 'node:child_process';
import { createServer } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll } from 'vitest';

const exec = promisify(execFile);

/**
 * The stripe-mock contract-test harness (design D12 layer 1). Internal to this package: it is NOT
 * exported from `@udemy/payments/testing` (that entry must stay free of vitest for the emulator)
 * and is excluded from the build.
 *
 * - `IT_STRIPE_MOCK_URL` (e.g. `http://localhost:12111`, the CI service container) is probed first.
 * - Locally, when it is unset or unreachable, ONE container of the pinned image is started on a
 *   free loopback port (`docker run --rm -d`) and stopped in afterAll. Only that container id is
 *   ever stopped. No Docker → the tests SKIP with a clear message.
 * - With `CI=true` nothing is started and an unreachable stripe-mock FAILS.
 * - Something that answers but is not stripe-mock (no `Stripe-Mock-Version` header, e.g. the
 *   emulator on 12111) always FAILS: never contract-test against the wrong server.
 */
export const STRIPE_MOCK_IMAGE = 'stripe/stripe-mock:v0.206.0';
export const STRIPE_MOCK_VERSION = '0.206.0';
/** stripe-mock wants `sk_test_` + alphanumerics (underscores after the prefix → 401). */
export const STRIPE_MOCK_API_KEY = 'sk_test_123';
const READY_TIMEOUT_MS = 30_000;
const DOCKER_RUN_TIMEOUT_MS = 150_000;

export function isCi(): boolean {
  return process.env.CI === 'true';
}

export interface SkippableContext {
  skip(condition: boolean, note?: string): void;
}

export interface IntegrationStripeMock {
  /** Throws when stripe-mock is unavailable. */
  readonly baseUrl: string;
  /** The `Stripe-Mock-Version` the server reported. */
  readonly version: string | undefined;
  readonly unavailableReason: string | undefined;
  skipIfUnavailable(ctx: SkippableContext): void;
}

type ProbeResult = { kind: 'ok'; version: string } | { kind: 'unreachable'; error: unknown };

async function probe(baseUrl: string): Promise<ProbeResult> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/v1/charges?limit=1`, {
      headers: { authorization: `Bearer ${STRIPE_MOCK_API_KEY}` },
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    return { kind: 'unreachable', error };
  }
  const version = response.headers.get('stripe-mock-version');
  await response.body?.cancel();
  if (version === null || !response.ok) {
    throw new Error(
      `[integration] ${baseUrl} answered HTTP ${response.status} without a Stripe-Mock-Version ` +
        `header: it is not stripe-mock (the stripe-emulator also defaults to port 12111).`,
    );
  }
  return { kind: 'ok', version };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });
}

async function waitUntilReady(baseUrl: string): Promise<string> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  for (;;) {
    const result = await probe(baseUrl);
    if (result.kind === 'ok') return result.version;
    if (Date.now() > deadline) {
      throw new Error(`[integration] started stripe-mock at ${baseUrl} never became ready`, {
        cause: result.error,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Registers beforeAll/afterAll hooks: find or start stripe-mock, stop what we started. */
export function useStripeMock(): IntegrationStripeMock {
  let baseUrl: string | undefined;
  let version: string | undefined;
  let containerId: string | undefined;
  let reason: string | undefined = 'not connected yet (used outside a test?)';

  beforeAll(async () => {
    const configured = process.env.IT_STRIPE_MOCK_URL?.trim().replace(/\/+$/, '');
    if (configured !== undefined && configured !== '') {
      const result = await probe(configured);
      if (result.kind === 'ok') {
        baseUrl = configured;
        version = result.version;
        reason = undefined;
        return;
      }
      if (isCi()) {
        throw new Error(
          `[integration] stripe-mock at IT_STRIPE_MOCK_URL=${configured} is unreachable. ` +
            `CI=true: contract tests must not be skipped.`,
          { cause: result.error },
        );
      }
    } else if (isCi()) {
      throw new Error(
        '[integration] IT_STRIPE_MOCK_URL is not set. CI=true: run the stripe-mock service ' +
          `(${STRIPE_MOCK_IMAGE}) and set it; contract tests must not be skipped.`,
      );
    }

    // Local fallback: start exactly one container of the pinned image.
    const port = await freePort();
    try {
      const { stdout } = await exec(
        'docker',
        [
          'run',
          '--rm',
          '-d',
          '--label',
          'udemy.payments.it=stripe-mock',
          '-p',
          `127.0.0.1:${port}:12111`,
          STRIPE_MOCK_IMAGE,
        ],
        { timeout: DOCKER_RUN_TIMEOUT_MS },
      );
      containerId = stdout.trim();
    } catch (error) {
      const why =
        `stripe-mock is not reachable (set IT_STRIPE_MOCK_URL) and starting ${STRIPE_MOCK_IMAGE} ` +
        `with Docker failed (${error instanceof Error ? error.message.split('\n')[0] : String(error)}).`;
      process.stderr.write(`[integration] ${why} Skipping the contract tests.\n`);
      reason = why;
      return;
    }
    const url = `http://127.0.0.1:${port}`;
    version = await waitUntilReady(url);
    baseUrl = url;
    reason = undefined;
  });

  afterAll(async () => {
    if (containerId === undefined) return;
    const id = containerId;
    containerId = undefined;
    // --rm removes it once stopped. Stop ONLY the container this harness started.
    await exec('docker', ['stop', '-t', '2', id], { timeout: 30_000 }).catch((error: unknown) => {
      process.stderr.write(`[integration] could not stop stripe-mock ${id}: ${String(error)}\n`);
    });
  });

  return {
    get baseUrl(): string {
      if (baseUrl === undefined || reason !== undefined) {
        throw new Error(`[integration] stripe-mock is not available: ${reason ?? 'not connected'}`);
      }
      return baseUrl;
    },
    get version(): string | undefined {
      return version;
    },
    get unavailableReason(): string | undefined {
      return reason;
    },
    skipIfUnavailable(ctx: SkippableContext): void {
      ctx.skip(reason !== undefined, reason);
    },
  };
}

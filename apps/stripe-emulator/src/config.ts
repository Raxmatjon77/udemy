/**
 * Emulator configuration. The env names match `infra/docker/docker-compose.dev.yml` (service
 * `stripe-emulator`): PORT, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, EMULATOR_WEBHOOK_URL,
 * EMULATOR_PUBLIC_URL. Everything else is optional tuning with test-friendly defaults.
 */
export interface EmulatorConfig {
  /** The only API key accepted as `Authorization: Bearer …` (`STRIPE_SECRET_KEY`). */
  readonly secretKey: string;
  /** Signs webhook deliveries (`STRIPE_WEBHOOK_SECRET`, `whsec_…`). */
  readonly webhookSecret: string;
  /** Where signed events are POSTed; null stores events without delivering them. */
  readonly webhookUrl: string | null;
  /**
   * Origin of the hosted pay page as the browser sees it (session.url = `${publicUrl}/pay/{id}`).
   * Null → the address the server is listening on.
   */
  readonly publicUrl: string | null;
  /** `/_emulator/*` control API (`EMULATOR_CONTROL_ENABLED`, default true: dev/CI tool). */
  readonly controlEnabled: boolean;
  /** Delivery attempts per event, the first one included (`EMULATOR_WEBHOOK_MAX_ATTEMPTS`). */
  readonly webhookMaxAttempts: number;
  /** First retry delay; doubles per attempt (`EMULATOR_WEBHOOK_RETRY_BASE_MS`). */
  readonly webhookRetryBaseMs: number;
  /** Retry delay cap (`EMULATOR_WEBHOOK_RETRY_MAX_MS`). */
  readonly webhookRetryMaxMs: number;
  /** Per-attempt request timeout (`EMULATOR_WEBHOOK_TIMEOUT_MS`). */
  readonly webhookTimeoutMs: number;
  /** How often open sessions past `expires_at` are expired (`EMULATOR_EXPIRY_SWEEP_MS`). */
  readonly expirySweepMs: number;
}

export interface ListenConfig {
  readonly port: number;
  readonly host: string;
}

export class EmulatorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmulatorConfigError';
  }
}

export const DEFAULT_PORT = 12111;

export const DEFAULTS = {
  controlEnabled: true,
  webhookMaxAttempts: 5,
  webhookRetryBaseMs: 1_000,
  webhookRetryMaxMs: 60_000,
  webhookTimeoutMs: 10_000,
  expirySweepMs: 1_000,
} as const;

type Env = Readonly<Record<string, string | undefined>>;

const SECRET_KEY = /^sk_test_[A-Za-z0-9_]+$/;

function optional(env: Env, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function required(env: Env, name: string): string {
  const value = optional(env, name);
  if (value === undefined) throw new EmulatorConfigError(`${name} is required`);
  return value;
}

function integer(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new EmulatorConfigError(`${name} must be an integer in ${min}..${max}, got "${raw}"`);
  }
  return value;
}

function boolean(env: Env, name: string, fallback: boolean): boolean {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new EmulatorConfigError(`${name} must be "true" or "false", got "${raw}"`);
}

/** An http(s) URL without credentials; `origin` strips any path (for the public URL). */
export function parseHttpUrl(value: string, what: string, origin = false): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new EmulatorConfigError(`${what} "${value}" is not a URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EmulatorConfigError(`${what} must be http(s)`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new EmulatorConfigError(`${what} must not contain credentials`);
  }
  if (origin) {
    if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '') {
      throw new EmulatorConfigError(`${what} must be an origin (no path, query or fragment)`);
    }
    return url.origin;
  }
  return url.toString();
}

export function validateEmulatorConfig(config: EmulatorConfig): EmulatorConfig {
  if (!SECRET_KEY.test(config.secretKey)) {
    throw new EmulatorConfigError('STRIPE_SECRET_KEY must be an sk_test_… key');
  }
  if (!config.webhookSecret.startsWith('whsec_') || config.webhookSecret.length < 12) {
    throw new EmulatorConfigError('STRIPE_WEBHOOK_SECRET must be a whsec_… secret');
  }
  return {
    ...config,
    webhookUrl:
      config.webhookUrl === null ? null : parseHttpUrl(config.webhookUrl, 'EMULATOR_WEBHOOK_URL'),
    publicUrl:
      config.publicUrl === null
        ? null
        : parseHttpUrl(config.publicUrl, 'EMULATOR_PUBLIC_URL', true),
  };
}

/** Builds a config from defaults + overrides (tests and in-process use). */
export function emulatorConfig(
  overrides: Pick<EmulatorConfig, 'secretKey' | 'webhookSecret'> & Partial<EmulatorConfig>,
): EmulatorConfig {
  return validateEmulatorConfig({
    webhookUrl: null,
    publicUrl: null,
    ...DEFAULTS,
    ...overrides,
  });
}

export function emulatorConfigFromEnv(env: Env = process.env): EmulatorConfig {
  return emulatorConfig({
    secretKey: required(env, 'STRIPE_SECRET_KEY'),
    webhookSecret: required(env, 'STRIPE_WEBHOOK_SECRET'),
    webhookUrl: optional(env, 'EMULATOR_WEBHOOK_URL') ?? null,
    publicUrl: optional(env, 'EMULATOR_PUBLIC_URL') ?? null,
    controlEnabled: boolean(env, 'EMULATOR_CONTROL_ENABLED', DEFAULTS.controlEnabled),
    webhookMaxAttempts: integer(
      env,
      'EMULATOR_WEBHOOK_MAX_ATTEMPTS',
      DEFAULTS.webhookMaxAttempts,
      1,
      50,
    ),
    webhookRetryBaseMs: integer(
      env,
      'EMULATOR_WEBHOOK_RETRY_BASE_MS',
      DEFAULTS.webhookRetryBaseMs,
      0,
      3_600_000,
    ),
    webhookRetryMaxMs: integer(
      env,
      'EMULATOR_WEBHOOK_RETRY_MAX_MS',
      DEFAULTS.webhookRetryMaxMs,
      0,
      3_600_000,
    ),
    webhookTimeoutMs: integer(
      env,
      'EMULATOR_WEBHOOK_TIMEOUT_MS',
      DEFAULTS.webhookTimeoutMs,
      1,
      120_000,
    ),
    expirySweepMs: integer(env, 'EMULATOR_EXPIRY_SWEEP_MS', DEFAULTS.expirySweepMs, 10, 3_600_000),
  });
}

export function listenConfigFromEnv(env: Env = process.env): ListenConfig {
  return {
    port: integer(env, 'PORT', DEFAULT_PORT, 0, 65_535),
    // 0.0.0.0 inside the container (compose publishes it on host loopback only).
    host: optional(env, 'HOST') ?? '0.0.0.0',
  };
}

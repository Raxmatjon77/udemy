import { describe, expect, it } from 'vitest';
import {
  DEFAULTS,
  emulatorConfigFromEnv,
  EmulatorConfigError,
  listenConfigFromEnv,
} from './config';

const BASE = {
  STRIPE_SECRET_KEY: 'sk_test_emulator_dev',
  STRIPE_WEBHOOK_SECRET: 'whsec_dev_emulator_change_me_0000000000000000',
};

describe('emulatorConfigFromEnv', () => {
  it('reads the compose env names', () => {
    const config = emulatorConfigFromEnv({
      ...BASE,
      EMULATOR_WEBHOOK_URL: 'http://host.docker.internal:4000/api/v1/webhooks/stripe',
      EMULATOR_PUBLIC_URL: 'http://127.0.0.1:12111',
    });
    expect(config).toEqual({
      secretKey: BASE.STRIPE_SECRET_KEY,
      webhookSecret: BASE.STRIPE_WEBHOOK_SECRET,
      webhookUrl: 'http://host.docker.internal:4000/api/v1/webhooks/stripe',
      publicUrl: 'http://127.0.0.1:12111',
      ...DEFAULTS,
    });
  });

  it('enables the control API unless EMULATOR_CONTROL_ENABLED=false', () => {
    expect(emulatorConfigFromEnv(BASE).controlEnabled).toBe(true);
    expect(
      emulatorConfigFromEnv({ ...BASE, EMULATOR_CONTROL_ENABLED: 'true' }).controlEnabled,
    ).toBe(true);
    expect(
      emulatorConfigFromEnv({ ...BASE, EMULATOR_CONTROL_ENABLED: 'false' }).controlEnabled,
    ).toBe(false);
    expect(() => emulatorConfigFromEnv({ ...BASE, EMULATOR_CONTROL_ENABLED: 'yes' })).toThrow(
      EmulatorConfigError,
    );
  });

  it('treats a missing webhook URL as "store, do not deliver"', () => {
    expect(emulatorConfigFromEnv(BASE).webhookUrl).toBeNull();
  });

  it.each([
    [{ STRIPE_SECRET_KEY: undefined }, /STRIPE_SECRET_KEY is required/],
    [{ STRIPE_SECRET_KEY: 'sk_live_abc' }, /sk_test_/],
    [{ STRIPE_WEBHOOK_SECRET: 'not-a-secret' }, /whsec_/],
    [{ EMULATOR_WEBHOOK_URL: 'ftp://x' }, /http\(s\)/],
    [{ EMULATOR_PUBLIC_URL: 'http://127.0.0.1:12111/pay' }, /origin/],
    [{ EMULATOR_WEBHOOK_MAX_ATTEMPTS: '0' }, /1\.\.50/],
    [{ EMULATOR_WEBHOOK_RETRY_BASE_MS: '1.5' }, /integer/],
  ])('rejects %j', (patch, message) => {
    expect(() => emulatorConfigFromEnv({ ...BASE, ...patch })).toThrow(message);
  });
});

describe('listenConfigFromEnv', () => {
  it('defaults to 0.0.0.0:12111 and reads PORT', () => {
    expect(listenConfigFromEnv({})).toEqual({ port: 12111, host: '0.0.0.0' });
    expect(listenConfigFromEnv({ PORT: '4242', HOST: '127.0.0.1' })).toEqual({
      port: 4242,
      host: '127.0.0.1',
    });
    expect(() => listenConfigFromEnv({ PORT: '70000' })).toThrow(EmulatorConfigError);
  });
});

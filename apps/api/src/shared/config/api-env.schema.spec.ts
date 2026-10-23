import { join } from 'node:path';
import { EnvValidationError, validateEnv } from '@udemy/nest-common';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_SECRETS, TEST_ENV } from '../../testing/test-env';
import { apiEnvSchema } from './api-env.schema';
import { API_ROOT_DIR } from './api-root-dir';

const validEnv: Record<string, string> = { ...TEST_ENV };

describe('apiEnvSchema', () => {
  it('applies defaults to a minimal valid env', () => {
    const env = validateEnv(apiEnvSchema, validEnv);

    expect(env).toMatchObject({
      NODE_ENV: 'development',
      LOG_LEVEL: 'info',
      PORT: 4000,
      CORS_ORIGINS: [],
      SWAGGER_ENABLED: true,
    });
  });

  it('parses typed values from strings', () => {
    const env = validateEnv(apiEnvSchema, {
      ...validEnv,
      PORT: '8080',
      CORS_ORIGINS: 'http://localhost:3000, http://localhost:3001',
      SWAGGER_ENABLED: 'false',
    });

    expect(env.PORT).toBe(8080);
    expect(env.CORS_ORIGINS).toEqual(['http://localhost:3000', 'http://localhost:3001']);
    expect(env.SWAGGER_ENABLED).toBe(false);
  });

  it('rejects a missing DATABASE_URL', () => {
    const env = { ...validEnv };
    delete env.DATABASE_URL;
    expect(() => validateEnv(apiEnvSchema, env)).toThrow(EnvValidationError);
  });

  it.each([
    ['DATABASE_URL', 'mysql://localhost/udemy'],
    ['PORT', 'not-a-number'],
    ['PORT', '70000'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['CORS_ORIGINS', 'http://ok.example,not a url'],
    ['REDIS_URL', 'http://localhost:6379'],
    ['API_PUBLIC_URL', 'localhost:4000'],
    ['JWT_AUDIENCE', ' '],
    ['JWT_ACTIVE_KID', 'rsa-2026-10'],
    ['JWT_ACTIVE_KID', 'ed25519-2026-13'],
    ['JWT_ACTIVE_KID', 'ed25519-2026-10/../../x'],
    ['REFRESH_TOKEN_PEPPER', 'short'],
    ['LOGIN_EMAIL_HMAC_KEY', 'x'.repeat(31)],
    [
      'CLIENT_STUDENT_SECRET_HASH',
      'A53F56679C9A171D127E55EE0D0A5B4A37C713317C0C21A6144F26C4044EC441',
    ],
    ['CLIENT_INSTRUCTOR_SECRET_HASH', 'abc123'],
    ['CLIENT_ADMIN_SECRET_HASH', `${'0'.repeat(63)}g`],
    ['S3_ENDPOINT', 'localhost:9000'],
    ['S3_ENDPOINT', 'http://minio:9000/bucket'],
    ['S3_PUBLIC_ENDPOINT', 'ftp://127.0.0.1:9000'],
    ['S3_BUCKET_MEDIA', 'Bad_Bucket'],
    ['S3_FORCE_PATH_STYLE', 'maybe'],
    ['MEDIA_PART_URL_TTL_S', '0'],
    ['MEDIA_PLAYBACK_URL_TTL_S', '604801'],
    ['MEDIA_MAX_VIDEO_BYTES', '0'],
    ['MEDIA_MAX_CONCURRENT_UPLOADS', '0'],
  ])('rejects an invalid %s (%s) and names the variable', (key, value) => {
    const run = (): unknown => validateEnv(apiEnvSchema, { ...validEnv, [key]: value });

    expect(run).toThrow(EnvValidationError);
    expect(run).toThrow(new RegExp(key));
  });

  it.each(Object.keys(TEST_ENV).filter((key) => key !== 'JWT_KEYS_DIR'))('requires %s', (key) => {
    const env = { ...validEnv };
    delete env[key];
    expect(() => validateEnv(apiEnvSchema, env)).toThrow(new RegExp(key));
  });

  it('resolves a relative JWT_KEYS_DIR against apps/api and keeps an absolute one', () => {
    expect(validateEnv(apiEnvSchema, validEnv).JWT_KEYS_DIR).toBe(
      join(API_ROOT_DIR, '.secrets', 'jwt'),
    );
    expect(API_ROOT_DIR.endsWith(join('apps', 'api'))).toBe(true);
    expect(
      validateEnv(apiEnvSchema, { ...validEnv, JWT_KEYS_DIR: '/etc/udemy/jwt' }).JWT_KEYS_DIR,
    ).toBe('/etc/udemy/jwt');
  });

  it('accepts a same-month emergency kid', () => {
    expect(
      validateEnv(apiEnvSchema, { ...validEnv, JWT_ACTIVE_KID: 'ed25519-2026-10-b' })
        .JWT_ACTIVE_KID,
    ).toBe('ed25519-2026-10-b');
  });

  it('refuses identical client secret hashes (app confinement)', () => {
    expect(() =>
      validateEnv(apiEnvSchema, {
        ...validEnv,
        CLIENT_ADMIN_SECRET_HASH: TEST_ENV.CLIENT_STUDENT_SECRET_HASH,
      }),
    ).toThrow(/CLIENT_ADMIN_SECRET_HASH/);
  });

  it('applies the media defaults and parses large byte counts', () => {
    const env = validateEnv(apiEnvSchema, validEnv);
    expect(env).toMatchObject({
      S3_FORCE_PATH_STYLE: true,
      MEDIA_PART_URL_TTL_S: 900,
      MEDIA_PLAYBACK_URL_TTL_S: 3600,
      MEDIA_IMAGE_URL_TTL_S: 3600,
      MEDIA_DOWNLOAD_URL_TTL_S: 300,
      MEDIA_MAX_VIDEO_BYTES: 4 * 1024 ** 3,
      MEDIA_MAX_IMAGE_BYTES: 5 * 1024 ** 2,
      MEDIA_MAX_RESOURCE_BYTES: 100 * 1024 ** 2,
      MEDIA_QUOTA_BYTES_PER_OWNER: 100 * 1024 ** 3,
      MEDIA_MAX_CONCURRENT_UPLOADS: 5,
    });
    expect(env.S3_PUBLIC_ENDPOINT).toBeUndefined();
    expect(
      validateEnv(apiEnvSchema, { ...validEnv, MEDIA_QUOTA_BYTES_PER_OWNER: '10737418240' })
        .MEDIA_QUOTA_BYTES_PER_OWNER,
    ).toBe(10_737_418_240);
  });

  it('refuses one bucket for both roles', () => {
    expect(() =>
      validateEnv(apiEnvSchema, { ...validEnv, S3_BUCKET_MEDIA: TEST_ENV.S3_BUCKET_UPLOADS }),
    ).toThrow(/S3_BUCKET_MEDIA/);
  });

  it('refuses a pepper equal to the login HMAC key', () => {
    expect(() =>
      validateEnv(apiEnvSchema, {
        ...validEnv,
        LOGIN_EMAIL_HMAC_KEY: TEST_ENV.REFRESH_TOKEN_PEPPER,
      }),
    ).toThrow(/LOGIN_EMAIL_HMAC_KEY/);
  });

  describe('in production', () => {
    const production = { ...validEnv, ...PRODUCTION_SECRETS, NODE_ENV: 'production' };

    it('accepts real secrets', () => {
      expect(() => validateEnv(apiEnvSchema, production)).not.toThrow();
    });

    it.each([
      'REFRESH_TOKEN_PEPPER',
      'LOGIN_EMAIL_HMAC_KEY',
      'NOTIFICATIONS_UNSUBSCRIBE_SECRET',
    ] as const)('refuses the change-me placeholder in %s', (key) => {
      expect(() => validateEnv(apiEnvSchema, { ...production, [key]: TEST_ENV[key] })).toThrow(
        new RegExp(key),
      );
    });

    it.each([
      'CLIENT_STUDENT_SECRET_HASH',
      'CLIENT_INSTRUCTOR_SECRET_HASH',
      'CLIENT_ADMIN_SECRET_HASH',
    ] as const)('refuses the dev hash in %s', (key) => {
      expect(() => validateEnv(apiEnvSchema, { ...production, [key]: TEST_ENV[key] })).toThrow(
        new RegExp(key),
      );
    });
  });

  describe('payments and commerce (Phase 4 §9, §13)', () => {
    it('applies the commerce defaults; STRIPE_API_BASE_URL and CHECKOUT_ALLOWED_ORIGINS are optional', () => {
      const env = validateEnv(apiEnvSchema, validEnv);
      expect(env).toMatchObject({
        PAYMENTS_PROVIDER: 'stripe',
        STRIPE_WEBHOOK_TOLERANCE_S: 300,
        COMMERCE_CURRENCY: 'USD',
        COMMERCE_REFUND_WINDOW_DAYS: 30,
        COMMERCE_INSTRUCTOR_SHARE_BPS: 7000,
        COMMERCE_CHECKOUT_SESSION_TTL_MIN: 35,
        COMMERCE_CART_MAX_ITEMS: 20,
        COMMERCE_JOBS_ENABLED: true,
        COMMERCE_RECONCILE_INTERVAL_MS: 300_000,
      });
      expect(env.STRIPE_API_BASE_URL).toBeUndefined();
      expect(env.CHECKOUT_ALLOWED_ORIGINS).toBeUndefined();
      expect(
        validateEnv(apiEnvSchema, {
          ...validEnv,
          CHECKOUT_ALLOWED_ORIGINS: 'https://checkout.stripe.com, http://127.0.0.1:12111',
        }).CHECKOUT_ALLOWED_ORIGINS,
      ).toEqual(['https://checkout.stripe.com', 'http://127.0.0.1:12111']);
    });

    it.each([
      ['STRIPE_SECRET_KEY', 'sk_live_abc123'],
      ['STRIPE_SECRET_KEY', 'rk_live_abc123'],
      ['STRIPE_SECRET_KEY', 'pk_test_abc123'],
      ['STRIPE_WEBHOOK_SECRET', 'not-a-whsec'],
      ['STRIPE_API_BASE_URL', 'http://127.0.0.1:12111/v1'],
      ['STRIPE_API_VERSION', '2020-08-27'],
      ['STRIPE_WEBHOOK_TOLERANCE_S', '0'],
      ['STUDENT_APP_ORIGIN', 'http://localhost:3000/app'],
      ['CHECKOUT_ALLOWED_ORIGINS', 'ftp://x.example'],
      ['COMMERCE_CURRENCY', 'EUR'],
      ['COMMERCE_CHECKOUT_SESSION_TTL_MIN', '30'],
      ['COMMERCE_INSTRUCTOR_SHARE_BPS', '10001'],
      ['COMMERCE_CART_MAX_ITEMS', '21'],
    ])('rejects %s=%s', (key, value) => {
      expect(() => validateEnv(apiEnvSchema, { ...validEnv, [key]: value })).toThrow(
        new RegExp(key),
      );
    });

    it('refuses the dev emulator key and secret in production', () => {
      const production = { ...validEnv, ...PRODUCTION_SECRETS, NODE_ENV: 'production' };
      for (const [key, value] of [
        ['STRIPE_SECRET_KEY', 'sk_test_emulator_dev'],
        ['STRIPE_WEBHOOK_SECRET', 'whsec_dev_emulator_change_me_0000000000000000'],
      ] as const) {
        expect(() => validateEnv(apiEnvSchema, { ...production, [key]: value })).toThrow(
          new RegExp(key),
        );
      }
    });
  });

  describe('learning, engagement, notifications and realtime (Phase 5 §9, §14)', () => {
    it('applies the design defaults', () => {
      expect(validateEnv(apiEnvSchema, validEnv)).toMatchObject({
        COMMERCE_REFUND_REVIEW_CONSUMED_PCT: 30,
        LEARNING_PROGRESS_STORE: 'redis',
        LEARNING_JOBS_ENABLED: true,
        LEARNING_PROGRESS_FLUSH_INTERVAL_MS: 15_000,
        LEARNING_PROGRESS_FLUSH_BATCH_SIZE: 500,
        LEARNING_COVERAGE_BUCKET_S: 5,
        LEARNING_VIDEO_COMPLETE_PCT: 90,
        ENGAGEMENT_AUTO_HIDE_REPORTS: 3,
      });
    });

    it('parses the realtime origins', () => {
      const env = validateEnv(apiEnvSchema, {
        ...validEnv,
        REALTIME_PUBLIC_URL: 'https://api.udemy.example',
        REALTIME_ALLOWED_ORIGINS: 'https://udemy.example, https://instructor.udemy.example',
        LEARNING_PROGRESS_STORE: 'direct',
      });
      expect(env.REALTIME_PUBLIC_URL).toBe('https://api.udemy.example');
      expect(env.REALTIME_ALLOWED_ORIGINS).toEqual([
        'https://udemy.example',
        'https://instructor.udemy.example',
      ]);
      expect(env.LEARNING_PROGRESS_STORE).toBe('direct');
    });

    it.each([
      ['COMMERCE_REFUND_REVIEW_CONSUMED_PCT', '101'],
      ['COMMERCE_REFUND_REVIEW_CONSUMED_PCT', '-1'],
      ['LEARNING_PROGRESS_STORE', 'memory'],
      ['LEARNING_JOBS_ENABLED', 'maybe'],
      ['LEARNING_PROGRESS_FLUSH_INTERVAL_MS', '999'],
      ['LEARNING_PROGRESS_FLUSH_BATCH_SIZE', '0'],
      ['LEARNING_COVERAGE_BUCKET_S', '0'],
      ['LEARNING_COVERAGE_BUCKET_S', '61'],
      ['LEARNING_VIDEO_COMPLETE_PCT', '0'],
      ['LEARNING_VIDEO_COMPLETE_PCT', '101'],
      ['LEARNING_VIDEO_COMPLETE_PCT', '0.9'],
      ['ENGAGEMENT_AUTO_HIDE_REPORTS', '0'],
      ['NOTIFICATIONS_UNSUBSCRIBE_SECRET', 'x'.repeat(31)],
      ['REALTIME_PUBLIC_URL', 'ws://localhost:4000'],
      ['REALTIME_PUBLIC_URL', 'http://localhost:4000/realtime/socket.io'],
      ['REALTIME_PUBLIC_URL', 'http://user:pw@localhost:4000'],
      ['REALTIME_ALLOWED_ORIGINS', ''],
      ['REALTIME_ALLOWED_ORIGINS', ' , '],
      ['REALTIME_ALLOWED_ORIGINS', 'http://localhost:3000,*'],
      ['REALTIME_ALLOWED_ORIGINS', 'http://localhost:3000/app'],
    ])('rejects %s=%j', (key, value) => {
      expect(() => validateEnv(apiEnvSchema, { ...validEnv, [key]: value })).toThrow(
        new RegExp(key),
      );
    });

    it.each(['REFRESH_TOKEN_PEPPER', 'LOGIN_EMAIL_HMAC_KEY'] as const)(
      'refuses an unsubscribe secret equal to %s',
      (key) => {
        expect(() =>
          validateEnv(apiEnvSchema, {
            ...validEnv,
            NOTIFICATIONS_UNSUBSCRIBE_SECRET: validEnv[key],
          }),
        ).toThrow(/NOTIFICATIONS_UNSUBSCRIBE_SECRET/);
      },
    );
  });

  it('never echoes variable values in the error message', () => {
    const secret = 'postgres-but-wrong://user:S3cret@host/db';

    expect(() => validateEnv(apiEnvSchema, { ...validEnv, DATABASE_URL: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('S3cret') }),
    );
    expect(() =>
      validateEnv(apiEnvSchema, {
        ...validEnv,
        NODE_ENV: 'production',
        ...PRODUCTION_SECRETS,
        REFRESH_TOKEN_PEPPER: 'my-pepper-change-me-xxxxxxxxxxxxxxxxx',
      }),
    ).toThrow(expect.objectContaining({ message: expect.not.stringContaining('my-pepper') }));
  });
});

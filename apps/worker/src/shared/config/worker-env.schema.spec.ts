import { EnvValidationError, validateEnv } from '@udemy/nest-common';
import { describe, expect, it } from 'vitest';
import { workerEnvSchema } from './worker-env.schema';

const validEnv = {
  DATABASE_URL: 'postgres://udemy:udemy@localhost:5432/udemy',
  KAFKA_BROKERS: 'localhost:9092',
  EMAIL_TOKEN_SECRET: 'dev-email-token-secret-change-me-in-prod-0000',
  SMTP_HOST: 'localhost',
  SMTP_PORT: '1025',
  MAIL_FROM: 'Udemy Clone <no-reply@udemy.local>',
  STUDENT_APP_ORIGIN: 'http://localhost:3000',
  INSTRUCTOR_APP_ORIGIN: 'http://localhost:3001',
  ADMIN_APP_ORIGIN: 'http://localhost:3002',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_ACCESS_KEY: 'minio',
  S3_SECRET_KEY: 'minio12345',
  S3_BUCKET_UPLOADS: 'udemy-uploads',
  S3_BUCKET_MEDIA: 'udemy-media',
  REDIS_URL: 'redis://localhost:6379',
  NOTIFICATIONS_UNSUBSCRIBE_SECRET: 'dev-notifications-unsubscribe-secret-change-me-0000',
};

/** Production-safe replacements for the dev placeholders above. */
const productionSecrets = {
  EMAIL_TOKEN_SECRET: 'a'.repeat(44),
  NOTIFICATIONS_UNSUBSCRIBE_SECRET: 'b'.repeat(44),
};

describe('workerEnvSchema (Phase 1 variables)', () => {
  it('accepts the .env.example values in development', () => {
    const env = validateEnv(workerEnvSchema, validEnv);

    expect(env).toMatchObject({
      SMTP_PORT: 1025,
      MAIL_FROM: 'Udemy Clone <no-reply@udemy.local>',
      STUDENT_APP_ORIGIN: 'http://localhost:3000',
    });
  });

  it.each([
    ['EMAIL_TOKEN_SECRET', 'too-short'],
    ['SMTP_PORT', '0'],
    ['MAIL_FROM', 'not an address'],
    ['STUDENT_APP_ORIGIN', 'http://localhost:3000/'],
    ['INSTRUCTOR_APP_ORIGIN', 'http://localhost:3001/app'],
    ['ADMIN_APP_ORIGIN', 'ftp://localhost'],
  ])('rejects an invalid %s (%s)', (key, value) => {
    const run = (): unknown => validateEnv(workerEnvSchema, { ...validEnv, [key]: value });

    expect(run).toThrow(EnvValidationError);
    expect(run).toThrow(new RegExp(key));
  });

  it.each(['EMAIL_TOKEN_SECRET', 'SMTP_HOST', 'MAIL_FROM', 'ADMIN_APP_ORIGIN'])(
    'requires %s',
    (key) => {
      const env: Record<string, string> = { ...validEnv };
      delete env[key];
      expect(() => validateEnv(workerEnvSchema, env)).toThrow(new RegExp(key));
    },
  );

  it('refuses the change-me placeholder secret in production', () => {
    const run = (): unknown =>
      validateEnv(workerEnvSchema, { ...validEnv, NODE_ENV: 'production' });

    expect(run).toThrow(/EMAIL_TOKEN_SECRET/);
    expect(() =>
      validateEnv(workerEnvSchema, {
        ...validEnv,
        ...productionSecrets,
        NODE_ENV: 'production',
      }),
    ).not.toThrow();
  });
});

describe('workerEnvSchema (Phase 2 storage and media cleanup)', () => {
  it('applies the design defaults (A-D, batches, S3 path style)', () => {
    const env = validateEnv(workerEnvSchema, validEnv);
    expect(env).toMatchObject({
      S3_FORCE_PATH_STYLE: true,
      MEDIA_CLEANUP_ENABLED: true,
      MEDIA_CLEANUP_INTERVAL_MS: 3_600_000,
      MEDIA_CLEANUP_INITIAL_DELAY_MS: 120_000,
      MEDIA_CLEANUP_BATCH_SIZE: 100,
      MEDIA_CLEANUP_MAX_BATCHES_PER_RUN: 50,
      MEDIA_UPLOAD_TTL_HOURS: 24,
      MEDIA_UNATTACHED_GRACE_HOURS: 24,
      MEDIA_UNUSED_GRACE_DAYS: 7,
      MEDIA_SOURCE_RETENTION_DAYS: 7,
      TRANSCODER_MAX_ATTEMPTS: 3,
    });
  });

  it('accepts the .env.example media values (dev retention of 1 day, path style off)', () => {
    const env = validateEnv(workerEnvSchema, {
      ...validEnv,
      S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:9000',
      S3_FORCE_PATH_STYLE: 'false',
      MEDIA_CLEANUP_ENABLED: 'false',
      MEDIA_SOURCE_RETENTION_DAYS: '1',
      TRANSCODER_MAX_ATTEMPTS: '3',
    });
    expect(env).toMatchObject({
      S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:9000',
      S3_FORCE_PATH_STYLE: false,
      MEDIA_CLEANUP_ENABLED: false,
      MEDIA_SOURCE_RETENTION_DAYS: 1,
      TRANSCODER_MAX_ATTEMPTS: 3,
    });
  });

  it.each([
    ['S3_ENDPOINT', 'ftp://localhost:9000'],
    ['S3_ENDPOINT', 'http://localhost:9000/bucket'],
    ['S3_BUCKET_UPLOADS', 'Bad_Bucket'],
    ['MEDIA_CLEANUP_BATCH_SIZE', '0'],
    ['MEDIA_CLEANUP_INTERVAL_MS', '1000'],
    ['MEDIA_UPLOAD_TTL_HOURS', '0'],
    ['MEDIA_UNUSED_GRACE_DAYS', '4000'],
    ['MEDIA_SOURCE_RETENTION_DAYS', '-1'],
    ['TRANSCODER_MAX_ATTEMPTS', '0'],
    ['TRANSCODER_MAX_ATTEMPTS', '11'],
  ])('rejects an invalid %s (%s)', (key, value) => {
    expect(() => validateEnv(workerEnvSchema, { ...validEnv, [key]: value })).toThrow(
      new RegExp(key),
    );
  });

  it.each(['S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKET_MEDIA'])(
    'requires %s',
    (key) => {
      const env: Record<string, string> = { ...validEnv };
      delete env[key];
      expect(() => validateEnv(workerEnvSchema, env)).toThrow(new RegExp(key));
    },
  );
});

describe('workerEnvSchema (Phase 3 event pipeline operations)', () => {
  it('applies the defaults (retention 72 h / 30 days, connector check off)', () => {
    const env = validateEnv(workerEnvSchema, validEnv);
    expect(env).toMatchObject({
      OUTBOX_RETENTION_ENABLED: true,
      OUTBOX_RETENTION_INTERVAL_MS: 3_600_000,
      OUTBOX_RETENTION_INITIAL_DELAY_MS: 180_000,
      OUTBOX_EVENTS_RETENTION_HOURS: 72,
      PROCESSED_EVENTS_RETENTION_DAYS: 30,
      OUTBOX_RETENTION_BATCH_SIZE: 5_000,
      OUTBOX_RETENTION_MAX_BATCHES_PER_RUN: 100,
      OUTBOX_REPLICATION_SLOT: 'udemy_outbox',
      DEBEZIUM_CONNECTOR_NAME: 'udemy-outbox',
      PIPELINE_METRICS_INTERVAL_MS: 60_000,
    });
    expect(env.KAFKA_CONNECT_URL).toBeUndefined();
  });

  it('accepts a Connect origin (trailing slash dropped), treats an empty value as unset, allows metrics off', () => {
    expect(
      validateEnv(workerEnvSchema, {
        ...validEnv,
        KAFKA_CONNECT_URL: 'http://localhost:8083/',
        PIPELINE_METRICS_INTERVAL_MS: '0',
      }),
    ).toMatchObject({
      KAFKA_CONNECT_URL: 'http://localhost:8083',
      PIPELINE_METRICS_INTERVAL_MS: 0,
    });
    expect(
      validateEnv(workerEnvSchema, { ...validEnv, KAFKA_CONNECT_URL: '' }).KAFKA_CONNECT_URL,
    ).toBeUndefined();
  });

  it.each([
    ['KAFKA_CONNECT_URL', 'http://localhost:8083/connectors'],
    ['KAFKA_CONNECT_URL', 'ftp://localhost:8083'],
    ['OUTBOX_EVENTS_RETENTION_HOURS', '0'],
    ['PROCESSED_EVENTS_RETENTION_DAYS', '7'],
    ['OUTBOX_RETENTION_BATCH_SIZE', '50001'],
    ['OUTBOX_RETENTION_INTERVAL_MS', '1000'],
    ['OUTBOX_REPLICATION_SLOT', 'Udemy-Outbox'],
    ['PIPELINE_METRICS_INTERVAL_MS', '1000'],
  ])('rejects an invalid %s (%s)', (key, value) => {
    expect(() => validateEnv(workerEnvSchema, { ...validEnv, [key]: value })).toThrow(
      new RegExp(key),
    );
  });
});

describe('workerEnvSchema (Phase 4 enrollment mail and ledger reconciliation)', () => {
  it('applies the defaults (instructor mail off, reconciliation hourly with a 60 min settle)', () => {
    expect(validateEnv(workerEnvSchema, validEnv)).toMatchObject({
      ENROLLMENT_INSTRUCTOR_MAIL_ENABLED: false,
      LEDGER_RECONCILIATION_ENABLED: true,
      LEDGER_RECONCILIATION_INTERVAL_MS: 3_600_000,
      LEDGER_RECONCILIATION_INITIAL_DELAY_MS: 240_000,
      LEDGER_RECONCILIATION_SETTLE_MINUTES: 60,
    });
  });

  it('turns the instructor mail on', () => {
    expect(
      validateEnv(workerEnvSchema, { ...validEnv, ENROLLMENT_INSTRUCTOR_MAIL_ENABLED: 'true' })
        .ENROLLMENT_INSTRUCTOR_MAIL_ENABLED,
    ).toBe(true);
  });

  it.each([
    ['LEDGER_RECONCILIATION_INTERVAL_MS', '1000'],
    ['LEDGER_RECONCILIATION_SETTLE_MINUTES', '0'],
    ['ENROLLMENT_INSTRUCTOR_MAIL_ENABLED', 'maybe'],
  ])('rejects an invalid %s (%s)', (key, value) => {
    expect(() => validateEnv(workerEnvSchema, { ...validEnv, [key]: value })).toThrow(
      new RegExp(key),
    );
  });
});

describe('workerEnvSchema (Phase 5 notifications and realtime push)', () => {
  it('applies the defaults', () => {
    expect(validateEnv(workerEnvSchema, validEnv)).toMatchObject({
      REDIS_URL: 'redis://localhost:6379',
      LEARNING_QUIZ_ATTEMPT_TTL_H: 24,
    });
  });

  it.each(['REDIS_URL', 'NOTIFICATIONS_UNSUBSCRIBE_SECRET', 'STUDENT_APP_ORIGIN'])(
    'requires %s',
    (key) => {
      const env: Record<string, string> = { ...validEnv };
      delete env[key];
      expect(() => validateEnv(workerEnvSchema, env)).toThrow(new RegExp(key));
    },
  );

  it.each([
    ['REDIS_URL', 'http://localhost:6379'],
    ['NOTIFICATIONS_UNSUBSCRIBE_SECRET', 'x'.repeat(31)],
    ['LEARNING_QUIZ_ATTEMPT_TTL_H', '0'],
  ])('rejects %s=%j', (key, value) => {
    expect(() => validateEnv(workerEnvSchema, { ...validEnv, [key]: value })).toThrow(
      new RegExp(key),
    );
  });

  it('refuses an unsubscribe secret equal to EMAIL_TOKEN_SECRET', () => {
    expect(() =>
      validateEnv(workerEnvSchema, {
        ...validEnv,
        NOTIFICATIONS_UNSUBSCRIBE_SECRET: validEnv.EMAIL_TOKEN_SECRET,
      }),
    ).toThrow(/NOTIFICATIONS_UNSUBSCRIBE_SECRET/);
  });

  it('refuses the change-me unsubscribe secret in production', () => {
    expect(() =>
      validateEnv(workerEnvSchema, {
        ...validEnv,
        ...productionSecrets,
        NODE_ENV: 'production',
        NOTIFICATIONS_UNSUBSCRIBE_SECRET: validEnv.NOTIFICATIONS_UNSUBSCRIBE_SECRET,
      }),
    ).toThrow(/NOTIFICATIONS_UNSUBSCRIBE_SECRET/);
  });
});

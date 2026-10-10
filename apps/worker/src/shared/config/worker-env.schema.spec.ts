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
        NODE_ENV: 'production',
        EMAIL_TOKEN_SECRET: 'a'.repeat(44),
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
    });
  });

  it('accepts the .env.example media values (dev retention of 1 day, path style off)', () => {
    const env = validateEnv(workerEnvSchema, {
      ...validEnv,
      S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:9000',
      S3_FORCE_PATH_STYLE: 'false',
      MEDIA_CLEANUP_ENABLED: 'false',
      MEDIA_SOURCE_RETENTION_DAYS: '1',
    });
    expect(env).toMatchObject({
      S3_PUBLIC_ENDPOINT: 'http://127.0.0.1:9000',
      S3_FORCE_PATH_STYLE: false,
      MEDIA_CLEANUP_ENABLED: false,
      MEDIA_SOURCE_RETENTION_DAYS: 1,
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

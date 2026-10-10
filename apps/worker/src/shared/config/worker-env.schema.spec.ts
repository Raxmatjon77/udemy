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

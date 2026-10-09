import { EnvValidationError, validateEnv } from '@udemy/nest-common';
import { describe, expect, it } from 'vitest';
import { apiEnvSchema } from './api-env.schema';

const validEnv = { DATABASE_URL: 'postgres://udemy:udemy@localhost:5432/udemy' };

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
    expect(() => validateEnv(apiEnvSchema, {})).toThrow(EnvValidationError);
  });

  it.each([
    ['DATABASE_URL', 'mysql://localhost/udemy'],
    ['PORT', 'not-a-number'],
    ['PORT', '70000'],
    ['NODE_ENV', 'staging'],
    ['LOG_LEVEL', 'verbose'],
    ['CORS_ORIGINS', 'http://ok.example,not a url'],
  ])('rejects an invalid %s (%s) and names the variable', (key, value) => {
    const run = (): unknown => validateEnv(apiEnvSchema, { ...validEnv, [key]: value });

    expect(run).toThrow(EnvValidationError);
    expect(run).toThrow(new RegExp(key));
  });

  it('never echoes variable values in the error message', () => {
    const secret = 'postgres-but-wrong://user:S3cret@host/db';

    expect(() => validateEnv(apiEnvSchema, { DATABASE_URL: secret })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('S3cret') }),
    );
  });
});

import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { baseEnvSchema } from './base-env.schema';
import { refuseDevPlaceholdersInProduction } from './production-guards';
import { EnvValidationError, validateEnv } from './validate-env';

const schema = baseEnvSchema
  .extend({ SECRET: z.string(), HASH: z.string(), LIST: z.array(z.string()).default([]) })
  .superRefine(refuseDevPlaceholdersInProduction({ forbiddenValues: ['known-dev-hash'] }));

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db', HASH: 'real-hash' };

describe('refuseDevPlaceholdersInProduction', () => {
  it('accepts placeholders outside production', () => {
    for (const NODE_ENV of ['development', 'test']) {
      expect(() =>
        validateEnv(schema, { ...base, NODE_ENV, SECRET: 'dev-secret-change-me-0000' }),
      ).not.toThrow();
    }
  });

  it('refuses a value containing change-me in production and names the variable only', () => {
    const run = (): unknown =>
      validateEnv(schema, { ...base, NODE_ENV: 'production', SECRET: 'dev-x-CHANGE-ME-in-prod' });

    expect(run).toThrow(EnvValidationError);
    expect(run).toThrow(/SECRET/);
    expect(run).toThrow(expect.objectContaining({ message: expect.not.stringContaining('dev-x') }));
  });

  it('refuses explicitly forbidden values and list items in production', () => {
    expect(() =>
      validateEnv(schema, { ...base, NODE_ENV: 'production', SECRET: 's', HASH: 'known-dev-hash' }),
    ).toThrow(/HASH/);
    expect(() =>
      validateEnv(schema, {
        ...base,
        NODE_ENV: 'production',
        SECRET: 's',
        LIST: ['ok', 'change-me'],
      }),
    ).toThrow(/LIST/);
  });

  it('accepts real values in production', () => {
    expect(() =>
      validateEnv(schema, { ...base, NODE_ENV: 'production', SECRET: 'a-real-secret' }),
    ).not.toThrow();
  });
});

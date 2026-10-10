import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as main from '../index';
import * as testing from './index.mjs';

const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as {
  exports: Record<string, { types: string; default: string }>;
};

describe('@udemy/db/testing', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is a separate ESM subpath and not part of the main entry', () => {
    expect(pkg.exports['./testing']).toEqual({
      types: './dist/testing/index.d.mts',
      default: './dist/testing/index.mjs',
    });
    for (const name of [
      'useIntegrationDb',
      'scriptedDb',
      'createAsset',
      'deleteTestData',
      'createOrder',
      'payOrder',
    ]) {
      expect(Object.keys(main)).not.toContain(name);
      expect(typeof (testing as Record<string, unknown>)[name]).toBe('function');
    }
  });

  it('itDatabaseUrl defaults to the dev compose Postgres and honours IT_DATABASE_URL', () => {
    vi.stubEnv('IT_DATABASE_URL', '');
    expect(testing.itDatabaseUrl()).toBe(testing.IT_DEFAULT_DATABASE_URL);
    vi.stubEnv('IT_DATABASE_URL', ' postgres://x:y@db:5432/z ');
    expect(testing.itDatabaseUrl()).toBe('postgres://x:y@db:5432/z');
  });

  it('scriptedDb records statements without a database', async () => {
    const s = testing.scriptedDb([{ rows: [{ one: 1 }] }]);
    const rows = await s.db.selectFrom('identity.users').select('id').execute();
    expect(rows).toEqual([{ one: 1 }]);
    expect(s.statements[0]).toContain('from "identity"."users"');
  });
});

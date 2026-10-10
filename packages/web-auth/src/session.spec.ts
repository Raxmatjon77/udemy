import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintAccessToken, stubApi, testConfig, USER_ID } from './internal/test-helpers';

const jar = new Map<string, string>();
vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  }),
}));

const { createGetSession } = await import('./session');
const getSession = createGetSession(testConfig());

afterEach(() => {
  jar.clear();
  vi.unstubAllGlobals();
});

describe('getSession', () => {
  it('returns identity facts from a verified at cookie, never the token', async () => {
    await stubApi({});
    jar.set('__Host-udemy-student-at', await mintAccessToken({ roles: ['STUDENT', 'INSTRUCTOR'] }));
    const session = await getSession();
    expect(session).toEqual({ userId: USER_ID, roles: ['STUDENT', 'INSTRUCTOR'], app: 'student' });
  });

  it('returns null without a cookie, for an expired token, and for another app', async () => {
    await stubApi({});
    expect(await getSession()).toBeNull();
    jar.set('__Host-udemy-student-at', await mintAccessToken({ expiresIn: -10 }));
    expect(await getSession()).toBeNull();
    jar.set('__Host-udemy-student-at', await mintAccessToken({ app: 'admin' }));
    expect(await getSession()).toBeNull();
    jar.set('__Host-udemy-student-at', 'garbage');
    expect(await getSession()).toBeNull();
  });
});

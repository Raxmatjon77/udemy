import { afterEach, describe, expect, it, vi } from 'vitest';
import { mintAccessToken, stubApi, testConfig, testInput, USER_ID } from './internal/test-helpers';

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

describe('getSession with a lazy config', () => {
  it('resolves the thunk on the first call only (after cookies()), then caches it', async () => {
    await stubApi({});
    const thunk = vi.fn(() => testInput());
    const lazy = createGetSession(thunk);
    expect(thunk).not.toHaveBeenCalled();
    expect(await lazy()).toBeNull();
    jar.set('__Host-udemy-student-at', await mintAccessToken());
    expect(await lazy()).toMatchObject({ userId: USER_ID });
    expect(thunk).toHaveBeenCalledTimes(1);
  });

  it('reads null once proxy.ts / the BFF removed the cookie of an ended session', async () => {
    await stubApi({});
    jar.set('__Host-udemy-student-at', await mintAccessToken());
    expect(await getSession()).not.toBeNull();
    jar.delete('__Host-udemy-student-at');
    expect(await getSession()).toBeNull();
  });
});

import { createAuthProxy } from '@udemy/web-auth/proxy';
import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { PUBLIC_PATHS, webAuthConfig } from './config';

const proxy = createAuthProxy(webAuthConfig);

/** An anonymous page request (no cookies). */
function anonymous(path: string) {
  return new NextRequest(`http://localhost:3000${path}`, {
    headers: { 'user-agent': 'Vitest' },
  });
}

const rendersPage = (res: Response) => res.headers.get('x-middleware-next') === '1';

describe('student PUBLIC_PATHS', () => {
  it('lists the public catalog and the media routes', () => {
    expect(PUBLIC_PATHS).toEqual(
      expect.arrayContaining(['/', '/courses', '/categories/*', '/course/*', '/media/*']),
    );
  });

  it.each([
    '/',
    '/courses',
    '/courses?level=BEGINNER&q=react',
    '/categories/development',
    '/categories/web-development?language=en',
    '/course/modern-typescript',
    '/media/course-thumbnail/0b7f1d1e-5a8f-4c3a-9a51-6f1b2c3d4e5f?variant=w480',
  ])('lets an anonymous visitor open %s (with a CSP nonce)', async (path) => {
    const res = await proxy(anonymous(path));
    expect(res.headers.get('location')).toBeNull();
    expect(rendersPage(res)).toBe(true);
    expect(res.headers.get('content-security-policy')).toContain("'nonce-");
  });

  it.each([
    '/account/profile',
    '/become-instructor',
    '/coursesx',
    '/categoriesx',
    '/courses/extra',
  ])('still sends anonymous visitors of %s to the login page', async (path) => {
    const res = await proxy(anonymous(path));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login');
  });
});

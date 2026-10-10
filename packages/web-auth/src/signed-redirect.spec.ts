import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cookieHeader,
  isoIn,
  json,
  mintAccessToken,
  ORIGIN,
  parseSetCookies,
  problem,
  stubApi,
  testConfig,
} from './internal/test-helpers';
import { createSignedRedirectHandler, isAllowedMediaUrl } from './signed-redirect';

const MEDIA = 'http://127.0.0.1:9000';
const COURSE = '0192f0c4-7d6a-7b3e-8f00-0000000000aa';
const LECTURE = '0192f0c4-7d6a-7b3e-8f00-0000000000bb';
const THUMB_API = `/api/v1/catalog/courses/${COURSE}/images/thumbnail`;
const DOWNLOAD_API = `/api/v1/courses/${COURSE}/lectures/${LECTURE}/download`;
const AT = '__Host-udemy-student-at';
const RT = '__Host-udemy-student-rt';
const UUID = /^[0-9a-f-]{36}$/;

const config = testConfig({ mediaOrigin: MEDIA });

const thumbnail = createSignedRedirectHandler<{ courseId: string }>(config, {
  apiPath: ({ params, searchParams }) =>
    UUID.test(params.courseId)
      ? `/catalog/courses/${params.courseId}/images/thumbnail?variant=${
          searchParams.get('variant') === 'w480' ? 'w480' : 'w750'
        }`
      : null,
});

const download = createSignedRedirectHandler<{ courseId: string; lectureId: string }>(config, {
  session: 'forward',
  apiPath: ({ params }) => `/courses/${params.courseId}/lectures/${params.lectureId}/download`,
});

const signed = (url: string, seconds: number) => json({ url, expiresAt: isoIn(seconds) });
const presigned = (key: string) =>
  `${MEDIA}/udemy-media/${key}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc`;

function get(path: string, cookies?: Record<string, string | undefined>) {
  const headers = new Headers({ 'user-agent': 'UA' });
  if (cookies) headers.set('cookie', cookieHeader(cookies));
  return new Request(`${ORIGIN}${path}`, { headers });
}
const ctx = <P>(params: P) => ({ params: Promise.resolve(params) });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-10T10:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('createSignedRedirectHandler (anonymous images)', () => {
  it('302s to the presigned URL, public max-age 300, no referrer', async () => {
    const api = await stubApi({
      [`GET ${THUMB_API}`]: () => signed(presigned('thumb/w750.webp'), 3600),
    });
    const res = await thumbnail(
      get(`/media/course-thumbnail/${COURSE}`),
      ctx({ courseId: COURSE }),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(presigned('thumb/w750.webp'));
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(await res.text()).toBe('');

    const call = api.calls[0]!;
    expect(new URL(call.url).search).toBe('?variant=w750');
    expect(call.headers.get('x-client-id')).toBe('student-bff');
    expect(call.headers.get('authorization')).toBeNull();
  });

  it('never forwards the visitor session (the response may be shared)', async () => {
    const api = await stubApi({
      [`GET ${THUMB_API}`]: () => signed(presigned('t.webp'), 3600),
    });
    const res = await thumbnail(
      get(`/media/course-thumbnail/${COURSE}?variant=w480`, {
        [AT]: await mintAccessToken(),
        [RT]: 'rt',
      }),
      ctx({ courseId: COURSE }),
    );
    expect(res.status).toBe(302);
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]!.headers.get('authorization')).toBeNull();
    expect(new URL(api.calls[0]!.url).search).toBe('?variant=w480');
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(res.headers.get('cache-control')).toBe('public, max-age=300');
  });

  it('aligns max-age with the remaining signature lifetime (minus 30 s)', async () => {
    await stubApi({ [`GET ${THUMB_API}`]: () => signed(presigned('t.webp'), 100) });
    const res = await thumbnail(get('/x'), ctx({ courseId: COURSE }));
    expect(res.headers.get('cache-control')).toBe('public, max-age=70');
  });

  it('no-store when the signature is about to expire', async () => {
    await stubApi({ [`GET ${THUMB_API}`]: () => signed(presigned('t.webp'), 20) });
    const res = await thumbnail(get('/x'), ctx({ courseId: COURSE }));
    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('honours a smaller maxAgeSeconds', async () => {
    const short = createSignedRedirectHandler<{ courseId: string }>(config, {
      maxAgeSeconds: 60,
      apiPath: ({ params }) => `/catalog/courses/${params.courseId}/images/thumbnail`,
    });
    await stubApi({ [`GET ${THUMB_API}`]: () => signed(presigned('t.webp'), 3600) });
    const res = await short(get('/x'), ctx({ courseId: COURSE }));
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it.each([
    ['another host', 'https://evil.test/udemy-media/t.webp'],
    ['another port', 'http://127.0.0.1:9001/udemy-media/t.webp'],
    ['another scheme', 'https://127.0.0.1:9000/udemy-media/t.webp'],
    ['a look-alike host', 'http://127.0.0.1:9000.evil.test/t.webp'],
    ['userinfo', 'http://user:pw@127.0.0.1:9000/t.webp'],
    ['javascript:', 'javascript:alert(1)'],
    ['a relative URL', '/udemy-media/t.webp'],
    ['protocol-relative', '//evil.test/t.webp'],
  ])('refuses a redirect target on %s (502, URL not echoed)', async (_label, url) => {
    await stubApi({ [`GET ${THUMB_API}`]: () => signed(url, 3600) });
    const res = await thumbnail(get('/x'), ctx({ courseId: COURSE }));
    expect(res.status).toBe(502);
    expect(res.headers.get('location')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).not.toContain(url);
  });

  it('502 for an already expired URL or a body that is not a SignedUrl', async () => {
    await stubApi({ [`GET ${THUMB_API}`]: () => signed(presigned('t.webp'), -5) });
    expect((await thumbnail(get('/x'), ctx({ courseId: COURSE }))).status).toBe(502);
    await stubApi({ [`GET ${THUMB_API}`]: () => json({ href: presigned('t.webp') }) });
    expect((await thumbnail(get('/x'), ctx({ courseId: COURSE }))).status).toBe(502);
  });

  it('passes API errors on as no-store problems', async () => {
    await stubApi({ [`GET ${THUMB_API}`]: () => problem(404, 'course_not_found') });
    const res = await thumbnail(get('/x'), ctx({ courseId: COURSE }));
    expect(res.status).toBe(404);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('location')).toBeNull();
    expect(((await res.json()) as { code: string }).code).toBe('course_not_found');
  });

  it('404 without calling the API when apiPath rejects the params', async () => {
    const api = await stubApi({});
    const res = await thumbnail(get('/x'), ctx({ courseId: '../../auth/login' }));
    expect(res.status).toBe(404);
    expect(api.calls).toHaveLength(0);
  });

  it('an unsafe apiPath cannot escape the API prefix', async () => {
    const naive = createSignedRedirectHandler<{ id: string }>(config, {
      apiPath: ({ params }) => `/catalog/courses/${params.id}/images/thumbnail`,
    });
    const api = await stubApi({});
    for (const id of ['..%2F..%2Fauth', '%2e%2e', 'a\\b']) {
      expect((await naive(get('/x'), ctx({ id }))).status).toBe(404);
    }
    expect((await naive(get('/x'), ctx({ id: '../../../auth' }))).status).toBe(404);
    expect(api.calls).toHaveLength(0);
  });

  it('405 for unsafe methods', async () => {
    await stubApi({});
    const res = await thumbnail(
      new Request(`${ORIGIN}/x`, { method: 'POST' }),
      ctx({ courseId: COURSE }),
    );
    expect(res.status).toBe(405);
  });

  it('fails readably on the first request when mediaOrigin is missing', async () => {
    const handler = createSignedRedirectHandler(() => testConfig(), {
      apiPath: () => '/x',
    });
    await expect(handler(get('/x'), ctx({}))).rejects.toThrow(/MEDIA_PUBLIC_ORIGIN/);
  });
});

describe('createSignedRedirectHandler (session downloads)', () => {
  it('forwards the session; the redirect is private and varies on cookies', async () => {
    const at = await mintAccessToken();
    const api = await stubApi({
      [`GET ${DOWNLOAD_API}`]: () => signed(presigned('res/file.bin'), 300),
    });
    const res = await download(
      get('/media/download', { [AT]: at, [RT]: 'rt' }),
      ctx({ courseId: COURSE, lectureId: LECTURE }),
    );
    expect(res.status).toBe(302);
    expect(api.calls[0]!.headers.get('authorization')).toBe(`Bearer ${at}`);
    expect(res.headers.get('cache-control')).toBe('private, max-age=270');
    expect(res.headers.get('vary')).toBe('cookie');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('refreshes an expired access token and passes the new cookies on (no-store)', async () => {
    const fresh = await mintAccessToken();
    const api = await stubApi({
      'POST /api/v1/auth/refresh': () =>
        json({ accessToken: fresh, accessTokenExpiresAt: isoIn(900) }),
      [`GET ${DOWNLOAD_API}`]: () => signed(presigned('res/file.bin'), 300),
    });
    const res = await download(
      get('/media/download', { [AT]: await mintAccessToken({ expiresIn: -10 }), [RT]: 'rt' }),
      ctx({ courseId: COURSE, lectureId: LECTURE }),
    );
    expect(res.status).toBe(302);
    expect(api.callsTo('GET', DOWNLOAD_API)[0]!.headers.get('authorization')).toBe(
      `Bearer ${fresh}`,
    );
    expect(parseSetCookies(res.headers).get(AT)!.value).toBe(fresh);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('a revoked session: 401 with the cookies cleared', async () => {
    await stubApi({ [`GET ${DOWNLOAD_API}`]: () => problem(401, 'unauthorized') });
    const res = await download(
      get('/media/download', { [AT]: await mintAccessToken(), [RT]: 'rt' }),
      ctx({ courseId: COURSE, lectureId: LECTURE }),
    );
    expect(res.status).toBe(401);
    expect(parseSetCookies(res.headers).get(AT)!.value).toBe('');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('isAllowedMediaUrl', () => {
  it('accepts only the exact origin', () => {
    expect(isAllowedMediaUrl(`${MEDIA}/b/k?sig=1`, MEDIA)?.href).toBe(`${MEDIA}/b/k?sig=1`);
    expect(isAllowedMediaUrl('https://media.example/b/k', 'https://media.example')).not.toBeNull();
    expect(isAllowedMediaUrl('https://media.example.evil/b/k', 'https://media.example')).toBeNull();
    expect(isAllowedMediaUrl('not a url', MEDIA)).toBeNull();
  });
});

import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  buildPinoParams,
  LOG_REDACT_ALL_PATHS,
  LOG_REDACT_CENSOR,
  LOG_REDACT_PATHS,
  logRedactCensor,
  logRedactOptions,
  PRESIGNED_URL_REDACT_PATHS,
} from './create-logger-module';
import {
  isPresignedUrl,
  PRESIGNED_SANITIZE_MAX_DEPTH,
  sanitizePresignedUrls,
  stripPresignedQuery,
  stripPresignedUrlsInText,
} from './presigned-url';

/** A pino logger with exactly the redaction config the apps use, writing into an array. */
function captureLogger(): { logger: pino.Logger; lines: () => Record<string, unknown>[] } {
  const output: string[] = [];
  const logger = pino(
    { redact: logRedactOptions() },
    { write: (line: string) => output.push(line) },
  );
  return {
    logger,
    lines: () => output.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const SECRETS = {
  password: 'pw-1',
  newPassword: 'pw-2',
  currentPassword: 'pw-3',
  token: 'tok-1',
  refreshToken: 'rt-1',
  accessToken: 'at-1',
};

describe('pino redaction', () => {
  it('is what buildPinoParams configures', () => {
    const params = buildPinoParams(
      { NODE_ENV: 'production', LOG_LEVEL: 'info' },
      { serviceName: 's' },
    );

    const redact = (params.pinoHttp as { redact: { paths: string[]; censor: unknown } }).redact;
    expect(redact.paths).toEqual([...LOG_REDACT_ALL_PATHS]);
    expect(redact.censor).toBe(logRedactCensor);
    // The credential paths are all still there, before the presigned-URL paths.
    expect(redact.paths.slice(0, LOG_REDACT_PATHS.length)).toEqual([...LOG_REDACT_PATHS]);
    expect(redact.paths.slice(LOG_REDACT_PATHS.length)).toEqual([...PRESIGNED_URL_REDACT_PATHS]);
  });

  it('redacts credential headers of a logged request', () => {
    const { logger, lines } = captureLogger();

    logger.info({
      req: {
        headers: {
          authorization: 'Bearer eyJ.secret',
          cookie: '__Host-udemy-student-rt=abc',
          'x-client-secret': 'bff-secret',
          'x-client-id': 'student-bff',
        },
      },
      res: { headers: { 'set-cookie': 'a=b' } },
    });

    const line = JSON.stringify(lines()[0]);
    for (const secret of ['eyJ.secret', '__Host-udemy-student-rt=abc', 'bff-secret', 'a=b']) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain('student-bff');
  });

  it.each([
    ['at the top level', (body: object) => body],
    ['in a logged body', (body: object) => ({ body })],
    ['in a logged request body', (body: object) => ({ req: { body } })],
  ])('redacts sensitive fields %s', (_where, wrap) => {
    const { logger, lines } = captureLogger();

    logger.info(wrap({ ...SECRETS, email: 'a@b.c' }), 'login');

    const line = JSON.stringify(lines()[0]);
    for (const secret of Object.values(SECRETS)) {
      expect(line).not.toContain(secret);
    }
    expect(line).toContain(LOG_REDACT_CENSOR);
    expect(line).toContain('a@b.c');
  });
});

const SIG = 'deadbeefcafebabe0123456789abcdef';
const CRED = 'minio%2F20261010%2Fus-east-1%2Fs3%2Faws4_request';
const presigned = (base: string, extra = ''): string =>
  `${base}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=${CRED}&X-Amz-Date=20261010T000000Z` +
  `&X-Amz-Expires=900&X-Amz-SignedHeaders=content-length%3Bhost${extra}&X-Amz-Signature=${SIG}`;
const PART_URL = presigned(
  'http://127.0.0.1:9000/udemy-uploads/uploads/o/a/source',
  '&partNumber=3&uploadId=u-1',
);
const THUMB_URL = presigned('https://media.example/udemy-media/assets/a/a1/thumb.webp');

describe('presigned URL helpers', () => {
  it('recognises SigV4 and SigV2 presigned URLs only', () => {
    expect(isPresignedUrl(PART_URL)).toBe(true);
    expect(isPresignedUrl('https://s3.example/b/k?Signature=x&AWSAccessKeyId=y&Expires=1')).toBe(
      true,
    );
    expect(isPresignedUrl('https://s3.example/b/k?x-amz-signature=lower')).toBe(true);
    expect(isPresignedUrl('https://example.com/a?b=c')).toBe(false);
    expect(isPresignedUrl('/api/v1/media/uploads?X-Amz-Signature=x')).toBe(false); // not absolute
    expect(isPresignedUrl('not a url')).toBe(false);
  });

  it('strips every X-Amz-* parameter and keeps the path and the other parameters', () => {
    expect(stripPresignedQuery(PART_URL)).toBe(
      'http://127.0.0.1:9000/udemy-uploads/uploads/o/a/source?partNumber=3&uploadId=u-1',
    );
    expect(stripPresignedQuery(THUMB_URL)).toBe(
      'https://media.example/udemy-media/assets/a/a1/thumb.webp',
    );
    expect(stripPresignedQuery('https://example.com/a?X-Amz-Date=1')).toBe(
      'https://example.com/a?X-Amz-Date=1',
    ); // no signature: not presigned, untouched
    expect(stripPresignedQuery('/api/v1/courses?cursor=x')).toBe('/api/v1/courses?cursor=x');
  });

  it('strips presigned URLs embedded in text (playlists, messages)', () => {
    const playlist = `#EXTM3U\n#EXTINF:6,\n${PART_URL}\n#EXTINF:6,\n${THUMB_URL}\n`;
    const out = stripPresignedUrlsInText(playlist);
    expect(out).not.toContain(SIG);
    expect(out).toContain('#EXTINF:6,');
    expect(out).toContain('https://media.example/udemy-media/assets/a/a1/thumb.webp\n');
  });

  it('sanitizes deeply but only plain objects/arrays, without mutating the input', () => {
    const input = { a: [{ b: { url: PART_URL, n: 1 } }], d: new Date(0), password: 'x' };
    const out = sanitizePresignedUrls(input, { censorKeys: new Set(['password']) });
    expect(JSON.stringify(out)).not.toContain(SIG);
    expect(out).toMatchObject({ a: [{ b: { n: 1 } }], d: new Date(0), password: '[REDACTED]' });
    expect(input.a[0]?.b.url).toBe(PART_URL);
    let deep: unknown = PART_URL;
    for (let i = 0; i < PRESIGNED_SANITIZE_MAX_DEPTH + 2; i++) deep = { x: deep };
    expect(JSON.stringify(sanitizePresignedUrls(deep))).not.toContain(SIG);
  });
});

describe('pino redaction of presigned URLs', () => {
  it.each([
    ['top-level url', { url: THUMB_URL }],
    ['a SignedUrl response body', { body: { url: THUMB_URL, expiresAt: 'x' } }],
    ['a nested res.body.url', { res: { body: { url: THUMB_URL } } }],
    ['PresignPartsResponse urls[*].url', { urls: [{ partNumber: 3, url: PART_URL }] }],
    ['nested urls[*].url', { body: { urls: [{ partNumber: 3, url: PART_URL }] } }],
    ['urls[*] strings', { urls: [PART_URL, THUMB_URL] }],
    ['nested urls[*] strings', { result: { urls: [PART_URL] } }],
    ['anything under responseBody', { responseBody: { a: { b: [{ c: `see ${PART_URL}` }] } } }],
    ['a nested responseBody', { http: { responseBody: { playlist: `#EXTM3U\n${THUMB_URL}` } } }],
  ])('strips the signature from %s', (_where, obj) => {
    const { logger, lines } = captureLogger();

    logger.info(obj, 'presign');

    const line = JSON.stringify(lines()[0]);
    expect(line).not.toContain(SIG);
    expect(line).not.toContain('X-Amz-Credential');
    expect(line).toMatch(/udemy-(uploads|media)\//); // the object path stays for debugging
  });

  it('keeps ordinary URLs (req.url) readable', () => {
    const { logger, lines } = captureLogger();

    logger.info({
      req: { method: 'GET', url: '/api/v1/courses?cursor=abc' },
      url: 'https://x.test/a',
    });

    expect(lines()[0]).toMatchObject({
      req: { url: '/api/v1/courses?cursor=abc' },
      url: 'https://x.test/a',
    });
  });

  it('still censors credentials inside a responseBody and does not invent keys', () => {
    const { logger, lines } = captureLogger();

    logger.info({ responseBody: { accessToken: 'at-9', nested: { refreshToken: 'rt-9' } } });

    const line = lines()[0] ?? {};
    expect(JSON.stringify(line)).not.toMatch(/at-9|rt-9/);
    expect(line).toMatchObject({
      responseBody: { accessToken: LOG_REDACT_CENSOR, nested: { refreshToken: LOG_REDACT_CENSOR } },
    });
    expect(Object.keys(line)).not.toContain('url');
    expect(Object.keys(line)).not.toContain('password');
  });

  it('logRedactCensor censors credential paths and sanitizes URL paths', () => {
    expect(logRedactCensor('pw', ['password'])).toBe(LOG_REDACT_CENSOR);
    expect(logRedactCensor('Bearer x', ['req', 'headers', 'authorization'])).toBe(
      LOG_REDACT_CENSOR,
    );
    expect(logRedactCensor(THUMB_URL, ['url'])).toBe(
      'https://media.example/udemy-media/assets/a/a1/thumb.webp',
    );
    expect(logRedactCensor(PART_URL, ['body', 'urls', '0'])).not.toContain(SIG);
    expect(logRedactCensor(undefined, ['url'])).toBeUndefined();
  });
});

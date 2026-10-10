import { describe, expect, it } from 'vitest';
import { buildContentSecurityPolicy, createNonce } from './csp';

const NONCE = 'AAAAAAAAAAAAAAAAAAAAAA==';
const MEDIA = 'http://127.0.0.1:9000';

function directives(policy: string): Map<string, string[]> {
  return new Map(
    policy.split('; ').map((part) => {
      const [name, ...values] = part.split(' ');
      return [name!, values];
    }),
  );
}

describe('buildContentSecurityPolicy', () => {
  it('production policy, directive by directive', () => {
    const policy = buildContentSecurityPolicy({
      nonce: NONCE,
      mediaOrigin: MEDIA,
      dev: false,
      upgradeInsecureRequests: true,
    });
    expect(policy).toBe(
      [
        "default-src 'self'",
        `script-src 'self' 'nonce-${NONCE}' 'strict-dynamic'`,
        "style-src 'self' 'unsafe-inline'",
        `img-src 'self' data: blob: ${MEDIA}`,
        `media-src 'self' blob: ${MEDIA}`,
        `connect-src 'self' ${MEDIA}`,
        "worker-src 'self' blob:",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
        "frame-ancestors 'none'",
        'upgrade-insecure-requests',
      ].join('; '),
    );
  });

  it("adds 'unsafe-eval' to script-src in development only", () => {
    const dev = directives(
      buildContentSecurityPolicy({ nonce: NONCE, dev: true, upgradeInsecureRequests: false }),
    );
    expect(dev.get('script-src')).toContain("'unsafe-eval'");
    const prod = buildContentSecurityPolicy({
      nonce: NONCE,
      dev: false,
      upgradeInsecureRequests: false,
    });
    expect(prod).not.toContain('unsafe-eval');
  });

  it('never allows inline or eval scripts in production', () => {
    const script = directives(
      buildContentSecurityPolicy({ nonce: NONCE, dev: false, upgradeInsecureRequests: true }),
    ).get('script-src')!;
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
    expect(script).not.toContain('*');
    expect(script).not.toContain('data:');
  });

  it('omits upgrade-insecure-requests unless asked', () => {
    const policy = buildContentSecurityPolicy({
      nonce: NONCE,
      dev: false,
      upgradeInsecureRequests: false,
    });
    expect(policy).not.toContain('upgrade-insecure-requests');
  });

  it('without a media origin, only self (and blob/data where needed)', () => {
    const map = directives(
      buildContentSecurityPolicy({ nonce: NONCE, dev: false, upgradeInsecureRequests: false }),
    );
    expect(map.get('connect-src')).toEqual(["'self'"]);
    expect(map.get('media-src')).toEqual(["'self'", 'blob:']);
    expect(map.get('img-src')).toEqual(["'self'", 'data:', 'blob:']);
  });

  it.each([
    'http://a.test; script-src *',
    "http://a.test 'unsafe-inline'",
    'javascript:alert(1)',
    'http://a.test/path',
    '*',
  ])('refuses a media origin that could inject sources or directives: %s', (mediaOrigin) => {
    expect(() =>
      buildContentSecurityPolicy({
        nonce: NONCE,
        mediaOrigin,
        dev: false,
        upgradeInsecureRequests: false,
      }),
    ).toThrow();
  });

  it.each(["abc'; script-src *", 'short', ''])('refuses a malformed nonce %j', (nonce) => {
    expect(() =>
      buildContentSecurityPolicy({ nonce, dev: false, upgradeInsecureRequests: false }),
    ).toThrow();
  });
});

describe('createNonce', () => {
  it('is 128-bit base64 and unique', () => {
    const nonces = new Set(Array.from({ length: 1000 }, createNonce));
    expect(nonces.size).toBe(1000);
    for (const nonce of nonces) expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
  });
});

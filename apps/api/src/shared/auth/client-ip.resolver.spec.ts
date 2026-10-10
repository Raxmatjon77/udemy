import type { Request } from 'express';
import { describe, expect, it } from 'vitest';
import { markClientAuthenticated } from './auth-request';
import { ClientIpResolver, normalizeIp, UNKNOWN_IP } from './client-ip.resolver';

function fakeRequest(options: {
  headers?: Record<string, string | string[]>;
  ip?: string;
  remoteAddress?: string;
}): Request {
  return {
    headers: options.headers ?? {},
    ip: options.ip,
    socket: { remoteAddress: options.remoteAddress },
  } as unknown as Request;
}

describe('ClientIpResolver', () => {
  const resolver = new ClientIpResolver();

  it('ignores X-Client-IP when the client is not authenticated', () => {
    const req = fakeRequest({ headers: { 'x-client-ip': '203.0.113.9' }, ip: '10.0.0.5' });

    expect(resolver.resolve(req)).toBe('10.0.0.5');
  });

  it('trusts X-Client-IP once ClientAuthGuard marked the request', () => {
    const req = fakeRequest({ headers: { 'x-client-ip': '203.0.113.9' }, ip: '10.0.0.5' });
    markClientAuthenticated(req);

    expect(resolver.resolve(req)).toBe('203.0.113.9');
  });

  it.each([
    ['a list', '203.0.113.9, 198.51.100.1'],
    ['a host:port', '203.0.113.9:443'],
    ['garbage', 'not-an-ip'],
    ['empty', ''],
  ])('falls back to req.ip when the trusted header is %s', (_case, value) => {
    const req = fakeRequest({ headers: { 'x-client-ip': value }, ip: '10.0.0.5' });
    markClientAuthenticated(req);

    expect(resolver.resolve(req)).toBe('10.0.0.5');
  });

  it('falls back to req.ip when the header is repeated', () => {
    const req = fakeRequest({ headers: { 'x-client-ip': ['1.1.1.1', '2.2.2.2'] }, ip: '10.0.0.5' });
    markClientAuthenticated(req);

    expect(resolver.resolve(req)).toBe('10.0.0.5');
  });

  it('uses the socket address when req.ip is unset, else "unknown"', () => {
    expect(resolver.resolve(fakeRequest({ remoteAddress: '::ffff:127.0.0.1' }))).toBe('127.0.0.1');
    expect(resolver.resolve(fakeRequest({}))).toBe(UNKNOWN_IP);
  });

  it('reads X-Client-User-Agent only from an authenticated client, truncated', () => {
    const headers = {
      'x-client-user-agent': `Browser/${'x'.repeat(600)}`,
      'user-agent': 'node-fetch',
    };
    const anonymous = fakeRequest({ headers });
    const trusted = fakeRequest({ headers });
    markClientAuthenticated(trusted);

    expect(resolver.resolveUserAgent(anonymous)).toBe('node-fetch');
    expect(resolver.resolveUserAgent(trusted)).toHaveLength(512);
    expect(resolver.resolveUserAgent(trusted).startsWith('Browser/')).toBe(true);
    expect(resolver.resolveUserAgent(fakeRequest({}))).toBe('');
  });
});

describe('normalizeIp', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    [' 203.0.113.9 ', '203.0.113.9'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['2001:DB8::1', '2001:db8::1'],
    ['::1', '::1'],
  ])('%s -> %s', (raw, expected) => {
    expect(normalizeIp(raw)).toBe(expected);
  });

  it.each(['999.1.1.1', '1.2.3', 'localhost', '[::1]'])('rejects %s', (raw) => {
    expect(normalizeIp(raw)).toBeUndefined();
  });
});

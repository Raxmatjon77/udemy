import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt, decodeProtectedHeader, SignJWT, UnsecuredJWT } from 'jose';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AppConfigService } from '../../../../shared/config';
import { AccessTokenExpired, Unauthenticated } from '../../domain/identity.errors';
import { FileKeyStore } from '../keys/file-key.store';
import { JoseAccessTokenIssuer } from './jose-access-token.issuer';
import { JoseAccessTokenVerifier } from './jose-access-token.verifier';

const ISSUER = 'http://localhost:4000';
const AUDIENCE = 'udemy-api';
const NOW = new Date('2026-10-10T12:00:00Z');
const subject = {
  userId: '0199d0a0-0000-7000-8000-000000000001',
  sessionId: '0199d0a0-0000-7000-8000-000000000002',
  app: 'instructor',
  roles: ['STUDENT', 'INSTRUCTOR'],
} as const;

function fakeConfig(env: { API_PUBLIC_URL: string; JWT_AUDIENCE: string }): AppConfigService {
  return { get: (key: keyof typeof env) => env[key] } as unknown as AppConfigService;
}

async function writeKey(dir: string, kid: string): Promise<void> {
  const pem = generateKeyPairSync('ed25519').privateKey.export({ format: 'pem', type: 'pkcs8' });
  await writeFile(join(dir, `${kid}.pem`), pem, { mode: 0o600 });
}

describe('JoseAccessTokenIssuer / JoseAccessTokenVerifier', () => {
  const dirs: string[] = [];
  let store: FileKeyStore;
  let otherStore: FileKeyStore;
  let issuer: JoseAccessTokenIssuer;
  let verifier: JoseAccessTokenVerifier;
  const config = fakeConfig({ API_PUBLIC_URL: ISSUER, JWT_AUDIENCE: AUDIENCE });

  async function newDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'udemy-jwt-'));
    dirs.push(dir);
    return dir;
  }

  beforeAll(async () => {
    const dir = await newDir();
    await writeKey(dir, 'ed25519-2026-09');
    await writeKey(dir, 'ed25519-2026-10');
    store = await FileKeyStore.load({ dir, activeKid: 'ed25519-2026-10' });

    // Same kid, different key material: tokens from it must not verify against `store`.
    const other = await newDir();
    await writeKey(other, 'ed25519-2026-10');
    await writeKey(other, 'ed25519-2026-11');
    otherStore = await FileKeyStore.load({ dir: other, activeKid: 'ed25519-2026-10' });

    issuer = new JoseAccessTokenIssuer(store, config);
    verifier = new JoseAccessTokenVerifier(store, config);
  });

  afterAll(async () => {
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function at(date: Date): void {
    vi.useFakeTimers({ now: date, toFake: ['Date'] });
  }

  it('issues exactly the design §9 header and claims', async () => {
    at(NOW);
    const issued = await issuer.issue(subject);

    expect(decodeProtectedHeader(issued.token)).toEqual({ alg: 'EdDSA', kid: 'ed25519-2026-10' });
    const claims = decodeJwt(issued.token);
    expect(Object.keys(claims).sort()).toEqual(
      ['app', 'aud', 'exp', 'iat', 'iss', 'jti', 'roles', 'sid', 'sub'].sort(),
    );
    const iat = NOW.getTime() / 1000;
    expect(claims).toEqual({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: subject.userId,
      sid: subject.sessionId,
      app: 'instructor',
      roles: ['STUDENT', 'INSTRUCTOR'],
      iat,
      exp: iat + 900,
      jti: issued.tokenId,
    });
    expect(issued.tokenId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(issued).toMatchObject({
      kid: 'ed25519-2026-10',
      issuedAt: NOW,
      expiresAt: new Date(NOW.getTime() + 15 * 60_000),
    });
  });

  it('round-trips', async () => {
    at(NOW);
    const issued = await issuer.issue(subject);

    await expect(verifier.verify(issued.token)).resolves.toEqual({
      iss: ISSUER,
      aud: AUDIENCE,
      sub: subject.userId,
      sid: subject.sessionId,
      app: 'instructor',
      roles: ['STUDENT', 'INSTRUCTOR'],
      iat: NOW.getTime() / 1000,
      exp: NOW.getTime() / 1000 + 900,
      jti: issued.tokenId,
    });
  });

  it('accepts tokens of every published key (rotation), not only the active one', async () => {
    at(NOW);
    // Same directory, previous key active: what a not-yet-restarted pod still signs with.
    const previous = await FileKeyStore.load({ dir: dirs[0] ?? '', activeKid: 'ed25519-2026-09' });
    const { token } = await new JoseAccessTokenIssuer(previous, config).issue(subject);

    expect(decodeProtectedHeader(token).kid).toBe('ed25519-2026-09');
    await expect(verifier.verify(token)).resolves.toMatchObject({ sub: subject.userId });
  });

  it('honours the 30 s clock tolerance on exp', async () => {
    at(NOW);
    const { token } = await issuer.issue(subject);

    at(new Date(NOW.getTime() + (900 + 29) * 1000));
    await expect(verifier.verify(token)).resolves.toMatchObject({ sub: subject.userId });

    at(new Date(NOW.getTime() + (900 + 31) * 1000));
    await expect(verifier.verify(token)).rejects.toBeInstanceOf(AccessTokenExpired);
  });

  it('an expired token is 401 token_expired', async () => {
    at(NOW);
    const { token } = await issuer.issue(subject);
    at(new Date(NOW.getTime() + 3_600_000));

    await expect(verifier.verify(token)).rejects.toMatchObject({
      kind: 'unauthorized',
      code: 'token_expired',
    });
  });

  it.each([
    ['wrong audience', { API_PUBLIC_URL: ISSUER, JWT_AUDIENCE: 'other-api' }],
    ['wrong issuer', { API_PUBLIC_URL: 'http://evil.example', JWT_AUDIENCE: AUDIENCE }],
  ])('rejects a token with the %s as 401 unauthorized', async (_case, env) => {
    at(NOW);
    const { token } = await new JoseAccessTokenIssuer(store, fakeConfig(env)).issue(subject);

    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('reports a wrong audience as unauthorized even when the token is also expired', async () => {
    at(NOW);
    const { token } = await new JoseAccessTokenIssuer(
      store,
      fakeConfig({ API_PUBLIC_URL: ISSUER, JWT_AUDIENCE: 'other-api' }),
    ).issue(subject);
    at(new Date(NOW.getTime() + 3_600_000));

    await expect(verifier.verify(token)).rejects.toBeInstanceOf(Unauthenticated);
  });

  it('rejects an unknown kid, and a known kid signed by another key', async () => {
    at(NOW);
    const unknownKid = await new JoseAccessTokenIssuer(
      await FileKeyStore.load({ dir: dirs[1] ?? '', activeKid: 'ed25519-2026-11' }),
      config,
    ).issue(subject);
    const sameKidOtherKey = await new JoseAccessTokenIssuer(otherStore, config).issue(subject);

    await expect(verifier.verify(unknownKid.token)).rejects.toBeInstanceOf(Unauthenticated);
    await expect(verifier.verify(sameKidOtherKey.token)).rejects.toBeInstanceOf(Unauthenticated);
  });

  it('rejects an expired token signed by a foreign key as unauthorized, not token_expired', async () => {
    at(NOW);
    const { token } = await new JoseAccessTokenIssuer(otherStore, config).issue(subject);
    at(new Date(NOW.getTime() + 3_600_000));

    await expect(verifier.verify(token)).rejects.toMatchObject({ code: 'unauthorized' });
  });

  it('rejects tampering, alg=none, missing claims and garbage', async () => {
    at(NOW);
    const { token } = await issuer.issue(subject);
    const [header, , signature] = token.split('.');
    const forgedPayload = Buffer.from(
      JSON.stringify({ ...decodeJwt(token), roles: ['STUDENT', 'ADMIN'] }),
    ).toString('base64url');
    const unsigned = new UnsecuredJWT({ sid: subject.sessionId, app: 'admin', roles: ['ADMIN'] })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(subject.userId)
      .setIssuedAt()
      .setExpirationTime('15m')
      .encode();
    const noSid = await new SignJWT({ app: 'student', roles: ['STUDENT'] })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'ed25519-2026-10' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(subject.userId)
      .setIssuedAt()
      .setExpirationTime('15m')
      .setJti('0199d0a0-0000-7000-8000-0000000000bb')
      .sign(store.signingKey().key);
    const badRole = await new SignJWT({ sid: subject.sessionId, app: 'student', roles: ['ROOT'] })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'ed25519-2026-10' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject(subject.userId)
      .setIssuedAt()
      .setExpirationTime('15m')
      .setJti('0199d0a0-0000-7000-8000-0000000000cc')
      .sign(store.signingKey().key);

    for (const bad of [
      `${header}.${forgedPayload}.${signature}`,
      unsigned,
      noSid,
      badRole,
      'a.b.c',
      '',
      'x'.repeat(5000),
    ]) {
      await expect(verifier.verify(bad)).rejects.toBeInstanceOf(Unauthenticated);
    }
  });
});

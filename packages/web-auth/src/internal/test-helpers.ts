/**
 * Test-only helpers (imported from *.spec.ts only): a locally generated Ed25519 key pair, a
 * JWKS served through a mocked `fetch`, token minting and a tiny fetch router for the API.
 */
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWK } from 'jose';
import { vi } from 'vitest';
import { defineWebAuthConfig, type WebAuthConfig, type WebAuthConfigInput } from '../config';

export const API = 'http://api.internal:4000';
export const ORIGIN = 'https://student.example.test';
export const ISSUER = 'http://localhost:4000';
export const AUDIENCE = 'udemy-api';
export const JWKS_URL = `${API}/.well-known/jwks.json`;
export const KID = 'ed25519-test';
export const USER_ID = '0192f0c4-7d6a-7b3e-8f00-000000000001';
export const SESSION_ID = '0192f0c4-7d6a-7b3e-8f00-000000000002';

export function testConfig(overrides: Partial<WebAuthConfigInput> = {}): WebAuthConfig {
  return defineWebAuthConfig({
    app: 'student',
    requiredRole: 'STUDENT',
    clientId: 'student-bff',
    clientSecret: 'secret',
    apiInternalUrl: API,
    appOrigin: ORIGIN,
    jwtIssuer: ISSUER,
    jwtAudience: AUDIENCE,
    jwksUrl: JWKS_URL,
    cookieSecure: true,
    sameSite: 'lax',
    publicPaths: ['/', '/courses/*'],
    forbiddenRedirect: '/not-allowed',
    ...overrides,
  });
}

let keys: Promise<{ privateKey: CryptoKey; jwk: JWK }> | undefined;

export function testKeys() {
  keys ??= (async () => {
    const { privateKey, publicKey } = await generateKeyPair('EdDSA', {
      crv: 'Ed25519',
      extractable: true,
    });
    const jwk = { ...(await exportJWK(publicKey)), kid: KID, use: 'sig', alg: 'EdDSA' };
    return { privateKey, jwk };
  })();
  return keys;
}

export interface MintOptions {
  app?: string;
  roles?: string[];
  /** Seconds from now until expiry (negative: already expired). */
  expiresIn?: number;
  issuer?: string;
}

export async function mintAccessToken(options: MintOptions = {}): Promise<string> {
  const { privateKey } = await testKeys();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + (options.expiresIn ?? 900);
  return new SignJWT({
    sid: SESSION_ID,
    app: options.app ?? 'student',
    roles: options.roles ?? ['STUDENT'],
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: KID })
    .setSubject(USER_ID)
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(Math.min(now, exp - 60))
    .setExpirationTime(exp)
    .setJti(crypto.randomUUID())
    .sign(privateKey);
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

export function problem(status: number, code: string): Response {
  return new Response(JSON.stringify({ type: 'about:blank', title: 'x', status, code }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });
}

export function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

export type ApiRoute = (request: Request) => Response | Promise<Response>;

/**
 * Stubs global `fetch`: the JWKS URL is always served; `routes` maps "METHOD /api/v1/path" to
 * a handler. Every API call (not JWKS) is recorded in `calls`.
 */
export async function stubApi(routes: Record<string, ApiRoute>) {
  const { jwk } = await testKeys();
  const calls: Request[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.href === JWKS_URL) return json({ keys: [jwk] });
    calls.push(request.clone());
    const route = routes[`${request.method} ${url.pathname}`];
    if (!route) return problem(404, 'not_found');
    return route(request);
  });
  vi.stubGlobal('fetch', fetchMock);
  return {
    calls,
    fetchMock,
    callsTo: (method: string, path: string) =>
      calls.filter((c) => c.method === method && new URL(c.url).pathname === path),
  };
}

export function cookieHeader(cookies: Record<string, string | undefined>): string {
  return Object.entries(cookies)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

/** Parses Set-Cookie headers into name → { value, attributes }. */
export function parseSetCookies(headers: Headers) {
  const out = new Map<string, { value: string; attrs: Map<string, string | true> }>();
  for (const line of headers.getSetCookie()) {
    const [pair, ...rest] = line.split(';').map((p) => p.trim());
    const eq = pair!.indexOf('=');
    const attrs = new Map<string, string | true>();
    for (const attr of rest) {
      const i = attr.indexOf('=');
      if (i === -1) attrs.set(attr.toLowerCase(), true);
      else attrs.set(attr.slice(0, i).toLowerCase(), attr.slice(i + 1));
    }
    out.set(pair!.slice(0, eq), { value: pair!.slice(eq + 1), attrs });
  }
  return out;
}

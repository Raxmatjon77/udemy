import 'server-only';
import { ClientAppSchema, RoleSchema } from '@udemy/contracts';
import { z } from 'zod';
import { isSafeNextPath } from './safe-next';

/**
 * Per-app configuration of the BFF auth layer (design §10). Each Next app builds one from its
 * server-only env (`API_INTERNAL_URL`, `API_CLIENT_ID`, ...) and passes it to the factories.
 *
 * The factories accept either a config (validated immediately, so a misconfigured app fails at
 * boot) or a thunk `() => config` (a `WebAuthConfigSource`), which is called, validated and
 * cached on first use. The thunk form lets `next build` import route modules and `proxy.ts`
 * without any of the server secrets.
 */

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, '');

const httpUrl = z.url({ protocol: /^https?$/ }).transform(stripTrailingSlash);

/** An app path: starts with exactly one `/` (same rules as the `next` param). */
const appPath = z
  .string()
  .refine(isSafeNextPath, { message: 'Must be a relative path like /login' });

const booleanLike = z.union([
  z.boolean(),
  z.enum(['true', 'false']).transform((value) => value === 'true'),
]);

/** Optional override for how the end-user IP is read from the incoming request. */
export type ClientIpResolver = (request: Request) => string | undefined;

export const WebAuthConfigSchema = z
  .object({
    /** The client app this BFF is (`student`, `instructor`, `admin`): the token `app` claim. */
    app: ClientAppSchema,
    /** Cookie base name; cookies are `[__Host-]{cookiePrefix}-rt` / `-at`. Defaults to `udemy-{app}`. */
    cookiePrefix: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]*$/, 'Lowercase letters, digits and dashes only')
      .optional(),
    /** Role a principal needs on protected pages of this app (D6). */
    requiredRole: RoleSchema,
    /** `API_CLIENT_ID`, e.g. `student-bff`. */
    clientId: z.string().min(1),
    /** `API_CLIENT_SECRET`. */
    clientSecret: z.string().min(1),
    /** `API_INTERNAL_URL`, without `/api/v1` (this package adds it). */
    apiInternalUrl: httpUrl.refine((url) => !/\/api\/v1$/.test(url), {
      message: 'API_INTERNAL_URL must not end with /api/v1; the BFF adds the prefix',
    }),
    /** `APP_ORIGIN`: this app's public origin (scheme://host[:port]); unsafe requests must carry it. */
    appOrigin: httpUrl.refine((url) => new URL(url).origin === url, {
      message: 'APP_ORIGIN must be an origin only (scheme://host[:port], no path)',
    }),
    /**
     * `MEDIA_PUBLIC_ORIGIN`: origin of the media storage the browser talks to directly (HLS
     * segments, images, downloads, upload part PUTs). Added to the CSP (`img-src`, `media-src`,
     * `connect-src`) and the only redirect target `createSignedRedirectHandler` accepts.
     */
    mediaOrigin: httpUrl
      .refine((url) => new URL(url).origin === url, {
        message: 'MEDIA_PUBLIC_ORIGIN must be an origin only (scheme://host[:port], no path)',
      })
      .optional(),
    /**
     * `REALTIME_PUBLIC_URL`: http(s) origin of the API's socket.io endpoint (Phase 5 D15). Added to
     * the CSP `connect-src` as its `ws:`/`wss:` origin. Unset: no WebSocket origin is allowed and
     * the realtime hints fall back to polling.
     */
    realtimeOrigin: httpUrl
      .refine((url) => new URL(url).origin === url, {
        message: 'REALTIME_PUBLIC_URL must be an origin only (scheme://host[:port], no path)',
      })
      .optional(),
    /**
     * Send a nonce-based Content-Security-Policy on every page `createAuthProxy` handles
     * (see ./csp.ts). On by default; `false` only to debug a CSP problem locally.
     */
    contentSecurityPolicy: z.boolean().default(true),
    /** `JWT_ISSUER` (the API's `API_PUBLIC_URL`). */
    jwtIssuer: z.string().min(1),
    /** `JWT_AUDIENCE` (`udemy-api`). */
    jwtAudience: z.string().min(1),
    /** `JWKS_URL`. */
    jwksUrl: httpUrl,
    /** `COOKIE_SECURE`. `false` drops `__Host-` and `Secure`; refused in production. */
    cookieSecure: booleanLike,
    /** `lax` for student/instructor, `strict` for admin (design §9). */
    sameSite: z.enum(['lax', 'strict']),
    /**
     * Pages that render without a session. An entry matches exactly, or, when it ends in
     * `/*`, the base path and everything below it (`/courses/*`). Every other page matched by
     * proxy.ts requires a session. Login/signup/forgot-password, /verify-email and
     * /reset-password are always public and need not be listed.
     */
    publicPaths: z.array(z.string().regex(/^\/[^\s]*$/, 'Must start with /')).default([]),
    /** Login page; protected pages redirect here with `?next=`. */
    loginPath: appPath.default('/login'),
    /** Where a signed-in user landing on login/signup/forgot-password is sent. */
    homePath: appPath.default('/'),
    /**
     * Where a signed-in user without `requiredRole` is sent (instructor: `/not-instructor`).
     * This path itself is never role-gated (no loops). Defaults to `{loginPath}?error=forbidden`,
     * which suits apps where every principal holds `requiredRole` (student) or the login page
     * explains the refusal (admin).
     */
    forbiddenRedirect: appPath.optional(),
    /** Upstream API timeout per request. */
    apiTimeoutMs: z.number().int().positive().max(120_000).default(10_000),
    /** Max request body the API proxy forwards (JSON only; uploads go direct to MinIO). */
    maxProxyBodyBytes: z
      .number()
      .int()
      .positive()
      .default(1024 * 1024),
    /** Override the end-user IP resolution (default: `x-real-ip`, else last `x-forwarded-for` hop). */
    resolveClientIp: z.custom<ClientIpResolver>((value) => typeof value === 'function').optional(),
  })
  .transform((config) => ({
    ...config,
    cookiePrefix: config.cookiePrefix ?? `udemy-${config.app}`,
    forbiddenRedirect: config.forbiddenRedirect ?? `${config.loginPath}?error=forbidden`,
  }))
  .superRefine((config, ctx) => {
    if (!config.cookieSecure && process.env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['cookieSecure'],
        message:
          'COOKIE_SECURE=false is a dev-only setting and is refused when NODE_ENV=production',
      });
    }
  });

export type WebAuthConfigInput = z.input<typeof WebAuthConfigSchema>;
export type WebAuthConfig = Readonly<z.output<typeof WebAuthConfigSchema>> & {
  readonly [VALIDATED]: true;
};

const VALIDATED = Symbol.for('@udemy/web-auth/config');

/** Validates and freezes a config. Throws a readable error when it is invalid. */
export function defineWebAuthConfig(input: WebAuthConfigInput | WebAuthConfig): WebAuthConfig {
  if (isValidated(input)) return input;
  const parsed = WebAuthConfigSchema.safeParse(input);
  if (!parsed.success) {
    throw new Error(`Invalid @udemy/web-auth config:\n${z.prettifyError(parsed.error)}`);
  }
  return Object.freeze({ ...parsed.data, [VALIDATED]: true as const });
}

function isValidated(input: unknown): input is WebAuthConfig {
  return typeof input === 'object' && input !== null && VALIDATED in input;
}

/**
 * What the factories accept: a config (raw or already validated), or a thunk returning one.
 * A thunk is called on first use (the first request), not at import time.
 */
export type WebAuthConfigSource =
  WebAuthConfigInput | WebAuthConfig | (() => WebAuthConfigInput | WebAuthConfig);

/**
 * Turns a `WebAuthConfigSource` into a memoised getter of the validated config.
 *
 * - A plain config is validated NOW (the factories keep failing at boot for a bad literal).
 * - A thunk is called and validated on the first `get()` and cached. If it throws (missing env,
 *   invalid value), nothing is cached: the error surfaces on that request and the next request
 *   tries again.
 */
export function lazyWebAuthConfig(source: WebAuthConfigSource): () => WebAuthConfig {
  if (typeof source !== 'function') {
    const config = defineWebAuthConfig(source);
    return () => config;
  }
  let cached: WebAuthConfig | undefined;
  return () => (cached ??= defineWebAuthConfig(source()));
}

/**
 * Like `lazyWebAuthConfig`, plus values derived from the config (cookie names, path sets, ...),
 * computed once together with it.
 */
export function lazyWithConfig<T>(
  source: WebAuthConfigSource,
  derive: (config: WebAuthConfig) => T,
): () => T {
  const getConfig = lazyWebAuthConfig(source);
  if (typeof source !== 'function') {
    const value = derive(getConfig());
    return () => value;
  }
  let cached: { value: T } | undefined;
  return () => (cached ??= { value: derive(getConfig()) }).value;
}

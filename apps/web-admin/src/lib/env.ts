import 'server-only';
import { z } from 'zod';

/**
 * Server-only environment of this BFF (design §10). Nothing here is NEXT_PUBLIC_*: the browser
 * never talks to the API directly.
 *
 * Read lazily (on first use, at request time) rather than at module load, so `next build` works
 * without the secrets (CI, Docker image builds) and a misconfigured server still fails on its
 * first request with a readable error. URL shapes are validated by `@udemy/web-auth`'s config.
 */
const EnvSchema = z.object({
  API_INTERNAL_URL: z.string().min(1),
  API_CLIENT_ID: z.string().min(1),
  API_CLIENT_SECRET: z.string().min(1),
  APP_ORIGIN: z.string().min(1),
  JWT_ISSUER: z.string().min(1),
  JWT_AUDIENCE: z.string().min(1),
  JWKS_URL: z.string().min(1),
  COOKIE_SECURE: z.enum(['true', 'false']),
  /**
   * Origin of the media storage the browser reaches directly (HLS segments, images, downloads,
   * upload parts). Used verbatim in the CSP and as the only allowed signed-redirect target, so
   * it must be exactly `scheme://host[:port]` (no path, no trailing slash).
   */
  MEDIA_PUBLIC_ORIGIN: z
    .url({ protocol: /^https?$/ })
    .refine((url) => new URL(url).origin === url, {
      message: 'Must be an origin only: scheme://host[:port], no path or trailing slash',
    }),
});

export type ServerEnv = z.infer<typeof EnvSchema>;

let cached: ServerEnv | undefined;

export function serverEnv(): ServerEnv {
  if (cached) return cached;
  const parsed = EnvSchema.safeParse({
    API_INTERNAL_URL: process.env.API_INTERNAL_URL,
    API_CLIENT_ID: process.env.API_CLIENT_ID,
    API_CLIENT_SECRET: process.env.API_CLIENT_SECRET,
    APP_ORIGIN: process.env.APP_ORIGIN,
    JWT_ISSUER: process.env.JWT_ISSUER,
    JWT_AUDIENCE: process.env.JWT_AUDIENCE,
    JWKS_URL: process.env.JWKS_URL,
    COOKIE_SECURE: process.env.COOKIE_SECURE,
    MEDIA_PUBLIC_ORIGIN: process.env.MEDIA_PUBLIC_ORIGIN,
  });
  if (!parsed.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
  }
  cached = parsed.data;
  return cached;
}

const OriginSchema = z
  .url({ protocol: /^https?$/ })
  .refine((url) => new URL(url).origin === url, { message: 'Must be an origin only' });

/**
 * Public origin of the student site (`STUDENT_APP_ORIGIN`, e.g. `http://localhost:3000`), used
 * only to link live courses to their public page. Optional: without it, no links are shown.
 */
export function studentAppOrigin(): string | null {
  const parsed = OriginSchema.safeParse(process.env.STUDENT_APP_ORIGIN);
  return parsed.success ? parsed.data : null;
}

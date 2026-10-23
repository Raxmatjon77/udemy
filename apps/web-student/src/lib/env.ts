import 'server-only';
import { z } from 'zod';

/** `scheme://host[:port]` exactly (zod runs refinements even after a failed format check). */
function isExactOrigin(value: string): boolean {
  try {
    return new URL(value).origin === value;
  } catch {
    return false;
  }
}

/**
 * `REALTIME_PUBLIC_URL`: origin of the API's socket.io endpoint (Phase 5 D15), the same value as
 * the API's. Added to the CSP connect-src as its ws:/wss: origin. Optional: unset (or empty)
 * means no WebSocket origin in the CSP, and the realtime hints fall back to polling.
 */
export const RealtimePublicUrlSchema = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z
    .url({ protocol: /^https?$/ })
    .refine((url) => URL.canParse(url) && new URL(url).origin === url, {
      message: 'Must be an origin only: scheme://host[:port], no path or trailing slash',
    })
    .optional(),
);

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
  MEDIA_PUBLIC_ORIGIN: z.url({ protocol: /^https?$/ }).refine(isExactOrigin, {
    message: 'Must be an origin only: scheme://host[:port], no path or trailing slash',
  }),
  /** `REALTIME_PUBLIC_URL` (Phase 5 D15): see `RealtimePublicUrlSchema`. */
  REALTIME_PUBLIC_URL: RealtimePublicUrlSchema,
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
    REALTIME_PUBLIC_URL: process.env.REALTIME_PUBLIC_URL,
  });
  if (!parsed.success) {
    throw new Error(`Invalid environment variables:\n${z.prettifyError(parsed.error)}`);
  }
  cached = parsed.data;
  return cached;
}

/**
 * `CHECKOUT_ALLOWED_ORIGINS` (Phase 4 §10): the comma-separated origins the checkout redirect may
 * go to. Before `location.assign(checkoutUrl)` the cart checks the URL's origin against this
 * list, so a tampered API response cannot send the buyer to a look-alike payment page.
 *
 * Validated on its own (not in `EnvSchema`): only the commerce pages need it, so a deployment
 * that has not configured it yet keeps serving every other page, and the pages that do need it
 * fail loudly on their first request. Each entry must be exactly `scheme://host[:port]`.
 */
export const CheckoutAllowedOriginsSchema = z
  .string({ error: 'CHECKOUT_ALLOWED_ORIGINS is required' })
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry !== ''),
  )
  .pipe(
    z
      .array(
        z.url({ protocol: /^https?$/ }).refine(isExactOrigin, {
          message: 'Each origin must be scheme://host[:port], no path or trailing slash',
        }),
      )
      .min(1, 'List at least one origin'),
  );

let cachedCheckoutOrigins: readonly string[] | undefined;

export function checkoutAllowedOrigins(): readonly string[] {
  if (cachedCheckoutOrigins) return cachedCheckoutOrigins;
  const parsed = CheckoutAllowedOriginsSchema.safeParse(process.env.CHECKOUT_ALLOWED_ORIGINS);
  if (!parsed.success) {
    throw new Error(
      `Invalid environment variable CHECKOUT_ALLOWED_ORIGINS:\n${z.prettifyError(parsed.error)}`,
    );
  }
  cachedCheckoutOrigins = Object.freeze(parsed.data);
  return cachedCheckoutOrigins;
}

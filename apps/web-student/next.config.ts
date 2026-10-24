import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * Baseline security headers for every route. The Content-Security-Policy is not here: it carries
 * a per-request nonce, so `createAuthProxy` (src/proxy.ts, @udemy/web-auth/csp) sets it on every
 * page response.
 */
const securityHeaders = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), browsing-topics=()',
  },
  { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' },
];

// Email links carry tokens (`/unsubscribe#token=`); a certificate page's URL is the credential
// (Phase 5 §9: `Referrer-Policy: no-referrer` on the verification page).
const NO_REFERRER_PATHS = [
  '/verify-email',
  '/reset-password',
  '/unsubscribe',
  '/certificates/:code',
];
const noReferrer = [{ key: 'Referrer-Policy', value: 'no-referrer' }];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Self-contained server bundle (.next/standalone) for the Docker/K8s images.
  output: 'standalone',
  // Trace files from the monorepo root so workspace packages end up in the standalone output.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  // @udemy/ui, @udemy/web-auth, @udemy/web-realtime and @udemy/markdown/react ship TypeScript
  // source; let Next compile them.
  transpilePackages: ['@udemy/ui', '@udemy/web-auth', '@udemy/markdown', '@udemy/web-realtime'],
  async headers() {
    return [
      { source: '/:path*', headers: securityHeaders },
      // Email links carry a one-time token in the fragment: never leak even the page URL in a
      // Referer (design §9). Listed AFTER the catch-all on purpose: for the same key, the last
      // matching entry wins.
      ...NO_REFERRER_PATHS.map((source) => ({ source, headers: noReferrer })),
    ];
  },
};

export default nextConfig;

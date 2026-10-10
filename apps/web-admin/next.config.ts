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

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // Self-contained server bundle (.next/standalone) for the Docker/K8s images.
  output: 'standalone',
  // Trace files from the monorepo root so workspace packages end up in the standalone output.
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  // @udemy/ui, @udemy/web-auth and @udemy/markdown/react ship TypeScript source; let Next compile them.
  transpilePackages: ['@udemy/ui', '@udemy/web-auth', '@udemy/markdown'],
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;

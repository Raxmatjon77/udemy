import type { NextRequest } from 'next/server';
import { createAuthProxy, type AuthProxy } from '@udemy/web-auth/proxy';

import { getWebAuthConfig } from '@/lib/auth/config';

/**
 * Session gate for pages (design §10): refreshes expiring sessions inline and redirects
 * signed-out users to `/login?next=`. A UX gate only; the API is the authority.
 * Created on the first request so the build never needs the server secrets.
 */
let authProxy: AuthProxy | undefined;

export function proxy(request: NextRequest) {
  authProxy ??= createAuthProxy(getWebAuthConfig());
  return authProxy(request);
}

export const config = {
  // Must be a literal (Next analyses it statically). Equal to RECOMMENDED_PROXY_MATCHER from
  // @udemy/web-auth/proxy; src/proxy.spec.ts fails if the two drift apart.
  matcher: [
    '/((?!api/|_next/|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|txt|woff2?)$).*)',
  ],
};

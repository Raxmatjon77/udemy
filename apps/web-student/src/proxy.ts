import { createAuthProxy } from '@udemy/web-auth/proxy';

import { webAuthConfig } from '@/lib/auth/config';

/**
 * Session gate for pages (design §10): refreshes expiring sessions inline and redirects
 * signed-out users to `/login?next=`. A UX gate only; the API is the authority.
 * The config thunk is resolved on the first request, so the build never needs the secrets.
 */
export const proxy = createAuthProxy(webAuthConfig);

export const config = {
  // Must be a literal (Next analyses it statically). Equal to RECOMMENDED_PROXY_MATCHER from
  // @udemy/web-auth/proxy; src/proxy.spec.ts fails if the two drift apart.
  matcher: [
    '/((?!api/|_next/|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$|.*\\.(?:png|jpe?g|gif|svg|webp|avif|ico|css|js|map|txt|woff2?)$).*)',
  ],
};

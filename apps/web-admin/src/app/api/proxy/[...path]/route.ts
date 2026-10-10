import { apiProxy } from '@/lib/auth/handlers';

/**
 * `/api/proxy/*` → `API_INTERNAL_URL/api/v1/*` with the session's access token (design §9).
 * Refresh tokens never pass through here: `auth/login|refresh|logout` are denied.
 */
function handler(request: Request): Promise<Response> {
  return apiProxy()(request);
}

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
